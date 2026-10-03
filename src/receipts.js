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

/** The receipt as text: when, each item line, the discount, shipping and what was paid. */
function receiptFacts(r) {
  const when = `${new Date(r.paidAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
  const items = r.items.map((i) => `${i.qty} × ${i.title}${i.option ? ` (${i.option})` : ""} @ ${usd(i.unitCents)} = ${usd(i.cents)}`);
  return {
    when,
    items,
    discount: r.discount ? `${r.discount.label}${r.discount.tokens ? ` (${r.discount.tokens}${r.discount.bch ? `, ${r.discount.bch} BCH` : ""})` : ""}: −${usd(r.discount.cents)}` : null,
    shipping: r.shipping ? `${r.shipping.label}: ${r.shipping.cents ? usd(r.shipping.cents) : "free"}` : null,
    paid: `${r.payment.paidBch} BCH${r.payment.usdPerBch ? ` at $${r.payment.usdPerBch.toFixed(2)} per BCH` : ""}`,
  };
}

/** The receipt as wallets show it: its name, the whole receipt as its description, and each fact (BCMR extensions are strings). */
export function receiptType(r, name) {
  const f = receiptFacts(r);
  const description = [
    `${r.shop} · ${r.order} · ${f.when}`,
    ...f.items,
    `Subtotal ${usd(r.subtotalCents)}`,
    f.discount,
    f.shipping,
    r.taxCents ? `Sales tax ${usd(r.taxCents)}` : null,
    r.otherCents ? `Other ${usd(r.otherCents)}` : null,
    `Total ${usd(r.totalCents)}`,
    `Paid ${f.paid} (${r.payment.method})`,
    r.payment.paidTo ? `To ${r.payment.paidTo}` : null,
    r.payment.tx ? `Transaction ${r.payment.tx}` : null,
    r.reward ? `Earned ${r.reward}` : null,
    r.returns ?? null,
    [r.website, r.contact].filter(Boolean).join(" · ") || null,
    r.note ?? null,
  ].filter(Boolean).join("\n");
  const extensions = {
    shop: r.shop,
    order: r.order,
    date: r.paidAt,
    ...(f.items.length ? { items: f.items.join("; ") } : {}),
    subtotal: usd(r.subtotalCents),
    ...(f.discount ? { discount: f.discount } : {}),
    ...(f.shipping ? { shipping: f.shipping } : {}),
    ...(r.taxCents ? { tax: usd(r.taxCents) } : {}),
    total: usd(r.totalCents),
    paid: f.paid,
    method: r.payment.method,
    ...(r.payment.paidTo ? { paid_to: r.payment.paidTo } : {}),
    ...(r.payment.tx ? { payment: r.payment.tx } : {}),
    ...(r.reward ? { reward: r.reward } : {}),
    ...(r.returns ? { returns: r.returns } : {}),
    ...(r.website ? { website: r.website } : {}),
    ...(r.contact ? { contact: r.contact } : {}),
    ...(r.note ? { note: r.note } : {}),
  };
  return { name, description, extensions };
}

/** What every receipt carries besides the order (changed with update({ look })): a note, contact and returns lines, and switches. */
export const RECEIPT_LOOK = Object.freeze({ note: "", contact: "", returns: "", website: true, reward: true });

export function createReceiptIssuer({
  wallet,
  store,
  /** Your website (https://…), where wallets read the receipts. A function for a live setting. */
  siteUrl,
  /** Your shop's name: on every receipt, and as the registry's name. */
  shopName = "Receipts",
  symbol = "RCPT",
  /** What receipts carry to start with ({ note, contact, returns, website, reward }); update({ look }) changes it later. */
  look: initialLook = {},
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
            [st.updatedAt ?? st.createdAt]: {
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
    if ((st.mint && st.mint.orderId !== orderId) || st.update) return { state: "busy" };
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

  /** What receipts carry now (the next ones): { note, contact, returns, website, reward }. */
  async function look() {
    return { ...RECEIPT_LOOK, ...initialLook, ...((await state())?.look ?? {}) };
  }

  /**
   * Changes receipts, for your admin screen. `look` ({ note, contact, returns, website, reward }) applies to the next
   * receipts, with no transaction. A new `name`, `description` or `icon` (what wallets show for the collection) is
   * published on chain by spending the identity output and keeping it (output 0); recorded before it's sent, so a
   * retry sends the same one. Receipts already sent keep their own names.
   */
  async function update(input = {}) {
    await ready;
    const st0 = await state();
    if (!st0?.category) throw new BchError("Make the receipt collection first.", { status: 409 });
    const clean = (v, max) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
    const l = await look();
    if (input.look && typeof input.look === "object") {
      for (const k of ["note", "contact", "returns"]) if (k in input.look) l[k] = clean(input.look[k], 200);
      for (const k of ["website", "reward"]) if (k in input.look) l[k] = input.look[k] === true;
    }
    const next = {
      name: "name" in input ? clean(input.name, 30) || st0.name : st0.name,
      description: "description" in input ? clean(input.description, 400) : (st0.description ?? ""),
      icon: "icon" in input ? clean(input.icon, 300) || null : (st0.icon ?? null),
    };
    if (next.icon && !/^(https:\/\/|ipfs:\/\/)\S+$/.test(next.icon)) throw new BchError("Please check the receipts' details.", { errors: { icon: "The icon's address, starting with https:// (or ipfs://)." } });
    await put({ look: l });
    const changed = next.name !== st0.name || next.description !== (st0.description ?? "") || next.icon !== (st0.icon ?? null);
    if (!changed && !st0.update) return status();
    const w = wallet.must();
    if (!host()) throw new BchError("The website's address (https://…) is needed first.", { status: 409 });
    return wallet.exclusive(async () => {
      let st = await state();
      if (st.mint) throw new BchError("A receipt is on its way to a shopper right now. Try again in a minute.", { status: 409 });
      if (!st.update) {
        const at = iso();
        const revision = (st.revision ?? 0) + 1;
        const json = registryJson({ ...st, ...next, updatedAt: at }, st.types ?? {}, at, revision);
        const uri = `${host()}/bcmr/${st.category}.json`;
        const [itx, ivout] = st.authhead.split(":");
        let built;
        try {
          built = buildFromWallet({
            wallet: w,
            utxos: await wallet.coins(),
            spend: [{ txid: itx, vout: Number(ivout), sats: IDENTITY_SATS, token: null }],
            outputs: [{ lockingBytecode: hexToBin(w.lockingBytecode), valueSatoshis: BigInt(IDENTITY_SATS) }, bcmrOutput(json, uri)],
          });
        } catch (e) {
          throw new BchError(`${e.message} Send the hot wallet a little BCH, then try again.`, { status: 409 });
        }
        const signed = signWalletPayment(built, w.privateKey);
        await put({ update: { hex: signed.hex, txid: signed.txid, spends: wallet.spendsOf(built), json, uri, at, revision, next: { ...next, updatedAt: at } } });
        st = await state();
      }
      const u = st.update;
      const sent = await wallet.sendRecorded(u);
      if (!sent.ok) {
        await put({ update: null });
        throw new BchError(`The network didn't take it (${sent.message}). Nothing changed; please try again in a moment.`, { status: 502 });
      }
      wallet.markSpent(u.spends);
      await put({ ...u.next, update: null, revision: u.revision, registry: { json: u.json, uri: u.uri, tx: u.txid, at: u.at }, authhead: `${u.txid}:0`, identity: [...(st.identity ?? []), `${u.txid}:0`].slice(-8) });
      await refreshGuard();
      return status();
    });
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
      look: await look(),
      collection: st?.category
        ? { category: st.category, name: st.name, description: st.description ?? "", icon: st.icon ?? null, registryUrl: `https://${st.registry.uri}`, createdUrl: bchExplorerUrl(st.genesisTxid), issued: Object.keys(st.types ?? {}).length, updating: Boolean(st.update) }
        : null,
    };
  }

  /** Ready to issue receipts: the collection exists. */
  const ready_ = async () => {
    const st = await state();
    return Boolean(st?.category && !st.pending && wallet.info());
  };

  return { create, update, mint, inFlight, registry, status, look, site, ready: ready_, name: async () => (await state())?.name ?? "Receipt", icon: async () => (await state())?.icon ?? null, shopName, wallet };
}

/**
 * The per-payment side, used by createBchCheckout({ receipts }): after a payment counts, the receipt (if the shopper
 * chose one) goes to the wallet that paid when it was connected, or waits to be claimed.
 *
 * A payment's receipt (payment.receipt): null (not chosen) · { state: "pending" | "sending" | "sent" | "claimable", name,
 * receipt, to, txid, claimUntil, commitment }.
 */
export function createReceiptsEngine({ issuer, chain, store, update, notice, connectedPayer, earned = null, claimDays = 90, now = () => Date.now() }) {
  if (!issuer?.wallet) throw new Error("receipts needs createReceiptIssuer({ wallet, store, … }).");
  const iso = (ms = now()) => new Date(ms).toISOString();

  /**
   * What the receipt shows: everything a shop receipt has (the shop, the order, each item with its option, quantity
   * and prices, discounts and tokens, shipping, tax, total, and the payment: BCH, rate, address paid to, transaction),
   * and nothing about the shopper: anyone can read it.
   */
  async function publicReceipt(p) {
    const c = p.coupon;
    const l = await issuer.look();
    const web = issuer.site();
    const reward = l.reward && earned ? earned(p) : null;
    return {
      shop: issuer.shopName,
      ...(l.website && web ? { website: web } : {}),
      ...(l.contact ? { contact: l.contact } : {}),
      order: p.label ?? `Order ${p.id}`,
      paidAt: p.paidAt ?? iso(),
      items: (p.items ?? []).map((i) => {
        const qty = Number(i.qty ?? 1);
        const unitCents = Number(i.unitCents ?? (i.cents !== undefined ? Math.round(Number(i.cents) / qty) : 0));
        return { title: String(i.title), option: i.option ? String(i.option) : null, qty, unitCents, cents: Number(i.cents ?? unitCents * qty) };
      }),
      subtotalCents: p.subtotalCents,
      discount: p.discountCents ? { label: c?.label ?? "Coupon", cents: p.discountCents, ...(c?.kind === "bch" ? { tokens: `${c.tokens} ${c.symbol ?? "tokens"}`, bch: (c.sats / 1e8).toFixed(8).replace(/\.?0+$/, "") } : {}) } : null,
      shipping: p.shippingCents || p.shippingLabel ? { label: p.shippingLabel ?? "Shipping", cents: p.shippingCents ?? 0 } : null,
      taxCents: p.taxCents ?? 0,
      ...(p.otherCents ? { otherCents: p.otherCents } : {}),
      totalCents: p.totalCents,
      payment: {
        method: p.walletPlan ? "Bitcoin Cash, from a connected wallet" : "Bitcoin Cash",
        paidBch: (Number(p.paidSats ?? p.receivedSats ?? 0) / 1e8).toFixed(8).replace(/\.?0+$/, "") || "0",
        usdPerBch: p.windows?.at(-1)?.usdPerBch ?? null,
        paidTo: p.address ?? null,
        tx: p.payTxs?.[0] ?? null,
      },
      ...(reward ? { reward } : {}),
      ...(l.returns ? { returns: l.returns } : {}),
      ...(l.note ? { note: l.note } : {}),
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
    p.receipt = { name: `${await issuer.name()} #${p.number ?? p.id}`, receipt: await publicReceipt(p), state: to ? "pending" : "claimable", to, at: iso(), claimUntil: to ? null : iso(now() + claimDays * 86_400_000) };
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
