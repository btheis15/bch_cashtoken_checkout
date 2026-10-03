/**
 * Stand-ins for the Bitcoin Cash network (as Fulcrum shows it) and the
 * exchanges' price APIs. Payments are real BCH transactions built with
 * libauth, so the checkout decodes them exactly as it would on mainnet.
 */
import { randomBytes } from "node:crypto";
import {
  binToHex,
  cashAddressToLockingBytecode,
  createVirtualMachineBCH,
  decodeTransaction,
  encodeCashAddress,
  encodeLockingBytecodeP2pkh,
  encodeTransaction,
  generateSigningSerializationBCH,
  hash160,
  hexToBin,
  secp256k1,
  sha256,
} from "@bitauth/libauth";

const hex = (n) => randomBytes(n).toString("hex");
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * The blockchain as a Fulcrum connection sees it. pay() sends to an address
 * (BCH, or a CashToken) and tells the address's watchers, as Fulcrum would.
 */
export function createFakeBchChain() {
  const s = { tip: 900_000, txs: new Map(), byScript: new Map(), coins: new Map(), listeners: new Set(), watched: new Set(), proofs: new Set(), down: false, calls: [], broadcasts: [], rejectBroadcast: null };
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
  /** Coins in a wallet (what listunspent shows for the address). */
  function fund(address, { sats = 0, token = null } = {}) {
    const decoded = cashAddressToLockingBytecode(address);
    const sh = scripthashOf(decoded.bytecode);
    const coin = { txid: hex(32), vout: 0, sats, height: s.tip - 3, token: token ? { category: token.category, amount: String(token.amount), nft: token.nft ?? null } : null };
    s.coins.set(sh, [...(s.coins.get(sh) ?? []), coin]);
    return coin;
  }
  /** A signed transaction reaches the mempool: what it spends is gone, what it pays shows up (and is told). */
  function accept(hexTx) {
    const tx = decodeTransaction(hexToBin(hexTx));
    if (typeof tx === "string") throw new Error(tx);
    const txid = binToHex(sha256.hash(sha256.hash(hexToBin(hexTx))).reverse());
    if (s.txs.has(txid)) throw new Error("txn-already-known");
    for (const i of tx.inputs) for (const [sh, list] of s.coins) s.coins.set(sh, list.filter((c) => !(c.txid === binToHex(i.outpointTransactionHash) && c.vout === i.outpointIndex)));
    const told = new Set();
    tx.outputs.forEach((o, vout) => {
      const sh = scripthashOf(o.lockingBytecode);
      if (!told.has(sh)) {
        s.byScript.set(sh, [...(s.byScript.get(sh) ?? []), txid]);
        told.add(sh);
      }
      s.coins.set(sh, [...(s.coins.get(sh) ?? []), { txid, vout, sats: Number(o.valueSatoshis), height: 0, token: o.token ? { category: binToHex(o.token.category), amount: String(o.token.amount), nft: null } : null }]);
    });
    s.txs.set(txid, { hex: hexTx, height: 0, sh: [...told][0] });
    for (const sh of told) tell(sh);
    return txid;
  }
  return {
    state: s,
    pay,
    fund,
    confirm,
    drop,
    async utxos(sh) {
      up(`utxos:${sh}`);
      return (s.coins.get(sh) ?? []).map((c) => ({ ...c }));
    },
    async broadcast(hexTx) {
      up("broadcast");
      if (s.rejectBroadcast) throw new Error(s.rejectBroadcast);
      s.broadcasts.push(hexTx);
      return accept(hexTx);
    },
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

/**
 * A shopper's wallet as BCH WalletConnect wallets (Cashonize, Paytaca) behave: its address, and signing a
 * bch_signTransaction request (inputs with empty unlocking bytecode are its own) with a Schnorr signature.
 * verify() runs the signed transaction through the BCH virtual machine, so a payment the network would
 * refuse (a burned token, a bad signature, too little fee) fails the test.
 */
export function createFakeWallet(seed = 7) {
  const priv = sha256.hash(new Uint8Array([seed]));
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  const pkh = hash160(pub);
  const lockingBytecode = encodeLockingBytecodeP2pkh(pkh);
  const address = encodeCashAddress({ prefix: "bitcoincash", type: "p2pkh", payload: pkh }).address;
  const revive = (json) =>
    JSON.parse(JSON.stringify(json), (_k, v) => {
      if (typeof v !== "string") return v;
      const big = /^<bigint: (\d+)n>$/.exec(v);
      if (big) return BigInt(big[1]);
      const bytes = /^<Uint8Array: 0x([0-9a-f]*)>$/.exec(v);
      return bytes ? hexToBin(bytes[1]) : v;
    });
  function sign(request) {
    const { transaction, sourceOutputs } = revive(request);
    const SIGHASH = 0x41; // ALL | FORKID (with the source outputs' tokens, as BCH has since 2023)
    transaction.inputs.forEach((input, i) => {
      if (input.unlockingBytecode.length) return;
      const serialization = generateSigningSerializationBCH({ inputIndex: i, sourceOutputs, transaction }, { coveredBytecode: sourceOutputs[i].lockingBytecode, signingSerializationType: new Uint8Array([SIGHASH]) });
      const sig = secp256k1.signMessageHashSchnorr(priv, sha256.hash(sha256.hash(serialization)));
      input.unlockingBytecode = new Uint8Array([65, ...sig, SIGHASH, 33, ...pub]);
    });
    return { transaction, sourceOutputs, hex: binToHex(encodeTransaction(transaction)) };
  }
  const verify = ({ transaction, sourceOutputs }) => createVirtualMachineBCH().verify({ sourceOutputs, transaction });
  return { address, lockingBytecode: binToHex(lockingBytecode), sign, verify, revive };
}
