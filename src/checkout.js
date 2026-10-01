/**
 * A Bitcoin Cash checkout for your own website: payments go straight into
 * your own wallet (you give it an xPub, which can't spend), and your server
 * watches the blockchain itself. No payment company, account or fees.
 *
 *   start(order)   reserves the order's own address in your wallet and a BCH
 *                  price for its total (held `priceMinutes`)
 *   view(id)       what the payment screen shows: amount, address, a
 *                  bitcoincash: link for the QR code and "open in wallet",
 *                  the countdown, the coupon offer
 *   check(id)      reads the address from the blockchain and moves the
 *                  payment on (called for you when the network says the
 *                  address changed, and by tick())
 *   renew(id)      a new price once one ran out with nothing sent
 *   close(id)      the order is gone (abandoned, sold out): the address goes
 *                  back to the pool after `reuseDays`
 *   tick()         run every minute: catches anything a notice missed, late
 *                  payments, double-spends before the first block
 *
 * Zero-conf, as the BCH community expects: when enough has arrived it
 * listens `proofWaitMs` for a double-spend proof (the DSProof spec's
 * "wait T seconds"), then the payment counts (onPaid). With a proof, it's
 * held until a block settles it. See docs/zero-conf.md.
 *
 * CashTokens coupons: tokens you mint and give out. A shopper sends one to
 * the order's address (its token-aware z… form) before paying; the discount
 * comes off and a new price is given. See docs/coupons.md.
 */
import { addressAt, BchError, bchExplorerUrl, bchText, createBchChain, createBchPrices, parseXpub, paymentUri, readPayment, satsFor } from "./bch.js";

export { BchError, parseXpub, addressAt } from "./bch.js";

const PAID = "paid";

export function createBchCheckout({
  xpub,
  store,
  chain = createBchChain(),
  prices = createBchPrices(),
  /** Your CashTokens coupons, or a (synchronous) function returning them: [{ category, label, token: "ft" | "nft", units, kind: "percent" | "amount", value, symbol, active }] */
  coupons = [],
  /** (payment) => fulfil the order. Called once. */
  onPaid = () => {},
  /** (payment, { kind, message, problem }) => things the merchant should know (problem: true means look before shipping). */
  onNotice = () => {},
  /** async (payment, coupon, discountCents) => the order's new total in cents (e.g. with sales tax worked out again). */
  onCoupon = null,
  priceMinutes = 30,
  maxPrices = 4,
  proofWaitMs = 3000,
  tolerance = 0.002,
  reuseDays = 7,
  now = () => Date.now(),
} = {}) {
  if (!store) throw new Error("createBchCheckout needs a store (see memory-store.js).");
  const wallet = parseXpub(xpub);
  const couponList = () => {
    const list = typeof coupons === "function" ? coupons() : coupons;
    return Array.isArray(list) ? list : [];
  };
  const iso = (ms = now()) => new Date(ms).toISOString();

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
    if (!p) throw new BchError(`No Bitcoin Cash payment for order ${id}.`);
    return p;
  }

  function notice(p, kind, message, { problem = false } = {}) {
    p.events = [...(p.events ?? []), { at: iso(), kind, message }];
    if (problem && !(p.problems ?? []).some((x) => x.kind === kind)) p.problems = [...(p.problems ?? []), { kind, message, at: iso() }];
    Promise.resolve(onNotice(p, { kind, message, problem })).catch(() => {});
  }
  const clearProblem = (p, kind) => (p.problems = (p.problems ?? []).filter((x) => x.kind !== kind));
  const hasProblem = (p, kind) => (p.problems ?? []).some((x) => x.kind === kind);

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
    throw new BchError("Couldn't find an unused address in the wallet.");
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

  async function newPrice(p) {
    const price = await prices.usdPerBch();
    const w = { n: (p.windows?.length ?? 0) + 1, cents: p.totalCents, usdPerBch: price.usd, sources: price.sources, sats: satsFor(p.totalCents, price.usd), startedAt: iso(), expiresAt: iso(now() + priceMinutes * 60_000) };
    p.windows = [...(p.windows ?? []), w];
    notice(p, "price", `${w.n > 1 ? "New price" : "Price"}: ${bchText(w.sats)} BCH for $${(p.totalCents / 100).toFixed(2)} at $${price.usd.toFixed(2)} per BCH (${price.sources.join(", ")}), held ${priceMinutes} minutes.`);
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
   * A new order's payment. subtotalCents: the items (what coupons take a share
   * of); otherCents: shipping and tax. Returns the view.
   */
  async function start({ id, label = null, subtotalCents, otherCents = 0 }) {
    if (!id || !(subtotalCents >= 0) || !(subtotalCents + otherCents > 0)) throw new BchError("start() needs an id and a total above zero.");
    if (await store.getPayment(id)) throw new BchError(`Order ${id} already has a Bitcoin Cash payment.`);
    const a = await reserveAddress(id);
    const p = {
      id, label, status: "awaiting", createdAt: iso(), subtotalCents, otherCents, totalCents: subtotalCents + otherCents, discountCents: 0, coupon: null,
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
      notice(p, "paid", `Paid ${bchText(p.receivedSats)} BCH.`);
      if (p.receivedSats < d) notice(p, "short", `${bchText(d - p.receivedSats)} BCH short of the price, within the rounding allowance.`);
      if (p.receivedSats > d * 1.005) notice(p, "extra", `${bchText(p.receivedSats - d)} BCH more than asked arrived.`);
      if (late) notice(p, "late", "The payment arrived after the order was closed. Check the stock before shipping.", { problem: true });
      if (txids.length && proofs.some((x) => x === undefined)) notice(p, "proofs", "Double-spend proofs couldn't be checked when it arrived; it's watched until a block confirms it.");
      if (txids.some((t) => p.txs[t].covered === false))
        notice(p, "unprotected", "This payment came from a kind of wallet double-spend proofs don't cover (a script or multisig wallet). Wait for a block before shipping: this clears itself then.", { problem: true });
      await store.putPayment(p);
      Promise.resolve(onPaid(structuredClone(p))).catch(() => {});
      return;
    }

    const s = state(p);
    if (s === "partial" && !(p.events ?? []).some((e) => e.kind === "partial" && e.message.includes(bchText(p.receivedSats)))) notice(p, "partial", `Part of the payment arrived (${bchText(p.receivedSats)} of ${bchText(due(p))} BCH).`);
    if (s === "expired_partial" && !hasProblem(p, "partial"))
      notice(p, "partial", `Only part of the payment arrived (${bchText(p.receivedSats)} of ${bchText(due(p))} BCH) before the price ran out. Send it back, or contact the shopper.`, { problem: true });
  }

  // --- Coupons -------------------------------------------------------------------------

  const couponDiscount = (c, subtotalCents) => Math.min(subtotalCents, c.kind === "percent" ? Math.round((subtotalCents * c.value) / 100) : Math.round(c.value * 100));

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
      const valid = c && c.active !== false && (c.token === "nft" ? tok.nft && tok.nft.capability === "none" : !tok.nft && BigInt(tok.amount) >= BigInt(c.units ?? 1));
      const name = c?.label ?? `token ${tok.category.slice(0, 8)}…`;
      if (!valid) {
        notice(p, "token", c ? `A “${name}” token arrived but can't be used as a coupon${c.active === false ? " (that coupon is switched off)" : tok.nft && tok.nft.capability !== "none" ? " (it's a minting or changeable NFT)" : ""}.` : `A token that isn't one of your coupons arrived (${name}).`);
        continue;
      }
      if (p.coupon) notice(p, "coupon", `A second coupon (“${name}”) arrived; only one counts per order.`);
      else if (p.status === PAID) notice(p, "coupon", `A coupon (“${name}”) arrived after the order was paid, so it wasn't applied. Refund the discount or send the coupon back.`, { problem: true });
      else if (p.receivedSats > 0 || p.status !== "awaiting") notice(p, "coupon", `A coupon (“${name}”) arrived after part of the payment (or after the order closed), so it wasn't applied.`, { problem: true });
      else {
        const discount = couponDiscount(c, p.subtotalCents);
        const total = onCoupon ? await onCoupon(structuredClone(p), c, discount) : p.subtotalCents - discount + p.otherCents;
        Object.assign(p, { discountCents: discount, totalCents: total, coupon: { label: c.label, category: c.category, token: c.token, kind: c.kind, value: c.value, txid: tok.txid, vout: tok.vout, amount: tok.amount, nft: tok.nft, at: iso() } });
        notice(p, "coupon", `Coupon “${c.label}” applied: $${(discount / 100).toFixed(2)} off. New total $${(total / 100).toFixed(2)}.`);
        await newPrice(p);
      }
    }
  }

  // --- The shopper's side ----------------------------------------------------------------

  /** What the payment screen shows. */
  function view(p) {
    const s = state(p);
    const current = p.windows?.at(-1);
    const d = due(p);
    const left = d ? Math.max(0, d - p.receivedSats) : null;
    const asking = s === "partial" ? left : current?.sats;
    const active = couponList().filter((c) => c.active !== false);
    const one = active.length === 1 ? active[0] : null;
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
      canRenew: p.status === "awaiting" && s === "expired" && p.windows.length < maxPrices + (p.coupon ? 1 : 0),
      txUrl: s === "paid" ? bchExplorerUrl(p.payTxs?.[0]) : null,
      coupon:
        s === "waiting" && !p.coupon && active.length
          ? {
              address: p.tokenAddress,
              // A request for the token itself (Selene and Cashonize fill it in) when there's one kind of coupon.
              uri: one ? paymentUri(p.tokenAddress, { category: one.category, tokenAmount: one.token === "nft" ? undefined : one.units ?? 1 }) : p.tokenAddress,
              coupons: active.map((c) => ({ label: c.label, off: c.kind === "percent" ? `${c.value}% off` : `$${Number(c.value).toFixed(2)} off`, send: c.token === "nft" ? "1 coupon NFT" : `${c.units ?? 1} ${c.symbol ?? "token"}${(c.units ?? 1) > 1 && !c.symbol ? "s" : ""}` })),
            }
          : null,
      applied: p.coupon ? { label: p.coupon.label, discountCents: p.discountCents } : null,
    };
  }

  /** The price ran out with nothing sent: a new one. */
  async function renew(id) {
    await check(id);
    return exclusive(id, async () => {
      const p = await mustGet(id);
      const s = state(p);
      if (s === "expired_partial") throw new BchError("Part of the payment arrived before the price ran out, so a new price can't be given.");
      if (s !== "expired") return view(p);
      if (p.status !== "awaiting" || p.windows.length >= maxPrices + (p.coupon ? 1 : 0)) throw new BchError("This checkout has closed.");
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

  // --- Background ------------------------------------------------------------------------

  /**
   * Every minute: open payments, and paid ones not yet in a block (that's when a double-spend
   * would be tried, so a proof seen now is flagged); every ten minutes, those closed in the last
   * `reuseDays` (a payment can still arrive). Open ones past their price by 15 minutes are closed.
   */
  async function tick() {
    for (const p of await store.listPayments({ since: iso(now() - reuseDays * 86_400_000) })) {
      if (p.status === PAID && p.confirmedNoted) continue;
      if (p.status === "closed" && now() - Date.parse(p.checkedAt ?? 0) < 10 * 60_000) continue;
      try {
        await check(p.id);
        const after = await store.getPayment(p.id);
        const tx = after.payTxs?.[0];
        if (after.status === PAID && tx && !(after.confirmations >= 1) && (await chain.dsproof(tx)) && !hasProblem(after, "dropped")) {
          notice(after, "dropped", "The network has seen an attempt to spend this payment elsewhere (a double-spend). Don't ship until a block has confirmed it.", { problem: true });
          await store.putPayment(after);
        }
        const current = after.windows?.at(-1);
        if (after.status === "awaiting" && current && Date.parse(current.expiresAt) + 15 * 60_000 < now()) await close(p.id);
      } catch {
        /* next time */
      }
    }
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

  return {
    start,
    view: async (id) => view(await mustGet(id)),
    check,
    renew,
    close,
    tick,
    watchAll,
    payment: (id) => store.getPayment(id),
    /** The wallet's first receiving address, for the merchant to compare with their wallet. */
    firstAddress: () => addressAt(wallet, 0).address,
    unusedAhead: () => store.unusedAhead(wallet.id),
    stop: () => chain.close(),
  };
}
