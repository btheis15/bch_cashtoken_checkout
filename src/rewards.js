/**
 * Rewards: cash back in the shop's own tokens after a Bitcoin Cash payment, e.g. 1 SHOP for every 0.1 BCH.
 * Turned on by giving createBchCheckout a `rewards` option (docs/rewards.md); this is its engine.
 *
 * The tokens are sent from the hot wallet (src/hot-wallet.js), which holds the supply minted once
 * (src/token.js, or any minting tool) and a little BCH for network fees.
 *
 * Where they go:
 * - Back to the wallet that paid, when it was connected (Connect wallet). That wallet holds tokens, and
 *   the payment's own inputs prove it paid.
 * - Paid from any other wallet (which may be an exchange, and would lose them): the shopper claims them
 *   on the order's page, with a connected wallet or a token address, within `claimDays`.
 *
 * Each reward is built, signed and checked by the BCH virtual machine, recorded with its transaction, and
 * only then broadcast. A retry sends that same transaction again, never a second one.
 *
 * A payment's reward (payment.reward):
 *   null (nothing earned) · { state: "pending" | "sending" | "sent" | "claimable", amount, to, txid, … }
 */
import { BchError, bchExplorerUrl, buildWalletPayment, payerLockingBytecodes, signWalletPayment, walletAddress, walletHoldings } from "./bch.js";
import { checkRewards, DEFAULT_REWARDS, tokenText } from "./tokens.js";

/**
 * The token address of the wallet that paid, when it was connected (Connect wallet) and the payment's own inputs
 * prove it: a wallet that holds tokens. Null otherwise (any other wallet might be an exchange, which would lose them).
 */
export async function connectedPayer(p, chain) {
  if (!p?.walletPlan?.address) return null;
  const plan = walletAddress(p.walletPlan.address);
  for (const txid of p.payTxs ?? []) {
    try {
      if (payerLockingBytecodes(await chain.transaction(txid)).includes(plan.lockingBytecode)) return plan.tokenAddress;
    } catch {
      /* unreadable: it's claimed instead */
    }
  }
  return null;
}

export function createRewardsEngine({ wallet, settings, chain, store, update, notice, now = () => Date.now() }) {
  if (!wallet) throw new Error("rewards needs the hot wallet (createHotWallet) that holds the tokens.");
  const fixed = typeof settings === "function" ? null : checkRewards(settings ?? {});
  const cfg = () => fixed ?? { ...DEFAULT_REWARDS, ...settings() };
  const iso = (ms = now()) => new Date(ms).toISOString();
  const day = (ms) => iso(ms).slice(0, 10);
  const text = (rw, amount = rw.amount) => `${tokenText(amount, rw)}${rw.symbol ? "" : ` ${rw.label}`}`;
  const running = (r, today) => r.enabled && /^[0-9a-f]{64}$/.test(r.category) && (!r.endsOn || today <= r.endsOn);

  /** The tokens (in the token's smallest unit) a paid amount earns, and the promotion in words. */
  function rewardFor(paidSats, r = cfg()) {
    const scale = 10 ** (r.decimals ?? 0);
    const steps = Math.floor(paidSats / Math.round(r.perBch * 1e8));
    let amount = Math.round(steps * r.tokens * scale);
    if (r.maxPerOrder) amount = Math.min(amount, Math.round(r.maxPerOrder * scale));
    return { amount, rule: `${r.tokens} ${r.symbol ?? r.label} for every ${r.perBch} BCH` };
  }

  /** After a payment counts: the reward it earns under the promotion running then (worked out once). */
  async function award(id) {
    const p = await store.getPayment(id);
    if (!p || p.reward !== undefined || p.status !== "paid") return;
    const r = cfg();
    let reward = null;
    if (running(r, day(Date.parse(p.paidAt ?? iso())))) {
      const { amount, rule } = rewardFor(p.paidSats ?? p.receivedSats ?? 0, r);
      if (amount > 0) {
        // Paid from a connected wallet: it goes straight back there (checked against the payment's own inputs).
        const to = await connectedPayer(p, chain);
        reward = { category: r.category, amount: String(amount), label: r.label, symbol: r.symbol ?? null, decimals: r.decimals ?? 0, rule, state: to ? "pending" : "claimable", to, at: iso(), claimUntil: to ? null : iso(now() + r.claimDays * 86_400_000) };
      }
    }
    await update(id, (q) => {
      if (q.reward !== undefined) return;
      q.reward = reward;
      if (reward) notice(q, "reward", reward.to ? `Earned ${text(reward)} (${reward.rule}): sending them back to the wallet that paid.` : `Earned ${text(reward)} (${reward.rule}): the shopper can claim them on their order page (paid from a wallet that can't safely be sent tokens).`);
    });
    if (reward?.to) await sendPending(id);
  }

  /** A signed transaction sending `amount` of `category` from the hot wallet to a token address (not yet broadcast). */
  async function rewardTransaction(toAddress, category, amount, unit) {
    const w = wallet.must();
    const dest = walletAddress(toAddress);
    const utxos = await wallet.coins();
    const held = walletHoldings(utxos);
    if (BigInt(held.tokens[category] ?? 0) < BigInt(amount)) throw new BchError(`The hot wallet has ${tokenText(held.tokens[category] ?? 0, unit)}${unit.symbol ? "" : " tokens"}, not enough for this (${tokenText(amount, unit)}). Send it more.`, { status: 409 });
    if (held.sats < 3000) throw new BchError("The hot wallet needs a little Bitcoin Cash for network fees (each reward uses about 0.000005 BCH: 0.0002 BCH covers about 40). Send it some.", { status: 409 });
    const built = buildWalletPayment({ wallet: { lockingBytecode: w.lockingBytecode }, utxos, payTo: dest.lockingBytecode, sats: 0, token: { category, amount: String(amount) } });
    return { ...signWalletPayment(built, w.privateKey), spends: wallet.spendsOf(built) };
  }

  const patch = (id, fields) => update(id, (q) => void (q.reward = { ...q.reward, ...fields }));

  /** Sends one payment's reward: builds and records it first, then broadcasts; a retry sends the very same one. */
  async function send(id) {
    if (!wallet.info()) return;
    let rw = (await store.getPayment(id))?.reward;
    if (!rw || !["pending", "sending"].includes(rw.state) || !rw.to) return;
    if (rw.state === "pending") {
      let t;
      try {
        t = await rewardTransaction(rw.to, rw.category, rw.amount, rw);
      } catch (e) {
        await update(id, (q) => {
          if (q.reward.error !== e.message) notice(q, "reward", `Couldn't send the reward yet: ${e.message} It goes as soon as it can.`);
          q.reward = { ...q.reward, error: e.message };
        });
        return;
      }
      wallet.markSpent(t.spends);
      await patch(id, { state: "sending", txid: t.txid, hex: t.hex, error: null, tries: 0 });
      rw = (await store.getPayment(id)).reward;
    }
    const failed = await wallet.broadcastOnce(rw.hex);
    if (failed) {
      // Not taken: on the network already after all, or spent elsewhere (then it's built again from fresh coins).
      const known = await chain.transaction(rw.txid).then(
        () => true,
        () => false,
      );
      if (!known) {
        const tries = (rw.tries ?? 0) + 1;
        if (/missing|spent|conflict|insufficient/i.test(failed.message) || tries >= 5) return patch(id, { state: "pending", txid: null, hex: null, tries: 0, error: failed.message });
        return patch(id, { tries, error: failed.message });
      }
    }
    await update(id, (q) => {
      q.reward = { ...q.reward, state: "sent", hex: null, error: null, sentAt: iso() };
      notice(q, "reward", `Sent ${text(rw)} to ${rw.to} (transaction ${rw.txid}).`);
    });
  }

  /** Every reward waiting to go (after a payment, a claim, or a top-up of the hot wallet). Run by tick(). */
  async function sendPending(onlyId = null) {
    if (!wallet.info()) return;
    const list = onlyId ? [await store.getPayment(onlyId)] : await store.listPayments({ since: iso(now() - (cfg().claimDays + 30) * 86_400_000) });
    for (const p of list) {
      const rw = p?.reward;
      if (rw && ["pending", "sending"].includes(rw.state) && rw.to) await wallet.exclusive(() => send(p.id)).catch(() => {});
    }
  }

  /** What the shopper sees of their reward on the order page. */
  function summary(p) {
    const rw = p?.reward;
    if (!rw) return null;
    const expired = rw.state === "claimable" && rw.claimUntil && Date.parse(rw.claimUntil) < now();
    return {
      text: text(rw),
      label: rw.label,
      rule: rw.rule,
      state: expired ? "expired" : rw.state === "pending" || rw.state === "sending" ? "sending" : rw.state,
      to: rw.to ?? null,
      txUrl: rw.state === "sent" && rw.txid ? bchExplorerUrl(rw.txid) : null,
      claimUntil: rw.claimUntil ?? null,
    };
  }

  /** The promotion shown while paying ("you'll earn…"), when one is running. */
  function offer() {
    const r = cfg();
    if (!running(r, day(now()))) return null;
    return { label: r.label, symbol: r.symbol ?? null, decimals: r.decimals ?? 0, perBch: r.perBch, tokens: r.tokens, maxPerOrder: r.maxPerOrder ?? null, endsOn: r.endsOn ?? null };
  }

  /** The shopper claims their reward to a wallet that holds tokens (connected, or a pasted address). */
  async function claim(id, address) {
    const p = await store.getPayment(id);
    if (!p?.reward) throw new BchError("This order has no reward to claim.", { status: 404 });
    if (p.reward.state === "claimable") {
      if (p.reward.claimUntil && Date.parse(p.reward.claimUntil) < now()) throw new BchError("The time to claim this reward has passed.", { status: 409 });
      const dest = walletAddress(address);
      await update(id, (q) => {
        if (q.reward.state !== "claimable") return;
        q.reward = { ...q.reward, to: dest.tokenAddress, state: "pending", claimedAt: iso() };
        notice(q, "reward", `The shopper claimed ${text(q.reward)} to ${dest.tokenAddress}.`);
      });
      await sendPending(id);
    }
    return { reward: summary(await store.getPayment(id)) };
  }

  /** For your admin screen: the hot wallet, its balance, the settings, and recent rewards. */
  async function status() {
    const w = wallet.info();
    const r = cfg();
    const held = w ? await wallet.balance() : null;
    const recent = (await store.listPayments({ since: iso(now() - (r.claimDays + 30) * 86_400_000) }))
      .filter((p) => p.reward)
      .sort((a, b) => (b.paidAt ?? "").localeCompare(a.paidAt ?? ""))
      .slice(0, 25)
      .map((p) => ({ id: p.id, ...summary(p), error: p.reward.error ?? null }));
    return {
      wallet: w ? { address: w.address, tokenAddress: w.tokenAddress } : null,
      balance: held ? { bch: held.bch, tokens: r.category ? text({ ...r, amount: held.tokens[r.category] ?? "0" }) : null } : null,
      settings: r,
      recent,
      waiting: recent.filter((x) => x.state === "sending").length,
    };
  }

  /** Sends some tokens from the hot wallet to an address now (to try it out). `amount` in whole tokens. */
  async function test({ address, amount } = {}) {
    const r = cfg();
    wallet.must();
    if (!/^[0-9a-f]{64}$/.test(r.category)) throw new BchError("Choose the token to give first.", { status: 409 });
    const dest = walletAddress(address);
    const base = Math.round(Number(amount ?? r.tokens) * 10 ** (r.decimals ?? 0));
    if (!(base > 0)) throw new BchError("How many tokens to send?");
    return wallet.exclusive(async () => {
      const t = await rewardTransaction(dest.tokenAddress, r.category, base, r);
      const failed = await wallet.broadcastOnce(t.hex);
      if (failed) throw new BchError(`The network didn't take it (${failed.message}).`, { status: 502 });
      wallet.markSpent(t.spends);
      return { txid: t.txid, url: bchExplorerUrl(t.txid), sent: text({ ...r, amount: base }), to: dest.tokenAddress };
    });
  }

  return { award, sendPending, summary, offer, claim, status, test, rewardFor };
}
