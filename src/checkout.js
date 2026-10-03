/**
 * A Bitcoin Cash checkout for your own website: payments go straight into
 * your own wallet (you give it an xPub, which can't spend), and your server
 * watches the blockchain itself. No payment company, account or fees.
 *
 *   start(order)   reserves the order's own address in your wallet and a BCH
 *                  price for its total (held `priceMinutes`)
 *   view(id)       what the payment screen shows: amount, address, a
 *                  bitcoincash: link for the QR code and "open in wallet",
 *                  the countdown, the coupon offer, the order in BCH
 *   check(id)      reads the address from the blockchain and moves the
 *                  payment on (called for you when the network says the
 *                  address changed, and by tick())
 *   renew(id)      a new price once one ran out with nothing sent
 *   close(id)      the order is gone (abandoned, sold out): the address goes
 *                  back to the pool after `reuseDays`
 *   tick()         run every minute: catches anything a notice missed, late
 *                  payments, double-spends before the first block, rewards
 *                  waiting to be sent
 *
 * Connect wallet (BCH WalletConnect, docs/wallet-connect.md):
 *   walletInfo(id, address)   what the shopper's wallet holds that the order can use
 *   walletQuote(id, { category, amount })   the price with that many tokens taken off
 *   walletBuild(id, { address, category, amount })   one unsigned transaction with the BCH
 *                  and the tokens, for the wallet to sign
 *   walletSubmit(id, hex)     the signed transaction: checked against what was built, and sent
 *
 * Rewards (docs/rewards.md): claimReward(id, address), rewardsStatus(), testReward().
 *
 * Zero-conf, as the BCH community expects: when enough has arrived it
 * listens `proofWaitMs` for a double-spend proof (the DSProof spec's
 * "wait T seconds"), then the payment counts (onPaid). With a proof, it's
 * held until a block settles it. See docs/zero-conf.md.
 *
 * CashTokens coupons: tokens you mint and give out. A shopper sends one to
 * the order's address (its token-aware z… form) before paying, or spends it
 * in the same transaction from a connected wallet; the discount comes off and
 * a new price is given. BCH-valued tokens (each worth, say, 0.01 BCH off) add
 * up. See docs/coupons.md.
 */
import {
  addressAt,
  BchError,
  bchExplorerUrl,
  bchText,
  buildWalletPayment,
  createBchChain,
  createBchPrices,
  parseXpub,
  paymentUri,
  readPayment,
  readSignedPayment,
  satsFor,
  walletAddress,
  walletHoldings,
} from "./bch.js";
import { createReceiptsEngine } from "./receipts.js";
import { connectedPayer, createRewardsEngine } from "./rewards.js";
import { couponDiscount, satsPerToken, tokenScale, tokensFor, tokenText } from "./tokens.js";

export { BchError, parseXpub, addressAt } from "./bch.js";

const PAID = "paid";

export function createBchCheckout({
  xpub,
  store,
  chain = createBchChain(),
  prices = createBchPrices(),
  /** Your CashTokens coupons, or a (synchronous) function returning them (checkCoupons in src/tokens.js checks a list). */
  coupons = [],
  /** Rewards in your own token after a payment: { wallet: createHotWallet(…), settings: { enabled, category, perBch, tokens, … } or a function }. */
  rewards = null,
  /** Receipts as CashTokens: createReceiptIssuer(…) (docs/receipts.md). */
  receipts = null,
  /** (payment) => fulfil the order. Called once. */
  onPaid = () => {},
  /** (payment, { kind, message, problem }) => things the merchant should know (problem: true means look before shipping). */
  onNotice = () => {},
  /**
   * async (payment, coupon, discountCents) => the order's new total with that discount: { totalCents, taxCents }
   * (or just the total in cents). Without it, the sales tax is lowered in proportion to the discount.
   */
  onCoupon = null,
  priceMinutes = 30,
  maxPrices = 4,
  proofWaitMs = 3000,
  tolerance = 0.002,
  reuseDays = 7,
  /** The least ever asked, in satoshis (a payment below the network's dust limit can't be sent). */
  minSats = 1000,
  now = () => Date.now(),
} = {}) {
  if (!store) throw new Error("createBchCheckout needs a store (see memory-store.js).");
  const wallet = parseXpub(xpub);
  const couponList = () => {
    const list = typeof coupons === "function" ? coupons() : coupons;
    return Array.isArray(list) ? list : [];
  };
  const iso = (ms = now()) => new Date(ms).toISOString();
  const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

  // One look at an order's address at a time (a notice, the payment screen and tick() can all ask at once).
  const locks = new Map();
  function exclusive(id, fn) {
    const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(id, tail);
    tail.then(() => locks.get(id) === tail && locks.delete(id));
    return run;
  }

  async function mustGet(id) {
    const p = await store.getPayment(id);
    if (!p) throw new BchError(`No Bitcoin Cash payment for order ${id}.`, { status: 404 });
    return p;
  }
  /** Changes a payment under its lock. */
  const update = (id, fn) =>
    exclusive(id, async () => {
      const p = await mustGet(id);
      await fn(p);
      await store.putPayment(p);
      return p;
    });

  function notice(p, kind, message, { problem = false } = {}) {
    p.events = [...(p.events ?? []), { at: iso(), kind, message }];
    if (problem && !(p.problems ?? []).some((x) => x.kind === kind && x.message === message)) p.problems = [...(p.problems ?? []), { kind, message, at: iso() }];
    Promise.resolve(onNotice(p, { kind, message, problem })).catch(() => {});
  }
  const clearProblem = (p, kind) => (p.problems = (p.problems ?? []).filter((x) => x.kind !== kind));
  const hasProblem = (p, kind) => (p.problems ?? []).some((x) => x.kind === kind);

  const engine = rewards ? createRewardsEngine({ wallet: rewards.wallet, settings: rewards.settings ?? {}, chain, store, update, notice, now }) : null;
  const receiptsEngine = receipts ? createReceiptsEngine({ issuer: receipts, chain, store, update, notice, connectedPayer, earned: engine ? (p) => engine.estimate(p) : null, now }) : null;

  // --- Addresses ---------------------------------------------------------------------

  /** One that has never received anything, and that no other order showed in the last `reuseDays`. */
  async function reserveAddress(orderId) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const free = await store.claimFreeAddress(wallet.id, orderId, iso(now() - reuseDays * 86_400_000), iso());
      const row = free ?? (await store.claimNewAddress(wallet.id, orderId, iso(), (i) => addressAt(wallet, i)));
      const a = addressAt(wallet, row.index);
      let history;
      try {
        history = await chain.history(a.scripthash);
      } catch (e) {
        // Not shown to anyone: free to use straight away.
        await store.setAddress(wallet.id, row.index, { state: "free", orderId: free?.previous?.orderId ?? null, releasedAt: free?.previous?.releasedAt ?? null });
        throw e;
      }
      if (!history.length) return a;
      // Used already: by the wallet itself, or a late payment for the order that had it before.
      await store.setAddress(wallet.id, row.index, { state: "used", orderId: free?.previous?.orderId ?? null });
      if (free?.previous?.orderId) setImmediate(() => check(free.previous.orderId).catch(() => {}));
    }
    throw new BchError("Couldn't find an unused address in the wallet.", { status: 503 });
  }

  // --- Prices --------------------------------------------------------------------------

  /** The lowest BCH amount quoted for the current total (a payment made just as a new price came in still counts). */
  function due(p) {
    const current = p.windows?.at(-1);
    if (!current) return null;
    return Math.min(...p.windows.filter((w) => w.cents === current.cents).map((w) => w.sats));
  }
  const covered = (p) => {
    const d = due(p);
    return Boolean(d && p.receivedSats > 0 && p.receivedSats >= Math.floor(d * (1 - tolerance)));
  };
  function unconfirmed(p) {
    const txids = Object.entries(p.txs ?? {}).filter(([, t]) => t.sats > 0 && !(t.height > 0)).map(([txid]) => txid);
    const firstSeen = txids.length ? Math.min(...txids.map((t) => Date.parse(p.txs[t].seenAt))) : null;
    return { txids, age: firstSeen === null ? Infinity : now() - firstSeen };
  }
  // Every price a coupon gave adds one to how many the order can have (a coupon's new price isn't a renewal).
  const windowLimit = (p) => maxPrices + (p.couponWindows ?? (p.coupon ? 1 : 0));

  /** A new price for the order's total. `held`: keep the current one's rate and end time (tokens taken off during it), optionally with the exact amount. */
  async function newPrice(p, held = null) {
    const price = held ? { usd: held.usdPerBch, sources: held.sources } : await prices.usdPerBch();
    const sats = held?.sats ?? Math.max(minSats, satsFor(p.totalCents, price.usd));
    const w = { n: (p.windows?.length ?? 0) + 1, cents: p.totalCents, usdPerBch: price.usd, sources: price.sources, sats, startedAt: iso(), expiresAt: held?.expiresAt ?? iso(now() + priceMinutes * 60_000) };
    p.windows = [...(p.windows ?? []), w];
    notice(
      p,
      "price",
      held
        ? `Price now ${bchText(w.sats)} BCH for ${usd(p.totalCents)}, at the same $${price.usd.toFixed(2)} per BCH and held to the same time.`
        : `${w.n > 1 ? "New price" : "Price"}: ${bchText(w.sats)} BCH for ${usd(p.totalCents)} at $${price.usd.toFixed(2)} per BCH (${price.sources.join(", ")}), held ${priceMinutes} minutes.`,
    );
    return w;
  }

  // --- States --------------------------------------------------------------------------

  /**
   * waiting · partial · arrived (paid; listening for a double-spend proof) · paid ·
   * checking (a double-spend proof was seen: held for a block) · expired · expired_partial
   */
  function state(p) {
    if (p.status === PAID) return "paid";
    if (covered(p)) return p.held ? "checking" : unconfirmed(p).age < proofWaitMs ? "arrived" : "paid";
    const current = p.windows?.at(-1);
    const ended = p.status !== "awaiting" || !current || Date.parse(current.expiresAt) + 60_000 < now();
    if (p.receivedSats > 0) return ended ? "expired_partial" : "partial";
    return ended ? "expired" : "waiting";
  }

  // --- The flow ------------------------------------------------------------------------

  /**
   * A new order's payment, with the amounts from your database (never from the browser):
   * subtotalCents: the items (what coupons take a share of) · shippingCents · taxCents (lowered when a
   * coupon comes off, see onCoupon) · otherCents: anything else, or shipping and tax together.
   * itemCount and shippingLabel only label the order's lines in BCH. number (an integer), items ([{ title, option, qty, unitCents }])
   * and receipt ("email" | "token" | "both", the shopper's choice) are for receipts as CashTokens. Returns the view.
   */
  async function start({ id, label = null, subtotalCents, shippingCents = 0, taxCents = 0, otherCents = 0, itemCount = null, shippingLabel = null, number = null, items = null, receipt = "email" }) {
    const total = subtotalCents + shippingCents + taxCents + otherCents;
    if (!id || !(subtotalCents >= 0) || ![shippingCents, taxCents, otherCents].every((c) => Number.isInteger(c) && c >= 0) || !(total > 0)) throw new BchError("start() needs an id and a total above zero.");
    if (await store.getPayment(id)) throw new BchError(`Order ${id} already has a Bitcoin Cash payment.`, { status: 409 });
    const a = await reserveAddress(id);
    const p = {
      id, label, status: "awaiting", createdAt: iso(), subtotalCents, shippingCents, taxCents, otherCents, totalCents: total, discountCents: 0, coupon: null, itemCount, shippingLabel,
      number: Number.isInteger(number) ? number : null, items: Array.isArray(items) ? items.slice(0, 100) : null, receiptPref: receiptsEngine && ["token", "both"].includes(receipt) ? receipt : "email",
      wallet: wallet.id, index: a.index, address: a.address, tokenAddress: a.tokenAddress, lockingBytecode: a.lockingBytecode, scripthash: a.scripthash,
      windows: [], txs: {}, receivedSats: 0, confirmations: 0, problems: [], events: [],
    };
    try {
      await newPrice(p);
    } catch (e) {
      await store.releaseAddress(id, null);
      throw e;
    }
    await store.putPayment(p);
    chain.watch(a.scripthash);
    return view(p);
  }

  /** Reads the order's address from the blockchain and moves the payment on. Returns the view. */
  function check(id) {
    return exclusive(id, async () => {
      const p = await mustGet(id);
      const [history, tip] = await Promise.all([chain.history(p.scripthash), chain.tip()]);
      const txs = {};
      for (const hx of history) {
        const pay = readPayment(await chain.transaction(hx.txid), p.lockingBytecode);
        txs[hx.txid] = { height: hx.height > 0 ? hx.height : 0, sats: pay.sats, tokens: pay.tokens, covered: pay.covered, seenAt: p.txs?.[hx.txid]?.seenAt ?? iso() };
      }
      // Seen before, now gone without a block: replaced (double-spent) or dropped by the network.
      const gone = Object.keys(p.txs ?? {}).filter((t) => !txs[t] && !(p.txs[t].height > 0));
      const paying = Object.values(txs).filter((t) => t.sats > 0);
      Object.assign(p, { txs, receivedSats: paying.reduce((n, t) => n + t.sats, 0), confirmations: paying.length ? Math.min(...paying.map((t) => (t.height > 0 ? tip - t.height + 1 : 0))) : 0, checkedAt: iso() });
      await onChange(p, gone);
      await store.putPayment(p);
      return view(p);
    });
  }

  async function onChange(p, gone) {
    await applyCoupons(p);

    if (p.status === PAID) {
      if (gone.some((t) => (p.payTxs ?? []).includes(t)) && !covered(p) && !hasProblem(p, "dropped"))
        notice(p, "dropped", "The payment disappeared from the network before a block confirmed it (it may have been spent elsewhere). Don't ship until it's back.", { problem: true });
      const extra = p.receivedSats - (p.paidSats ?? 0);
      if (p.paidSats && extra > 546 && !hasProblem(p, "double")) notice(p, "double", `Another ${bchText(extra)} BCH arrived after the order was paid: send it back.`, { problem: true });
      if (p.confirmations >= 1 && !p.confirmedNoted) {
        p.confirmedNoted = true;
        clearProblem(p, "dropped");
        clearProblem(p, "unprotected");
        notice(p, "confirmed", "Confirmed in a block.");
        chain.unwatch(p.scripthash);
      }
      return;
    }

    if (covered(p)) {
      const { txids, age } = unconfirmed(p);
      if (txids.length && age < proofWaitMs) {
        setTimeout(() => check(p.id).catch(() => {}), proofWaitMs - age + 50).unref?.();
        return;
      }
      const proofs = await Promise.all(txids.map((t) => chain.dsproof(t)));
      if (proofs.some(Boolean)) {
        if (!p.held) {
          p.held = true;
          notice(p, "dropped", "The network has a double-spend proof for this payment: someone tried to spend the same coins elsewhere. Held until a block settles which one counts.", { problem: true });
        }
        return;
      }
      if (p.held) {
        p.held = false;
        clearProblem(p, "dropped");
        notice(p, "confirmed", "A block settled it: the payment counts.");
      }
      const late = p.status !== "awaiting";
      const d = due(p);
      Object.assign(p, { status: PAID, paidAt: iso(), paidSats: p.receivedSats, payTxs: Object.entries(p.txs).filter(([, t]) => t.sats > 0).map(([txid]) => txid) });
      await store.markAddressUsed(p.id);
      if (receiptsEngine) await receiptsEngine.prepare(p).catch(() => {});
      notice(p, "paid", `Paid ${bchText(p.receivedSats)} BCH${p.coupon?.kind === "bch" ? `, with ${tokenText(p.coupon.tokens, p.coupon)}` : ""}.`);
      if (p.receivedSats < d) notice(p, "short", `${bchText(d - p.receivedSats)} BCH short of the price, within the rounding allowance.`);
      if (p.receivedSats > d * 1.005) notice(p, "extra", `${bchText(p.receivedSats - d)} BCH more than asked arrived.`);
      if (late) notice(p, "late", "The payment arrived after the order was closed. Check the stock before shipping.", { problem: true });
      if (txids.length && proofs.some((x) => x === undefined)) notice(p, "proofs", "Double-spend proofs couldn't be checked when it arrived; it's watched until a block confirms it.");
      if (txids.some((t) => p.txs[t].covered === false))
        notice(p, "unprotected", "This payment came from a kind of wallet double-spend proofs don't cover (a script or multisig wallet). Wait for a block before shipping: this clears itself then.", { problem: true });
      await store.putPayment(p);
      Promise.resolve(onPaid(structuredClone(p))).catch(() => {});
      if (engine) setImmediate(() => engine.award(p.id).catch(() => {}));
      if (receiptsEngine && p.receipt?.to) setImmediate(() => receiptsEngine.sendPending(p.id).catch(() => {}));
      return;
    }

    const s = state(p);
    if (s === "partial" && !(p.events ?? []).some((e) => e.kind === "partial" && e.message.includes(bchText(p.receivedSats)))) notice(p, "partial", `Part of the payment arrived (${bchText(p.receivedSats)} of ${bchText(due(p))} BCH).`);
    if (s === "expired_partial" && !hasProblem(p, "partial"))
      notice(p, "partial", `Only part of the payment arrived (${bchText(p.receivedSats)} of ${bchText(due(p))} BCH) before the price ran out. Send it back, or contact the shopper.`, { problem: true });
  }

  // --- Coupons -------------------------------------------------------------------------

  // BCH that came in other transactions than this one (tokens sent together with the payment, in one transaction, still count).
  const paidBesides = (p, txid) => Object.entries(p.txs ?? {}).reduce((n, [t, x]) => n + (t === txid ? 0 : x.sats), 0);

  /**
   * How much BCH-valued tokens can still take off: what's left of the items. They're the shop's own coupons
   * (minted and given out by the shop, worth nothing elsewhere), so they're a discount, and the sales tax is
   * worked out on the lower price, as for any store coupon.
   */
  const tokenRoom = (p) => p.subtotalCents - p.discountCents;

  /** The order's new total and tax with `discount` off the items. */
  async function retotal(p, discount, coupon) {
    if (onCoupon) {
      const r = await onCoupon(structuredClone(p), coupon, discount);
      return typeof r === "number" ? { totalCents: r, taxCents: p.taxCents } : { totalCents: r.totalCents, taxCents: r.taxCents ?? p.taxCents };
    }
    const base = p.subtotalCents + p.shippingCents;
    const taxCents = p.taxCents ? Math.round((p.taxCents * (p.subtotalCents - discount + p.shippingCents)) / Math.max(1, base)) : 0;
    return { totalCents: p.subtotalCents - discount + p.shippingCents + taxCents + (p.otherCents ?? 0), taxCents };
  }

  /**
   * What a coupon (or BCH-valued tokens) would do to the order, without changing anything: the discount,
   * the new total, the price that follows, and the BCH asked then. A quote and the real thing both come
   * from here, so a wallet payment built from a quote matches what's worked out when it lands.
   */
  async function couponEffect(p, c, tok, prev = null) {
    const w = p.windows?.at(-1);
    const credit = c.kind === "bch";
    const rate = w?.usdPerBch ?? (await prices.usdPerBch()).usd;
    let discount;
    let coupon;
    let exact = null; // BCH taken off, when it comes straight off the price being held
    let over = 0n;
    let cents = 0;
    if (credit) {
      // Each token is worth a set amount of BCH: worked out in dollars at the price being held.
      const room = tokenRoom(p);
      const sats = Number((BigInt(tok.amount) * satsPerToken(c)) / tokenScale(c));
      cents = Math.round((sats / 1e8) * rate * 100);
      let used = BigInt(tok.amount);
      if (cents >= room) {
        cents = room;
        used = tokensFor(c, room, rate);
        if (used > BigInt(tok.amount)) used = BigInt(tok.amount);
        over = BigInt(tok.amount) - used;
      } else exact = sats;
      discount = p.discountCents + cents;
      coupon = {
        label: c.label, category: c.category, token: "ft", kind: "bch", value: c.value, decimals: c.decimals ?? 0, symbol: c.symbol ?? null,
        tokens: (BigInt(prev?.tokens ?? 0) + used).toString(), sats: (prev?.sats ?? 0) + Number((used * satsPerToken(c)) / tokenScale(c)), usdPerBch: rate,
        outputs: [...(prev?.outputs ?? []), { txid: tok.txid, vout: tok.vout, amount: tok.amount }], at: prev?.at ?? iso(),
      };
    } else {
      discount = couponDiscount(c, p.subtotalCents);
      coupon = { label: c.label, category: c.category, token: c.token, kind: c.kind, value: c.value, txid: tok.txid, vout: tok.vout, amount: tok.amount, nft: tok.nft ?? null, at: iso() };
    }
    const { totalCents, taxCents } = await retotal(p, discount, coupon);
    // Tokens during an open price: the same rate and end time and, when the total dropped by just their value, exactly their BCH off.
    const open = credit && w && Date.parse(w.expiresAt) > now();
    const held = open ? { usdPerBch: w.usdPerBch, sources: w.sources, expiresAt: w.expiresAt, sats: exact !== null && totalCents === p.totalCents - cents ? Math.max(minSats, w.sats - exact) : undefined } : null;
    const nextSats = held?.sats ?? Math.max(minSats, satsFor(totalCents, rate));
    return { credit, cents, discount, coupon, exact, over, totalCents, taxCents, held, nextSats };
  }

  async function applyCoupon(p, c, tok, prev = null) {
    const e = await couponEffect(p, c, tok, prev);
    if (e.over > 0n) notice(p, "coupon", `${tokenText(tok.amount, c)} “${c.label}” arrived; ${tokenText(BigInt(tok.amount) - e.over, c)} covered the items, so send the other ${tokenText(e.over, c)} back to the shopper.`, { problem: true });
    const before = p.discountCents;
    Object.assign(p, { discountCents: e.discount, taxCents: e.taxCents, totalCents: e.totalCents, coupon: e.coupon });
    notice(
      p,
      "coupon",
      e.credit
        ? `${tokenText(tok.amount, c)} “${c.label}” arrived (${c.value} BCH each): ${usd(e.discount - before)} off${prev ? `, ${usd(e.discount)} in all` : ""}. New total ${usd(e.totalCents)}.`
        : `Coupon “${c.label}” applied: ${usd(e.discount)} off. New total ${usd(e.totalCents)}.`,
    );
    p.couponWindows = (p.couponWindows ?? (prev ? 1 : 0)) + 1;
    await newPrice(p, e.held);
  }

  /** Tokens sent to the order's address: a valid coupon, before any BCH arrives, lowers the price. */
  async function applyCoupons(p) {
    const handled = new Set(p.couponOutputs ?? []);
    const fresh = [];
    for (const [txid, t] of Object.entries(p.txs ?? {})) for (const tok of t.tokens ?? []) if (!handled.has(`${txid}:${tok.vout}`)) fresh.push({ txid, ...tok });
    if (!fresh.length) return;
    // Recorded first, so a token is only ever counted once.
    p.couponOutputs = [...handled, ...fresh.map((t) => `${t.txid}:${t.vout}`)];
    const list = couponList();
    for (const tok of fresh) {
      const c = list.find((x) => x.category === tok.category);
      const credit = c?.kind === "bch";
      const valid = c && c.active !== false && (c.token === "nft" ? tok.nft && tok.nft.capability === "none" : !tok.nft && BigInt(tok.amount) >= BigInt(credit ? 1 : (c.units ?? 1)));
      const name = c?.label ?? `token ${tok.category.slice(0, 8)}…`;
      const sent = credit ? `${tokenText(tok.amount, c)} “${name}”` : `A coupon (“${name}”)`;
      if (!valid) {
        notice(p, "token", c ? `A “${name}” token arrived but can't be used as a coupon${c.active === false ? " (that coupon is switched off)" : tok.nft && tok.nft.capability !== "none" ? " (it's a minting or changeable NFT: send it back to yourself!)" : ""}. It's in your wallet.` : `A token that isn't one of your coupons arrived (${name}). It's in your wallet.`);
        continue;
      }
      const prev = p.coupon;
      // BCH-valued tokens add up: a shopper can send them all at once or a few at a time.
      const more = credit && prev?.kind === "bch" && prev.category === c.category;
      if (prev && !more) notice(p, "coupon", `A second coupon (“${name}”) arrived; only one counts per order. It's in your wallet: send it back if the shopper asks.`);
      else if (p.status === PAID) notice(p, "coupon", `${sent} arrived after the order was paid, so ${credit ? "they weren't" : "it wasn't"} applied. Refund the discount ${credit ? "they" : "it"} would have given, or send ${credit ? "them" : "the coupon"} back.`, { problem: true });
      else if (paidBesides(p, tok.txid) > 0 || p.status !== "awaiting")
        notice(p, "coupon", `${sent} arrived after part of the payment (or after the order closed), so ${credit ? "they weren't" : "it wasn't"} applied. Refund the discount or send ${credit ? "them" : "the coupon"} back.`, { problem: true });
      else if (more && tokenRoom(p) <= 0) notice(p, "coupon", `${sent} arrived after the items were already fully covered by tokens. Send them back to the shopper.`, { problem: true });
      else await applyCoupon(p, c, tok, more ? prev : null);
    }
  }

  // --- The shopper's side ----------------------------------------------------------------

  /**
   * The order in BCH at the price being held: items, coupon or tokens, shipping, sales tax, total. The total
   * is exactly what's asked; the items line takes up the rounding, so the lines always add up.
   */
  function breakdown(p, used, w) {
    if (!w || w.cents !== p.totalCents) return null;
    const at = (cents) => satsFor(cents, w.usdPerBch);
    // BCH-valued tokens at the rate they came in at show exactly their BCH.
    const offSats = !p.discountCents ? 0 : used?.kind === "bch" && used.usdPerBch === w.usdPerBch ? used.sats : at(p.discountCents);
    const shipSats = p.shippingCents ? at(p.shippingCents) : 0;
    const taxSats = p.taxCents ? at(p.taxCents) : 0;
    const otherSats = p.otherCents ? at(p.otherCents) : 0;
    const n = p.itemCount;
    const lines = [{ kind: "items", label: n ? `${n} ${n === 1 ? "item" : "items"}` : "Items", bch: bchText(w.sats + offSats - shipSats - taxSats - otherSats), cents: p.subtotalCents }];
    if (p.discountCents) {
      lines.push(
        used?.kind === "bch"
          ? { kind: "tokens", label: used.label, tokens: tokenText(used.tokens, used), each: `${used.value} BCH`, bch: bchText(offSats), cents: p.discountCents }
          : { kind: "coupon", label: used?.label ?? "Coupon", bch: bchText(offSats), cents: p.discountCents },
      );
    }
    if (p.shippingCents || p.shippingLabel) lines.push({ kind: "shipping", label: p.shippingLabel ?? "Shipping", bch: bchText(shipSats), cents: p.shippingCents });
    if (p.taxCents) lines.push({ kind: "tax", label: "Sales tax", bch: bchText(taxSats), cents: p.taxCents });
    if (p.otherCents) lines.push({ kind: "other", label: "Shipping and tax", bch: bchText(otherSats), cents: p.otherCents });
    return { usdPerBch: w.usdPerBch, sources: w.sources ?? [], lines, total: { bch: bchText(w.sats), cents: p.totalCents } };
  }

  /** What the payment screen shows. */
  function view(p) {
    const s = state(p);
    const current = p.windows?.at(-1);
    const d = due(p);
    const left = d ? Math.max(0, d - p.receivedSats) : null;
    const asking = s === "partial" ? left : current?.sats;
    const used = p.coupon;
    // More BCH-valued tokens can follow the first ones, until the items are covered.
    const stacking = used?.kind === "bch" && tokenRoom(p) > 0;
    const active = couponList().filter((c) => c.active !== false && (!used || (stacking && c.category === used.category)));
    const one = active.length === 1 ? active[0] : null;
    const offText = (c) => (c.kind === "percent" ? `${c.value}% off` : c.kind === "bch" ? `${c.value} BCH off each` : `${usd(Math.round(c.value * 100))} off`);
    const sendText = (c) =>
      c.token === "nft"
        ? "1 coupon NFT"
        : c.kind === "bch"
          ? current
            ? `up to ${tokenText(tokensFor(c, tokenRoom(p), current.usdPerBch), c)}`
            : `any number of ${c.symbol ?? "tokens"}`
          : `${c.units ?? 1} ${c.symbol ?? "token"}${(c.units ?? 1) > 1 && !c.symbol ? "s" : ""}`;
    const payable = s === "waiting" || s === "partial";
    return {
      id: p.id,
      state: s,
      address: p.address,
      amountBch: asking ? bchText(asking) : null,
      totalBch: d ? bchText(d) : null,
      paidBch: bchText(p.receivedSats),
      uri: asking ? paymentUri(p.address, { sats: asking, message: p.label ?? undefined }) : null,
      usdCents: p.totalCents,
      expiresAt: current?.expiresAt ?? null,
      minutes: priceMinutes,
      canRenew: p.status === "awaiting" && s === "expired" && p.windows.length < windowLimit(p),
      txUrl: s === "paid" ? bchExplorerUrl(p.payTxs?.[0]) : null,
      coupon:
        s === "waiting" && (!used || stacking) && active.length
          ? {
              address: p.tokenAddress,
              // A request for the token itself (Selene and Cashonize fill it in) when there's one kind of coupon.
              // (BCH-valued tokens: no amount filled in, the shopper sends as many as they like.)
              uri: one ? paymentUri(p.tokenAddress, { category: one.category, tokenAmount: one.token === "nft" || one.kind === "bch" ? undefined : (one.units ?? 1) }) : p.tokenAddress,
              coupons: active.map((c) => ({ label: c.label, off: offText(c), send: sendText(c) })),
              // Some can be sent in any number, a few at a time (BCH-valued tokens); otherwise one coupon per order.
              stack: active.some((c) => c.kind === "bch"),
            }
          : null,
      breakdown: breakdown(p, used, current),
      // The payment screen can offer "Connect wallet" (one transaction for the BCH and any tokens).
      walletPay: payable,
      // Rewards: what this order earned (once paid), or the promotion running while it's being paid.
      reward: engine ? engine.summary(p) : null,
      rewardOffer: engine && payable ? engine.offer() : null,
      // The receipt as a CashToken, once paid (if chosen), and how the shopper chose to get it.
      receipt: receiptsEngine ? receiptsEngine.summary(p) : null,
      receiptPref: p.receiptPref ?? "email",
      applied: used ? (used.kind === "bch" ? { label: `${used.label} (${tokenText(used.tokens, used)})`, discountCents: p.discountCents, bch: bchText(used.sats) } : { label: used.label, discountCents: p.discountCents }) : null,
    };
  }

  /** The price ran out with nothing sent: a new one. (Check your stock first, and close() if something sold out.) */
  async function renew(id) {
    await check(id);
    return exclusive(id, async () => {
      const p = await mustGet(id);
      const s = state(p);
      if (s === "expired_partial") throw new BchError("Part of the payment arrived before the price ran out, so a new price can't be given.", { status: 409 });
      if (s !== "expired") return view(p);
      if (p.status !== "awaiting" || p.windows.length >= windowLimit(p)) throw new BchError("This checkout has closed.", { status: 409 });
      await newPrice(p);
      await store.putPayment(p);
      return view(p);
    });
  }

  /** The order is gone (abandoned, or something sold out): its address goes back to the pool unless it was paid to. */
  function close(id) {
    return exclusive(id, async () => {
      const p = await mustGet(id);
      if (p.status !== "awaiting") return view(p);
      p.status = "closed";
      p.closedAt = iso();
      if (!(p.receivedSats > 0)) await store.releaseAddress(id, iso());
      await store.putPayment(p);
      return view(p);
    });
  }

  // --- Connect wallet (BCH WalletConnect) -------------------------------------------------
  //
  // The payment screen connects the shopper's wallet and asks here what it holds (BCH, and any of the
  // shop's BCH-valued tokens), for a quote with however many tokens they choose, and then for the payment
  // as one unsigned transaction: the BCH and the tokens together. The wallet signs it (and sends it); the
  // screen hands it back, it's checked against what was built, and sent from here too.

  /** An order the shopper can pay from their wallet now: waiting, or part paid, with its price still held. */
  function payable(p) {
    const s = state(p);
    if (s !== "waiting" && s !== "partial") throw new BchError(["paid", "arrived", "checking"].includes(s) ? "This order is already paid." : "The price hold has ended. Get a new price first.", { status: 409 });
    return s;
  }
  async function walletCoins(w) {
    try {
      return await chain.utxos(w.scripthash);
    } catch {
      throw new BchError("Couldn't reach the Bitcoin Cash network. Please try again in a moment.", { status: 502 });
    }
  }

  /** The BCH-valued tokens the order can still take (none once BCH has arrived), each with how many would cover the items. */
  function tokenOffers(p, s) {
    if (s !== "waiting" || p.receivedSats > 0) return [];
    const used = p.coupon;
    if (used && used.kind !== "bch") return [];
    const w = p.windows.at(-1);
    if (!w || tokenRoom(p) <= 0) return [];
    return couponList()
      .filter((c) => c.active !== false && c.kind === "bch" && c.token === "ft" && (!used || used.category === c.category))
      .map((c) => ({ c, useful: tokensFor(c, tokenRoom(p), w.usdPerBch) }));
  }

  /** What the connected wallet holds that this order can use. */
  async function walletInfo(id, address) {
    const p = await mustGet(id);
    const s = payable(p);
    const w = walletAddress(address);
    const held = walletHoldings(await walletCoins(w));
    return {
      address: w.address,
      bch: bchText(held.sats),
      tokens: tokenOffers(p, s).map(({ c, useful }) => {
        const have = BigInt(held.tokens[c.category] ?? 0);
        const max = have < useful ? have : useful;
        return { category: c.category, label: c.label, symbol: c.symbol ?? null, decimals: c.decimals ?? 0, value: c.value, have: have.toString(), max: max.toString(), useful: useful.toString(), haveText: tokenText(have, c), maxText: tokenText(max, c) };
      }),
    };
  }

  // Quotes are asked for as a slider moves: kept a little while (each may call onCoupon).
  const quotes = new Map();
  /** What the order comes to with `amount` of a token (in its smallest unit) taken off: the BCH asked, and the order in BCH. */
  async function quote(p, s, category, amount) {
    const w = p.windows.at(-1);
    let a;
    try {
      a = BigInt(String(amount ?? "0"));
    } catch {
      throw new BchError("How many tokens to use?");
    }
    if (a <= 0n) return { sats: s === "partial" ? Math.max(minSats, due(p) - p.receivedSats) : w.sats, tokens: null, breakdown: breakdown(p, p.coupon, w) };
    const offer = tokenOffers(p, s).find((x) => x.c.category === category);
    if (!offer) throw new BchError("Those tokens can't be used on this order.", { status: 409 });
    if (a > offer.useful) a = offer.useful;
    const key = `${p.id}:${w.n}:${p.discountCents}:${category}:${a}`;
    if (quotes.has(key)) return quotes.get(key);
    const prev = p.coupon?.kind === "bch" ? p.coupon : null;
    const e = await couponEffect(p, offer.c, { amount: a.toString(), txid: null, vout: null }, prev);
    const hypo = { ...p, discountCents: e.discount, taxCents: e.taxCents, totalCents: e.totalCents };
    const q = { sats: e.nextSats, tokens: { category, amount: a.toString(), text: tokenText(a, offer.c) }, breakdown: breakdown(hypo, e.coupon, { ...w, sats: e.nextSats, cents: hypo.totalCents }) };
    quotes.set(key, q);
    if (quotes.size > 500) quotes.delete(quotes.keys().next().value);
    return q;
  }

  async function walletQuote(id, { category, amount } = {}) {
    const p = await mustGet(id);
    const q = await quote(p, payable(p), String(category ?? ""), amount);
    return { amountBch: bchText(q.sats), tokens: q.tokens, breakdown: q.breakdown };
  }

  /** The payment as one unsigned transaction for the wallet to sign (bch_signTransaction): the BCH, and the tokens chosen. */
  async function walletBuild(id, { address, category, amount } = {}) {
    const p = await mustGet(id);
    const s = payable(p);
    const w = walletAddress(address);
    const q = await quote(p, s, String(category ?? ""), amount);
    let built;
    try {
      built = buildWalletPayment({ wallet: w, utxos: await walletCoins(w), payTo: p.lockingBytecode, sats: q.sats, token: q.tokens, userPrompt: p.label ?? `Order ${p.id}` });
    } catch (e) {
      if (e instanceof BchError) e.status = 409;
      throw e;
    }
    const window = p.windows.at(-1);
    await update(id, (x) => void (x.walletPlan = { address: w.address, sats: q.sats, category: q.tokens?.category ?? null, amount: q.tokens?.amount ?? "0", window: window.n, at: iso() }));
    return { request: built.request, amountBch: bchText(q.sats), feeBch: bchText(built.fee), tokens: q.tokens, breakdown: q.breakdown, expiresAt: window.expiresAt };
  }

  /**
   * The signed payment from the wallet (which has usually sent it already): checked against what was built,
   * and sent to the network too, in case the wallet's didn't get through. Returns { ok, txid }.
   */
  async function walletSubmit(id, hex) {
    const p0 = await mustGet(id);
    const paid = readSignedPayment(String(hex ?? ""), p0.lockingBytecode);
    // Already seen arriving (the wallet sent it, and it was noticed first): nothing more to do.
    if (p0.txs?.[paid.txid]) return { ok: true, txid: paid.txid };
    payable(p0);
    const plan = p0.walletPlan;
    if (!plan) throw new BchError("Start the payment again from your wallet.", { status: 409 });
    const tokensIn = paid.tokens.filter((t) => t.category === plan.category && !t.nft).reduce((n, t) => n + BigInt(t.amount), 0n);
    if (paid.sats < plan.sats || (plan.category && tokensIn < BigInt(plan.amount))) throw new BchError("That transaction doesn't match this payment, so it wasn't sent. Please try again.", { status: 409 });
    try {
      await chain.broadcast(String(hex));
    } catch (e) {
      // Already sent (by the wallet, or a second tap) is fine.
      if (!/already|known|txn-mempool-conflict-same/i.test(e.message)) throw new BchError(`The network didn't take the payment (${e.message}). Nothing was sent.`, { status: 502 });
    }
    const c = plan.category ? couponList().find((x) => x.category === plan.category) : null;
    await update(id, (p) => notice(p, "wallet", `Paid from the shopper's connected wallet${plan.category ? `, with ${tokenText(plan.amount, c ?? {})}` : ""} (transaction ${paid.txid}).`));
    try {
      await check(id);
    } catch {
      /* tick() picks it up */
    }
    return { ok: true, txid: paid.txid };
  }

  // --- Background ------------------------------------------------------------------------

  /**
   * Every minute: open payments, and paid ones not yet in a block (that's when a double-spend
   * would be tried, so a proof seen now is flagged); every ten minutes, those closed in the last
   * `reuseDays` (a payment can still arrive). Open ones past their price by 15 minutes are closed.
   * Rewards earned but not yet sent go too.
   */
  async function tick() {
    for (const p of await store.listPayments({ since: iso(now() - reuseDays * 86_400_000) })) {
      // A reward missed (the server stopped just after a payment).
      if (engine && p.status === PAID && p.reward === undefined && now() - Date.parse(p.paidAt) < 3_600_000) await engine.award(p.id).catch(() => {});
      if (p.status === PAID && p.confirmedNoted) continue;
      if (p.status === "closed" && now() - Date.parse(p.checkedAt ?? 0) < 10 * 60_000) continue;
      try {
        await check(p.id);
        const after = await store.getPayment(p.id);
        const tx = after.payTxs?.[0];
        if (after.status === PAID && tx && !(after.confirmations >= 1) && (await chain.dsproof(tx)) && !hasProblem(after, "dropped")) {
          await update(p.id, (x) => notice(x, "dropped", "The network has seen an attempt to spend this payment elsewhere (a double-spend). Don't ship until a block has confirmed it.", { problem: true }));
        }
        const current = after.windows?.at(-1);
        if (after.status === "awaiting" && current && Date.parse(current.expiresAt) + 15 * 60_000 < now()) await close(p.id);
      } catch {
        /* next time */
      }
    }
    if (engine) await engine.sendPending().catch(() => {});
    if (receiptsEngine) await receiptsEngine.sendPending().catch(() => {});
  }

  // Told straight away when a watched address is paid (or a block confirms it).
  chain.onActivity(async (scripthash) => {
    const id = await store.orderForScripthash(scripthash);
    if (id) check(id).catch(() => {});
  });

  /** After a restart: watch the addresses still worth watching. */
  async function watchAll() {
    for (const p of await store.listPayments({ since: iso(now() - 3 * 86_400_000) })) if (p.status === "awaiting" || (p.status === PAID && !p.confirmedNoted)) chain.watch(p.scripthash);
  }

  const noRewards = () => {
    throw new BchError("Rewards aren't set up.", { status: 404 });
  };

  return {
    start,
    view: async (id) => view(await mustGet(id)),
    check,
    renew,
    close,
    tick,
    watchAll,
    walletInfo,
    walletQuote,
    walletBuild,
    walletSubmit,
    /** The shopper claims their reward (paid from a wallet that wasn't connected) to a token address. */
    claimReward: (id, address) => (engine ? engine.claim(id, address) : noRewards()),
    /** For your admin screen: the hot wallet, its balance, the promotion and recent rewards. */
    rewardsStatus: () => (engine ? engine.status() : noRewards()),
    /** Sends some reward tokens to an address now, to try it out: { address, amount } (whole tokens). */
    testReward: (input) => (engine ? engine.test(input) : noRewards()),
    /** The shopper claims their CashToken receipt (paid from a wallet that wasn't connected) to a token address. */
    claimReceipt: (id, address) => (receiptsEngine ? receiptsEngine.claim(id, address) : Promise.reject(new BchError("Receipts as CashTokens aren't set up.", { status: 404 }))),
    /** True when the shopper chose the CashToken alone and it's going straight to their wallet: skip the receipt email (in onPaid). */
    receiptReplacesEmail: (payment) => payment?.receiptPref === "token" && Boolean(payment?.receipt?.to),
    payment: (id) => store.getPayment(id),
    /** The wallet's first receiving address, for the merchant to compare with their wallet. */
    firstAddress: () => addressAt(wallet, 0).address,
    unusedAhead: () => store.unusedAhead(wallet.id),
    stop: () => chain.close(),
  };
}
