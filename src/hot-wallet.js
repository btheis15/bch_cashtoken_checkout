/**
 * The merchant's small hot wallet: its private key lives on your server, so it can send tokens by itself.
 * It holds the shop token's supply (rewards are sent from it) and a little BCH for network fees, and it
 * mints the token (src/token.js). Keep only what rewards need in it: the shop's takings go to the xPub
 * wallet, which the server can't spend from.
 *
 *   const wallet = createHotWallet({ wif: process.env.BCH_HOT_WALLET_WIF, chain });
 *
 * Make a key with newWalletKey() (or `npm run new-wallet`), store it like any other secret, and back it
 * up: it can be imported into Electron Cash or Cashonize.
 *
 * Every send goes through here one at a time. Coins just spent are left alone for ten minutes (the
 * network may not show the spend yet), and guarded coins (the token's identity output, an authbase
 * waiting to mint from) are never spent by anything but the token's own transactions.
 */
import { binToHex } from "@bitauth/libauth";
import { BchError, bchText, keyWallet, newWalletKey, walletHoldings } from "./bch.js";

export { newWalletKey };

export function createHotWallet({ wif, chain, now = () => Date.now() } = {}) {
  if (!chain) throw new Error("createHotWallet needs the chain (createBchChain()) it shares with the checkout.");
  const getWif = typeof wif === "function" ? wif : () => wif;
  let cache = null;
  const guards = new Set();
  const recentlySpent = new Map();
  let queue = Promise.resolve();

  /** The wallet from its key (null while there's no key): address (q…), tokenAddress (z…), lockingBytecode, scripthash, privateKey. */
  function info() {
    const key = getWif();
    if (!key) return null;
    if (cache?.wif !== key) cache = { wif: key, ...keyWallet(key) };
    return cache;
  }
  function must() {
    const w = info();
    if (!w) throw new BchError("There's no hot wallet key yet (make one with newWalletKey()).", { status: 409 });
    return w;
  }

  /** Coins any send may use: not just spent, never guarded. */
  async function coins() {
    const w = must();
    for (const [k, t] of recentlySpent) if (now() - t > 10 * 60_000) recentlySpent.delete(k);
    const guarded = new Set();
    for (const g of guards) for (const k of g()) guarded.add(k);
    return (await chain.utxos(w.scripthash)).filter((u) => !recentlySpent.has(`${u.txid}:${u.vout}`) && !guarded.has(`${u.txid}:${u.vout}`));
  }

  /** Sends a signed transaction; null once the network has it (taken now, or already), else the error. */
  async function broadcastOnce(hex) {
    try {
      await chain.broadcast(hex);
      return null;
    } catch (e) {
      return /already|known/i.test(e.message) ? null : e;
    }
  }

  return {
    info,
    must,
    coins,
    broadcastOnce,
    /** Sends a recorded transaction ({ hex, txid }): ok once the network has it, even if the reply was lost. */
    async sendRecorded(plan) {
      const failed = await broadcastOnce(plan.hex);
      if (!failed) return { ok: true };
      const known = await chain.transaction(plan.txid).then(
        () => true,
        () => false,
      );
      return known ? { ok: true } : { ok: false, message: failed.message };
    },
    /** Runs fn with the wallet to itself (one send at a time). */
    exclusive(fn) {
      const run = queue.then(fn, fn);
      queue = run.catch(() => {});
      return run;
    },
    /** These outpoints ("txid:vout") were just spent: left alone for a while. */
    markSpent(spends) {
      for (const k of spends) recentlySpent.set(k, now());
    },
    /** The outpoints a built transaction spends. */
    spendsOf: (built) => built.transaction.inputs.map((i) => `${binToHex(i.outpointTransactionHash)}:${i.outpointIndex}`),
    /** Registers a function returning outpoints ("txid:vout") nothing else may spend. */
    guard(fn) {
      guards.add(fn);
      return () => guards.delete(fn);
    },
    /** What it holds: { bch, sats, tokens: { category: amount } } (null when the network is slow to answer). */
    async balance(timeoutMs = 6000) {
      const w = info();
      if (!w) return null;
      try {
        const held = walletHoldings(await Promise.race([chain.utxos(w.scripthash), new Promise((_, no) => setTimeout(() => no(new Error("slow")), timeoutMs).unref?.())]));
        return { bch: bchText(held.sats), sats: held.sats, tokens: held.tokens };
      } catch {
        return null;
      }
    },
  };
}
