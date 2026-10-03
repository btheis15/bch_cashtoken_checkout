/**
 * Receipts as CashTokens: a shopper paying with Bitcoin Cash can choose their receipt as an NFT in their own
 * wallet ("Receipt #1042"), one of a kind and numbered by the order. See docs/receipts.md.
 *
 *   const receipts = createReceiptIssuer({ wallet, store, siteUrl: "https://shop.example", shopName: "Example Shop" });
 *   await receipts.create({ name: "Example Receipt", description, icon: "https://shop.example/receipt.png" });   // once
 *   const bch = createBchCheckout({ …, receipts });
 *   await bch.start({ id, …, number: 1042, items: [{ title, qty, cents }], receipt: "token" });   // "email" | "token" | "both"
 *   // serve receipts.registry(category) at /bcmr/<category>.json, as for your token
 *
 * The collection is made once from the hot wallet: its genesis keeps a minting NFT (the "baton") there, and every
 * receipt is minted from it. An NFT holds at most 40 bytes, so the token itself carries 01 · the order number
 * (4 bytes) · the SHA-256 of the receipt (37 bytes). What wallets show (the items, amounts, date and payment, and
 * nothing personal) is in the collection's registry (CHIP-BCMR), one NFT type per receipt.
 *
 * Each receipt is minted in the same transaction that publishes the registry with it in: it spends the identity
 * output and the baton, gives both back (outputs 0 and 1), sends the receipt (output 2) and publishes. It's
 * recorded before it's sent, and a retry sends the very same transaction, so a receipt is never minted twice.
 * Rewards (and anything else using the hot wallet) never spend the identity output or the baton.
 */
import { createHash } from "node:crypto";
import { hexToBin } from "@bitauth/libauth";
import { BchError, bcmrOutput, bchExplorerUrl, buildFromWallet, signWalletPayment, walletAddress } from "./bch.js";

const IDENTITY_SATS = 1000;
const AUTHBASE_SATS = 2000;
const BATON_SATS = 1000;
const KEY = "bch_receipts";

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

/** The NFT's commitment (37 bytes, hex): version 01, the order number, and the SHA-256 of the receipt. */
export function receiptCommitment(number, receipt) {
  const n = Buffer.alloc(4);
  n.writeUInt32BE(Number.isInteger(number) && number >= 0 && number <= 0xffffffff ? number : 0);
  return `01${n.toString("hex")}${createHash("sha256").update(JSON.stringify(receipt)).digest("hex")}`;
}

/** The receipt as wallets show it: its name, a description, and the main facts (BCMR extensions are strings). */
export function receiptType(receipt, name) {
  const lines = receipt.items.map((i) => `${i.qty} × ${i.title} ${usd(i.cents)}`);
  const description = [
    `${receipt.shop}, ${receipt.order}, ${receipt.date}.`,
    lines.length ? `${lines.join("; ")}.` : "",
    receipt.discount ? `${receipt.discount.label}${receipt.discount.tokens ? ` (${receipt.discount.tokens})` : ""}: −${usd(receipt.discount.cents)}.` : "",
    receipt.shippingCents || receipt.taxCents ? `Shipping ${receipt.shippingCents ? usd(receipt.shippingCents) : "free"}${receipt.taxCents ? `, sales tax ${usd(receipt.taxCents)}` : ""}.` : "",
    `Total ${usd(receipt.totalCents)}, paid ${receipt.paidBch} BCH.`,
  ].filter(Boolean).join(" ");
  return { name, description, extensions: { order: receipt.order, date: receipt.date, total: usd(receipt.totalCents), paid: `${receipt.paidBch} BCH`, items: lines.join("; "), ...(receipt.tx ? { payment: receipt.tx } : {}) } };
}

export function createReceiptIssuer({
  wallet,
  store,
  /** Your website (https://…), where wallets read the receipts. A function for a live setting. */
  siteUrl,
  /** Your shop's name: on every receipt, and as the registry's name. */
  shopName = "Receipts",
  symbol = "RCPT",
  now = () => Date.now(),
} = {}) {
  if (!wallet || !store) throw new Error("createReceiptIssuer needs the hot wallet and a store with getMeta/putMeta.");
  const iso = (ms = now()) => new Date(ms).toISOString();
  const state = async () => (await store.getMeta(KEY)) ?? null;
  const put = async (patch) => store.putMeta(KEY, { ...((await state()) ?? {}), ...patch });
  const site = () => String((typeof siteUrl === "function" ? siteUrl() : siteUrl) ?? "").replace(/\/$/, "");
  const host = () => (/^https:\/\/[^/]+/.test(site()) ? site().replace(/^https:\/\//, "") : null);

  // Only receipts spend the collection's identity output, its baton, and an authbase waiting to make it.
  let guarded = new Set();
  const refreshGuard = async () => {
    const st = await state();
    guarded = new Set([...(st?.identity ?? []), ...(st?.baton ? [st.baton] : []), ...(st?.pending ? [`${st.pending.txid}:0`] : [])]);
  };
  wallet.guard(() => guarded);
  const ready = refreshGuard();

  function registryJson(st, types, at, revision) {
    const web = site() || undefined;
    return JSON.stringify(
      {
        $schema: "https://cashtokens.org/bcmr-v2.schema.json",
        version: { major: 1, minor: revision, patch: 0 },
        latestRevision: at,
        registryIdentity: { name: shopName, description: `Receipts from ${shopName}: one CashToken per order.`, ...(web ? { uris: { web } } : {}) },
        identities: {
          [st.category]: {
            [st.createdAt]: {
              name: st.name,
              ...(st.description ? { description: st.description } : {}),
              token: { category: st.category, symbol: st.symbol, nfts: { description: "One receipt per order, numbered by the order.", parse: { types } } },
              uris: { ...(st.icon ? { icon: st.icon } : {}), ...(web ? { web } : {}) },
            },
          },
        },
      },
      null,
      2,
    );
  }

  /** Makes the collection (once): an authbase, then the genesis with the identity output and the minting baton. */
  async function create(input = {}) {
    await ready;
    if ((await state())?.category) throw new BchError("The receipt collection already exists.", { status: 409 });
    const w = wallet.must();
    if (!host()) throw new BchError("The website's address (https://…) is needed first: wallets read the receipts from it.", { status: 409 });
    const clean = (v, max) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
    const name = clean(input.name, 30) || "Receipt";
    const description = clean(input.description, 400);
    const icon = clean(input.icon, 300) || null;
    if (icon && !/^(https:\/\/|ipfs:\/\/)\S+$/.test(icon)) throw new BchError("Please check the collection's details.", { errors: { icon: "The icon's address, starting with https:// (or ipfs://)." } });
    return wallet.exclusive(async () => {
      if ((await state())?.category) throw new BchError("The receipt collection already exists.", { status: 409 });
      const self = hexToBin(w.lockingBytecode);
      let base = (await state())?.pending ?? null;
      let change = null;
      if (!base) {
        let built;
        try {
          built = buildFromWallet({ wallet: w, utxos: await wallet.coins(), outputs: [{ lockingBytecode: self, valueSatoshis: BigInt(AUTHBASE_SATS) }] });
        } catch (e) {
          throw new BchError(`${e.message} Send the hot wallet about 0.0001 BCH (this uses about 0.00003).`, { status: 409 });
        }
        const signed = signWalletPayment(built, w.privateKey);
        const failed = await wallet.broadcastOnce(signed.hex);
        if (failed) throw new BchError(`The network didn't take it (${failed.message}). Nothing changed; please try again.`, { status: 502 });
        wallet.markSpent(wallet.spendsOf(built));
        base = { txid: signed.txid, genesis: null };
        if (built.transaction.outputs[1]) change = { txid: signed.txid, vout: 1, sats: Number(built.transaction.outputs[1].valueSatoshis), token: null };
        await put({ pending: base });
        await refreshGuard();
      }
      if (!base.genesis) {
        const category = base.txid;
        const st = { category, name, description, icon, symbol, createdAt: iso() };
        const json = registryJson(st, {}, st.createdAt, 0);
        const uri = `${host()}/bcmr/${category}.json`;
        const others = await wallet.coins().catch(() => []);
        const utxos = [...(change ? [change] : []), ...others.filter((u) => !(change && u.txid === change.txid && u.vout === change.vout))];
        let built;
        try {
          built = buildFromWallet({
            wallet: w,
            utxos,
            spend: [{ txid: base.txid, vout: 0, sats: AUTHBASE_SATS, token: null }],
            outputs: [
              { lockingBytecode: self, valueSatoshis: BigInt(IDENTITY_SATS) },
              { lockingBytecode: self, valueSatoshis: BigInt(BATON_SATS), token: { category: hexToBin(category), amount: 0n, nft: { capability: "minting", commitment: new Uint8Array() } } },
              bcmrOutput(json, uri),
            ],
          });
        } catch (e) {
          throw new BchError(`${e.message} Send the hot wallet a little more BCH, then try again.`, { status: 409 });
        }
        const signed = signWalletPayment(built, w.privateKey);
        base = { ...base, genesis: { hex: signed.hex, txid: signed.txid, spends: wallet.spendsOf(built), st, json, uri } };
        await put({ pending: base });
      }
      const g = base.genesis;
      const sent = await wallet.sendRecorded(g);
      if (!sent.ok) {
        await put({ pending: { ...base, genesis: null } });
        throw new BchError(`The network didn't take it (${sent.message}). Please try again in a moment.`, { status: 502 });
      }
      wallet.markSpent(g.spends);
      await put({ pending: null, ...g.st, registry: { json: g.json, uri: g.uri, tx: g.txid, at: g.st.createdAt }, genesisTxid: g.txid, authhead: `${g.txid}:0`, baton: `${g.txid}:1`, identity: [`${g.txid}:0`], types: {}, revision: 0, mint: null });
      await refreshGuard();
      return status();
    });
  }

  /**
   * Mints one receipt to `to` (a token address), in one transaction with the registry that lists it. Call inside
   * wallet.exclusive(). Recorded before it's sent; called again for the same order, it sends the very same one.
   * { state: "sent", txid } · { state: "sending", txid, error } (try again later) · { state: "pending", error }
   * (not planned or not taken: plan again later) · { state: "busy" } (another receipt is on its way first).
   */
  async function mint(orderId, { to, commitment, type }) {
    await ready;
    const w = wallet.must();
    let st = await state();
    if (!st?.category) throw new BchError("Make the receipt collection first.", { status: 409 });
    if (st.mint && st.mint.orderId !== orderId) return { state: "busy" };
    if (!st.mint) {
      const types = { ...st.types, [commitment]: type };
      const at = iso();
      const revision = (st.revision ?? 0) + 1;
      const json = registryJson(st, types, at, revision);
      const uri = `${host()}/bcmr/${st.category}.json`;
      const self = hexToBin(w.lockingBytecode);
      const category = hexToBin(st.category);
      const [itx, ivout] = st.authhead.split(":");
      const [btx, bvout] = st.baton.split(":");
      let built;
      try {
        built = buildFromWallet({
          wallet: w,
          utxos: await wallet.coins(),
          spend: [
            { txid: itx, vout: Number(ivout), sats: IDENTITY_SATS, token: null },
            { txid: btx, vout: Number(bvout), sats: BATON_SATS, token: { category: st.category, amount: "0", nft: { capability: "minting", commitment: "" } } },
          ],
          outputs: [
            { lockingBytecode: self, valueSatoshis: BigInt(IDENTITY_SATS) },
            { lockingBytecode: self, valueSatoshis: BigInt(BATON_SATS), token: { category, amount: 0n, nft: { capability: "minting", commitment: new Uint8Array() } } },
            { lockingBytecode: hexToBin(walletAddress(to).lockingBytecode), valueSatoshis: 1000n, token: { category, amount: 0n, nft: { capability: "none", commitment: hexToBin(commitment) } } },
            bcmrOutput(json, uri),
          ],
        });
      } catch (e) {
        return { state: "pending", error: e.message };
      }
      const signed = signWalletPayment(built, w.privateKey);
      await put({ mint: { orderId, hex: signed.hex, txid: signed.txid, spends: wallet.spendsOf(built), types, json, uri, at, revision, tries: 0 } });
      st = await state();
    }
    const m = st.mint;
    const sent = await wallet.sendRecorded(m);
    if (!sent.ok) {
      const tries = (m.tries ?? 0) + 1;
      if (/missing|spent|conflict|insufficient/i.test(sent.message) || tries >= 5) {
        await put({ mint: null });
        return { state: "pending", error: sent.message };
      }
      await put({ mint: { ...m, tries } });
      return { state: "sending", txid: m.txid, error: sent.message };
    }
    wallet.markSpent(m.spends);
    await put({ mint: null, types: m.types, revision: m.revision, registry: { json: m.json, uri: m.uri, tx: m.txid, at: m.at }, authhead: `${m.txid}:0`, baton: `${m.txid}:1`, identity: [...(st.identity ?? []), `${m.txid}:0`].slice(-8) });
    await refreshGuard();
    return { state: "sent", txid: m.txid };
  }

  /** The order whose receipt is on its way (planned, not yet taken by the network), if any. */
  const inFlight = async () => (await state())?.mint?.orderId ?? null;

  /** The registry wallets fetch, as the exact text whose hash is on chain (null for any other category). */
  async function registry(category) {
    const st = await state();
    return st?.category && st.category === category && st.registry ? st.registry.json : null;
  }

  /** For your admin screen: the collection, once made. */
  async function status() {
    const st = await state();
    return {
      registryHost: host(),
      wallet: Boolean(wallet.info()),
      minting: Boolean(st?.pending),
      collection: st?.category
        ? { category: st.category, name: st.name, description: st.description ?? "", icon: st.icon ?? null, registryUrl: `https://${st.registry.uri}`, createdUrl: bchExplorerUrl(st.genesisTxid), issued: Object.keys(st.types ?? {}).length }
        : null,
    };
  }

  /** Ready to issue receipts: the collection exists. */
  const ready_ = async () => {
    const st = await state();
    return Boolean(st?.category && !st.pending && wallet.info());
  };

  return { create, mint, inFlight, registry, status, ready: ready_, name: async () => (await state())?.name ?? "Receipt", icon: async () => (await state())?.icon ?? null, shopName, wallet };
}

/**
 * The per-payment side, used by createBchCheckout({ receipts }): after a payment counts, the receipt (if the shopper
 * chose one) goes to the wallet that paid when it was connected, or waits to be claimed.
 *
 * A payment's receipt (payment.receipt): null (not chosen) · { state: "pending" | "sending" | "sent" | "claimable", name,
 * receipt, to, txid, claimUntil, commitment }.
 */
export function createReceiptsEngine({ issuer, chain, store, update, notice, connectedPayer, claimDays = 90, now = () => Date.now() }) {
  if (!issuer?.wallet) throw new Error("receipts needs createReceiptIssuer({ wallet, store, … }).");
  const iso = (ms = now()) => new Date(ms).toISOString();

  /** What the receipt shows: public (wallets and anyone can read it), so nothing personal. */
  function publicReceipt(p) {
    const c = p.coupon;
    return {
      shop: issuer.shopName,
      order: p.label ?? `Order ${p.id}`,
      date: (p.paidAt ?? iso()).slice(0, 10),
      items: (p.items ?? []).map((i) => ({ title: String(i.title), qty: Number(i.qty ?? 1), cents: Number(i.cents ?? 0) })),
      subtotalCents: p.subtotalCents,
      discount: p.discountCents ? { label: c?.label ?? "Coupon", cents: p.discountCents, ...(c?.kind === "bch" ? { tokens: `${c.tokens} ${c.symbol ?? "tokens"}` } : {}) } : null,
      shippingCents: p.shippingCents ?? 0,
      taxCents: p.taxCents ?? 0,
      totalCents: p.totalCents,
      paidBch: (Number(p.paidSats ?? p.receivedSats ?? 0) / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0",
      tx: p.payTxs?.[0] ?? null,
    };
  }

  /**
   * When a payment counts (before onPaid, so the shop knows whether the receipt email is still needed): its receipt,
   * if the shopper chose one. Changes the payment in place; the receipt is sent afterwards (sendPending).
   */
  async function prepare(p) {
    if (p.receipt !== undefined) return;
    p.receipt = null;
    if (!["token", "both"].includes(p.receiptPref) || !(await issuer.ready())) return;
    const to = await connectedPayer(p, chain);
    p.receipt = { name: `${await issuer.name()} #${p.number ?? p.id}`, receipt: publicReceipt(p), state: to ? "pending" : "claimable", to, at: iso(), claimUntil: to ? null : iso(now() + claimDays * 86_400_000) };
    notice(p, "receipt", to ? `Receipt chosen as a CashToken: sending ${p.receipt.name} to the wallet that paid.` : `Receipt chosen as a CashToken: the shopper can claim ${p.receipt.name} (paid from a wallet that can't safely be sent tokens).`);
  }

  async function send(id) {
    const p = await store.getPayment(id);
    const rt = p?.receipt;
    if (!rt || !["pending", "sending"].includes(rt.state) || !rt.to) return;
    const commitment = rt.commitment ?? receiptCommitment(p.number, rt.receipt);
    const r = await issuer.mint(id, { to: rt.to, commitment, type: receiptType(rt.receipt, rt.name) });
    if (r.state === "busy") return;
    await update(id, (q) => {
      const before = q.receipt;
      q.receipt = { ...before, commitment, state: r.state, txid: r.txid ?? (r.state === "pending" ? null : before.txid), error: r.error ?? null, ...(r.state === "sent" ? { sentAt: iso() } : {}) };
      if (r.state === "sent") notice(q, "receipt", `Receipt sent as a CashToken: ${before.name} to ${before.to} (transaction ${r.txid}).`);
      else if (r.error && r.error !== before.error) notice(q, "receipt", `Couldn't send the CashToken receipt yet: ${r.error} It goes as soon as it can.`);
    });
  }

  /** Every receipt waiting to go; the one already on its way goes first. Run by tick(). */
  async function sendPending(onlyId = null) {
    if (!(await issuer.ready())) return;
    const first = await issuer.inFlight();
    const ids = onlyId
      ? [...(first && first !== onlyId ? [first] : []), onlyId]
      : [...(first ? [first] : []), ...(await store.listPayments({ since: iso(now() - (claimDays + 30) * 86_400_000) })).filter((p) => p.receipt && ["pending", "sending"].includes(p.receipt.state)).map((p) => p.id).filter((x) => x !== first)];
    // One send at a time on the hot wallet (rewards and the token use it too).
    for (const id of ids) await issuer.wallet.exclusive(() => send(id)).catch(() => {});
  }

  /** What the shopper sees of their CashToken receipt. */
  function summary(p) {
    const rt = p?.receipt;
    if (!rt) return null;
    const expired = rt.state === "claimable" && rt.claimUntil && Date.parse(rt.claimUntil) < now();
    return {
      name: rt.name,
      state: expired ? "expired" : rt.state === "pending" || rt.state === "sending" ? "sending" : rt.state,
      to: rt.to ?? null,
      txUrl: rt.state === "sent" && rt.txid ? bchExplorerUrl(rt.txid) : null,
      claimUntil: rt.claimUntil ?? null,
      receipt: rt.receipt,
    };
  }

  /** The shopper claims their receipt to a wallet that holds tokens. */
  async function claim(id, address) {
    const p = await store.getPayment(id);
    if (!p?.receipt) throw new BchError("This order has no CashToken receipt to claim.", { status: 404 });
    if (p.receipt.state === "claimable") {
      if (p.receipt.claimUntil && Date.parse(p.receipt.claimUntil) < now()) throw new BchError("The time to claim this receipt has passed.", { status: 409 });
      const dest = walletAddress(address);
      await update(id, (q) => {
        if (q.receipt.state !== "claimable") return;
        q.receipt = { ...q.receipt, to: dest.tokenAddress, state: "pending", claimedAt: iso() };
        notice(q, "receipt", `The shopper claimed ${q.receipt.name} to ${dest.tokenAddress}.`);
      });
      await sendPending(id);
    }
    return { receipt: summary(await store.getPayment(id)) };
  }

  return { prepare, sendPending, summary, claim };
}
