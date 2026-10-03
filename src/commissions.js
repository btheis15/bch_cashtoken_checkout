/**
 * Commissions for sales partners (affiliates): someone who sells for you earns a share of each order paid through
 * their link, paid in BCH at the moment you're paid. Turned on by giving createBchCheckout a `commissions` option
 * (docs/commissions.md); this is its engine. Who your partners are, their links and their rates live in your own
 * database: start() is given the order's partner, if any.
 *
 * The share is `ratePercent` of the items as sold (subtotalCents: your sale prices), after any coupon; never
 * shipping or tax. How it's paid:
 * - Connect wallet: the shopper's one transaction pays your share to the order's address and the partner's to
 *   them (walletBuild adds the second output). The partner's output counts toward the order only up to their
 *   share, so paying the partner extra doesn't pay the order.
 * - Any other wallet (a QR code holds one address): you get it all, and the partner's share is sent from the hot
 *   wallet (src/hot-wallet.js) as soon as the payment counts. A payment double-spend proofs can't vouch for (a
 *   double-spend proof was seen, or a script wallet paid) waits for one block first.
 *
 * Optional, per partner at start(): `maxCents` (the most this order may earn them, e.g. what's left of a yearly
 * limit), `owedCents` (what they owe you, e.g. from a refunded order: it comes off first). An `isBlocked(address)`
 * check (e.g. createSanctions().isBlocked, src/sanctions.js) stops payouts to a listed address. Each commission is
 * reported once it's settled through onCommission(payment, commission), for your records.
 *
 * A payout from the hot wallet is built, signed, recorded and only then broadcast; a retry sends the very same
 * transaction, so a lost reply never pays twice.
 *
 * A payment's commission (payment.commission):
 *   { partnerId, address, ratePercent, baseCents, earnedCents, offsetCents, cents, sats, usdPerBch,
 *     how: "split" | "wallet", state: "pending" | "sending" | "sent" | "cancelled", txid, waiting, note }
 */
import { hexToBin } from "@bitauth/libauth";
import { BchError, bchExplorerUrl, bchText, buildFromWallet, signWalletPayment, walletAddress } from "./bch.js";

// Smaller than this isn't worth an output of its own (the network's dust limit is 546).
const MIN_SATS = 1000;

/** Why a commission hasn't gone yet. */
export const COMMISSION_WAITING = {
  block: "Waiting for one block: the payment had a double-spend proof, or came from a wallet proofs don't cover.",
  wallet: "The hot wallet needs more Bitcoin Cash.",
  setup: "There's no hot wallet key yet.",
};

/** Checks the partner given to start(): { id, address, ratePercent, maxCents?, owedCents? }. */
export function checkPartner(partner) {
  if (!partner) return null;
  const rate = Number(partner.ratePercent);
  if (!partner.id || !(rate > 0 && rate <= 50)) throw new BchError("A partner needs an id and a ratePercent from 0 to 50.");
  const a = walletAddress(partner.address);
  const cents = (v) => (v === null || v === undefined ? null : Math.max(0, Math.floor(Number(v)) || 0));
  return { id: String(partner.id), address: a.address, ratePercent: rate, maxCents: cents(partner.maxCents), owedCents: cents(partner.owedCents) ?? 0 };
}

export function createCommissionsEngine({ wallet, isBlocked = () => false, onCommission = () => {}, store, update, notice, now = () => Date.now() }) {
  if (!wallet) throw new Error("commissions needs the hot wallet (createHotWallet) that pays partners when the shopper's payment can't.");
  const iso = (ms = now()) => new Date(ms).toISOString();
  const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

  /** The partner's share in cents with `discountCents` off the items: earned (capped), offset (repaying what they owe), and paid. */
  function shareOf(p, discountCents = p.discountCents) {
    const partner = p.partner;
    const baseCents = Math.max(0, p.subtotalCents - discountCents);
    const share = Math.round((baseCents * partner.ratePercent) / 100);
    const earnedCents = partner.maxCents === null ? share : Math.min(share, partner.maxCents);
    const offsetCents = Math.min(partner.owedCents, earnedCents);
    return { baseCents, earnedCents, offsetCents, cents: earnedCents - offsetCents };
  }

  /** Connect wallet: the partner's share as a second output of the shopper's transaction, or null. */
  function splitFor(p, usdPerBch, discountCents) {
    if (!p.partner || isBlocked(p.partner.address)) return null;
    const s = shareOf(p, discountCents);
    const sats = Math.round((s.cents / 100 / usdPerBch) * 1e8);
    if (sats < MIN_SATS) return null;
    return { ...s, address: p.partner.address, lockingBytecode: walletAddress(p.partner.address).lockingBytecode, sats, usdPerBch };
  }

  const report = (p) => Promise.resolve(onCommission(structuredClone(p), structuredClone(p.commission))).catch(() => {});

  /** After a payment counts: its commission, at once (already in the payment, or sent now from the hot wallet). */
  async function settle(id) {
    let p = await store.getPayment(id);
    if (!p?.partner || p.commission !== undefined || p.status !== "paid") return;
    const split = p.walletPlan?.split ?? null;
    const splitPaid = Object.entries(p.txs ?? {}).filter(([, t]) => t.split > 0);
    p = await update(id, (q) => {
      if (q.commission !== undefined) return;
      const base = { partnerId: q.partner.id, address: q.partner.address, ratePercent: q.partner.ratePercent, at: iso() };
      if (split && splitPaid.reduce((n, [, t]) => n + t.split, 0) >= split.sats) {
        q.commission = { ...base, baseCents: split.baseCents, earnedCents: split.earnedCents, offsetCents: split.offsetCents, cents: split.cents, sats: split.sats, usdPerBch: split.usdPerBch, how: "split", state: "sent", txid: splitPaid[0][0], sentAt: iso() };
        notice(q, "commission", `Partner ${q.partner.id}'s ${q.partner.ratePercent}% (${usd(split.cents)}, ${bchText(split.sats)} BCH) went straight to them in the shopper's payment.`);
        return;
      }
      const s = shareOf(q);
      const usdPerBch = q.windows.at(-1).usdPerBch;
      const blocked = isBlocked(q.partner.address);
      const state = blocked || s.cents <= 0 ? "cancelled" : "pending";
      const note = blocked ? "Not sent: the partner's payout address is blocked (isBlocked)." : s.cents <= 0 ? (s.offsetCents ? "All of it repaid what the partner owed." : "Nothing earned (the partner's limit).") : null;
      q.commission = { ...base, ...s, sats: null, usdPerBch, how: "wallet", state, txid: null, note };
      notice(q, "commission", state === "pending" ? `Partner ${q.partner.id}'s ${q.partner.ratePercent}% of ${usd(s.baseCents)} is ${usd(s.cents)}: sending it from the hot wallet.` : `Partner ${q.partner.id}: no commission sent. ${note}`);
    });
    if (p.commission?.state === "sent" || p.commission?.state === "cancelled") return report(p);
    await sendPending(id);
  }

  /** A payment to wait one block for before paying from the hot wallet. */
  const risky = (p) => !(p.confirmations >= 1) && Boolean(p.held || (p.problems ?? []).some((x) => ["dropped", "unprotected"].includes(x.kind)) || Object.values(p.txs ?? {}).some((t) => t.sats > 0 && t.covered === false));
  const patch = (id, fields) => update(id, (q) => void (q.commission = { ...q.commission, ...fields }));

  /** Sends one payment's commission from the hot wallet: built and recorded first, then broadcast. */
  async function send(id) {
    let p = await store.getPayment(id);
    let c = p?.commission;
    if (!c || !["pending", "sending"].includes(c.state)) return;
    if (c.state === "pending") {
      if (isBlocked(c.address)) {
        p = await patch(id, { state: "cancelled", waiting: null, note: "Not sent: the partner's payout address is blocked (isBlocked)." });
        return report(p);
      }
      if (risky(p)) return void (c.waiting !== "block" && (await patch(id, { waiting: "block" })));
      const w = wallet.info();
      if (!w) return void (c.waiting !== "setup" && (await patch(id, { waiting: "setup" })));
      const sats = Math.round((c.cents / 100 / c.usdPerBch) * 1e8);
      if (sats < MIN_SATS) {
        p = await patch(id, { state: "cancelled", waiting: null, note: "Too small to send on its own." });
        return report(p);
      }
      let built;
      try {
        built = buildFromWallet({ wallet: w, utxos: await wallet.coins(), outputs: [{ lockingBytecode: hexToBin(walletAddress(c.address).lockingBytecode), valueSatoshis: BigInt(sats) }] });
      } catch (e) {
        await update(id, (q) => {
          if (q.commission.waiting !== "wallet") notice(q, "commission", `Couldn't send the partner's commission yet: ${e.message} It goes as soon as the hot wallet has enough.`);
          q.commission = { ...q.commission, waiting: "wallet", error: e.message };
        });
        return;
      }
      const signed = signWalletPayment(built, w.privateKey);
      wallet.markSpent(wallet.spendsOf(built));
      p = await patch(id, { state: "sending", waiting: null, error: null, sats, txid: signed.txid, hex: signed.hex, tries: 0 });
      c = p.commission;
    }
    const failed = await wallet.broadcastOnce(c.hex);
    if (failed) {
      const known = await wallet.sendRecorded({ hex: c.hex, txid: c.txid }).then((r) => r.ok);
      if (!known) {
        const tries = (c.tries ?? 0) + 1;
        // Its coins were spent elsewhere (or it keeps failing): built again from fresh coins next time.
        if (/missing|spent|conflict|insufficient/i.test(failed.message) || tries >= 5) return void (await patch(id, { state: "pending", txid: null, hex: null, sats: null, tries: 0, error: failed.message }));
        return void (await patch(id, { tries, error: failed.message }));
      }
    }
    p = await update(id, (q) => {
      q.commission = { ...q.commission, state: "sent", hex: null, error: null, sentAt: iso() };
      notice(q, "commission", `Sent the partner's commission: ${bchText(c.sats)} BCH (${usd(c.cents)}) to ${c.address} (transaction ${c.txid}).`);
    });
    await report(p);
  }

  /** Every commission still to send (right after a payment, and from tick() in case one waited). */
  async function sendPending(onlyId = null) {
    const list = onlyId ? [await store.getPayment(onlyId)] : await store.listPayments({ since: iso(now() - 30 * 86_400_000) });
    for (const p of list) if (p?.commission && ["pending", "sending"].includes(p.commission.state)) await wallet.exclusive(() => send(p.id)).catch(() => {});
  }

  /** What the order's page and your admin show. */
  function summary(p) {
    const c = p.commission;
    if (!c) return p.partner ? { partnerId: p.partner.id, state: "unpaid" } : null;
    return { partnerId: c.partnerId, ratePercent: c.ratePercent, baseCents: c.baseCents, cents: c.cents, offsetCents: c.offsetCents, bch: c.sats ? bchText(c.sats) : null, how: c.how, state: c.state, waiting: c.state === "pending" && c.waiting ? COMMISSION_WAITING[c.waiting] : null, note: c.note ?? null, txUrl: c.state === "sent" ? bchExplorerUrl(c.txid) : null, yourCents: p.totalCents - (c.state === "cancelled" ? 0 : c.cents) };
  }

  return { splitFor, settle, sendPending, summary };
}
