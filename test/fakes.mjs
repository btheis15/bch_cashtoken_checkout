/**
 * Stand-ins for the Bitcoin Cash network (as Fulcrum shows it) and the
 * exchanges' price APIs. Payments are real BCH transactions built with
 * libauth, so the checkout decodes them exactly as it would on mainnet.
 */
import { randomBytes } from "node:crypto";
import { binToHex, cashAddressToLockingBytecode, encodeTransaction, hexToBin, sha256 } from "@bitauth/libauth";

const hex = (n) => randomBytes(n).toString("hex");
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * The blockchain as a Fulcrum connection sees it. pay() sends to an address
 * (BCH, or a CashToken) and tells the address's watchers, as Fulcrum would.
 */
export function createFakeBchChain() {
  const s = { tip: 900_000, txs: new Map(), byScript: new Map(), listeners: new Set(), watched: new Set(), proofs: new Set(), down: false, calls: [] };
  const scripthashOf = (lb) => binToHex(sha256.hash(lb).reverse());
  const up = (what) => {
    s.calls.push(what);
    if (s.down) throw new Error("fake Fulcrum is down");
  };
  // A normal wallet's input: <65-byte Schnorr signature ending SIGHASH_ALL|FORKID> <33-byte public key>; or a script wallet's.
  const p2pkhInput = () => hexToBin(`41${hex(64)}41` + `21${"02"}${hex(32)}`);
  const scriptInput = () => hexToBin(`00${"41"}${hex(64)}41${"47"}${hex(71)}`);
  function pay(address, { sats = 0, token = null, notify = true, script = false } = {}) {
    const decoded = cashAddressToLockingBytecode(address);
    if (typeof decoded === "string") throw new Error(decoded);
    const lb = decoded.bytecode;
    const outputs = [];
    if (sats) outputs.push({ lockingBytecode: lb, valueSatoshis: BigInt(sats) });
    if (token)
      outputs.push({
        lockingBytecode: lb,
        valueSatoshis: 1000n,
        token: { category: hexToBin(token.category), amount: BigInt(token.amount ?? 0), ...(token.nft ? { nft: { capability: token.nft.capability ?? "none", commitment: hexToBin(token.nft.commitment ?? "") } } : {}) },
      });
    // Change back to the sender.
    outputs.push({ lockingBytecode: hexToBin(`76a914${hex(20)}88ac`), valueSatoshis: 5000n });
    const tx = { version: 2, locktime: 0, inputs: [{ outpointTransactionHash: hexToBin(hex(32)), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: script ? scriptInput() : p2pkhInput() }], outputs };
    const raw = encodeTransaction(tx);
    const txid = binToHex(sha256.hash(sha256.hash(raw)).reverse());
    const sh = scripthashOf(lb);
    s.txs.set(txid, { hex: binToHex(raw), height: 0, sh });
    s.byScript.set(sh, [...(s.byScript.get(sh) ?? []), txid]);
    if (notify) tell(sh);
    return txid;
  }
  function tell(sh) {
    if (s.watched.has(sh)) for (const fn of s.listeners) fn(sh);
  }
  /** The transaction is now in a block, depth deep. */
  function confirm(txid, depth = 1) {
    const t = s.txs.get(txid);
    t.height = s.tip - depth + 1;
    tell(t.sh);
  }
  /** The transaction vanishes from the mempool (double-spent or dropped). */
  function drop(txid) {
    const t = s.txs.get(txid);
    s.byScript.set(t.sh, s.byScript.get(t.sh).filter((x) => x !== txid));
    s.txs.delete(txid);
    tell(t.sh);
  }
  return {
    state: s,
    pay,
    confirm,
    drop,
    proof: (txid) => s.proofs.add(txid),
    // The interface createBchCheckout uses (as src/bch.js createBchChain).
    server: () => "fake.fulcrum",
    async tip() {
      up("tip");
      return s.tip;
    },
    async history(sh) {
      up(`history:${sh}`);
      return (s.byScript.get(sh) ?? []).map((txid) => ({ txid, height: s.txs.get(txid).height }));
    },
    async transaction(txid) {
      up(`tx:${txid}`);
      const t = s.txs.get(txid);
      if (!t) throw new Error("unknown transaction");
      return t.hex;
    },
    async dsproof(txid) {
      return s.proofs.has(txid) ? { dspid: hex(32), txid } : null;
    },
    watch: (sh) => s.watched.add(sh),
    unwatch: (sh) => s.watched.delete(sh),
    onActivity(fn) {
      s.listeners.add(fn);
      return () => s.listeners.delete(fn);
    },
    async close() {},
  };
}

/** The four exchanges' price APIs (src/bch.js PRICE_SOURCES), each at usd (or set one with set()). */
export function createFakeBchPrices({ usd = 400 } = {}) {
  const s = { usd: { Coinbase: usd, Kraken: usd, Bitstamp: usd, CoinGecko: usd }, down: new Set(), calls: 0 };
  async function fetchImpl(url) {
    s.calls++;
    const u = String(url);
    const name = u.includes("coinbase") ? "Coinbase" : u.includes("kraken") ? "Kraken" : u.includes("bitstamp") ? "Bitstamp" : u.includes("coingecko") ? "CoinGecko" : null;
    if (!name || s.down.has(name)) throw new TypeError("fetch failed");
    const v = s.usd[name];
    const body = name === "Coinbase" ? { data: { amount: String(v), base: "BCH", currency: "USD" } } : name === "Kraken" ? { error: [], result: { BCHUSD: { c: [String(v), "1"] } } } : name === "Bitstamp" ? { last: String(v) } : { "bitcoin-cash": { usd: v } };
    return jsonRes(200, body);
  }
  return {
    state: s,
    fetch: fetchImpl,
    set(value, only = null) {
      for (const k of Object.keys(s.usd)) if (!only || only.includes(k)) s.usd[k] = value;
    },
  };
}

