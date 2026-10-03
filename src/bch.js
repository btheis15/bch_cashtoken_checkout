/**
 * Bitcoin Cash, watched by your own server: no payment company.
 *
 *   wallet  The merchant's wallet xPub (its extended *public* key: it can list
 *           the wallet's addresses but can never spend). Each order gets its
 *           own receiving address, xpub/0/<index> (BIP44; what Selene and
 *           Electron Cash show as receiving addresses).
 *   prices  BCH in USD from several exchanges; a price is only used when at
 *           least two of them agree.
 *   chain   Fulcrum (Electrum protocol) servers, run by the BCH community:
 *           an address's history, unspent coins and transactions, block
 *           height, double-spend proofs, broadcasting, and a notice when an
 *           address is paid. Token (CashTokens) outputs are read too, for
 *           coupons and rewards.
 *   wallets The shopper's wallet over WalletConnect (one transaction with the
 *           BCH and any tokens), and the merchant's small hot wallet (its key
 *           on the server) that sends rewards and mints the shop's token.
 *
 * Checked 2026-10: libauth 3.0.0 (decodeHdPublicKey, deriveHdPathRelative,
 * encodeCashAddress p2pkh / p2pkhWithTokens, decodeTransaction with token
 * data), @electrum-cash/network 4.4.8 (request() *returns* errors), the
 * Electrum Cash protocol (electrum-cash-protocol.readthedocs.io): get_history
 * gives height 0 (or -1 with unconfirmed parents) while in the mempool;
 * blockchain.transaction.dsproof.get(txid) returns the double-spend proof
 * for the transaction or any of its mempool ancestors, or null (protocol
 * 1.4.5, Fulcrum 1.5+; server.features.dsproof says whether a server has
 * it). Double-spend proofs (upgradespecs.bitcoincashnode.org/dsproof) cover
 * payments whose inputs are P2PKH signed SIGHASH_ALL without ANYONECANPAY.
 */
import {
  binToHex,
  cashAddressToLockingBytecode,
  createVirtualMachineBCH,
  decodeAuthenticationInstructions,
  decodeHdPublicKey,
  decodePrivateKeyWif,
  decodeTransaction,
  deriveHdPathRelative,
  encodeCashAddress,
  encodeLockingBytecodeP2pkh,
  encodePrivateKeyWif,
  encodeTransaction,
  generatePrivateKey,
  generateSigningSerializationBCH,
  hash160,
  hexToBin,
  lockingBytecodeToCashAddress,
  secp256k1,
  sha256,
  stringify,
} from "@bitauth/libauth";
import { randomBytes } from "node:crypto";
import { ElectrumClient } from "@electrum-cash/network";

export const SATS = 100_000_000;

/** Something the shopper or merchant should be told. `status` is the HTTP status that fits (default 400). */
export class BchError extends Error {
  constructor(message, { status, errors } = {}) {
    super(message);
    this.status = status ?? 400;
    if (errors) this.errors = errors;
  }
}

// --- Wallet ----------------------------------------------------------------------

/** Throws BchError unless it's a usable mainnet xPub (and never an xprv). */
export function parseXpub(raw) {
  const xpub = String(raw ?? "").trim();
  if (/^[xtyz]prv/i.test(xpub)) throw new BchError("That's your wallet's private key: never share it with anyone. Paste the xPub (extended public key) instead.");
  if (!/^xpub[1-9A-HJ-NP-Za-km-z]{100,112}$/.test(xpub)) throw new BchError("An xPub starts with “xpub” and is about 111 characters long.");
  const decoded = decodeHdPublicKey(xpub);
  if (typeof decoded === "string") throw new BchError(`That xPub can't be read (${decoded.replace(/^HD key decoding error: /, "")}).`);
  if (decoded.network !== "mainnet") throw new BchError("That's a test-network key. Use your real wallet's xPub.");
  return { xpub, node: decoded.node, id: binToHex(sha256.hash(new TextEncoder().encode(xpub))).slice(0, 16) };
}

/** Receiving address <index> of the wallet: q… for BCH, z… (the same address) for tokens. */
export function addressAt(wallet, index) {
  const child = deriveHdPathRelative(wallet.node, `0/${index}`);
  if (typeof child === "string") throw new BchError(child);
  const pkh = hash160(child.publicKey);
  const lockingBytecode = encodeLockingBytecodeP2pkh(pkh);
  return {
    index,
    address: encodeCashAddress({ prefix: "bitcoincash", type: "p2pkh", payload: pkh }).address,
    tokenAddress: encodeCashAddress({ prefix: "bitcoincash", type: "p2pkhWithTokens", payload: pkh }).address,
    lockingBytecode: binToHex(lockingBytecode),
    // Electrum's address key: the locking bytecode's SHA-256, byte-reversed.
    scripthash: binToHex(sha256.hash(lockingBytecode).reverse()),
  };
}

// --- Amounts ---------------------------------------------------------------------

/** "0.16948123" for 16948123 sats (no trailing zeros). */
export const bchText = (sats) => (Number(sats) / SATS).toFixed(8).replace(/\.?0+$/, "") || "0";

/**
 * The sats for a USD amount at a price, rounded up (the merchant is never paid short by rounding). Cents × 10^6
 * is exact, and float noise below a millionth of a satoshi is ignored ($5.40 at $400 is 1,350,000, not 1,350,001).
 */
export const satsFor = (cents, usdPerBch) => Math.ceil((cents * (SATS / 100)) / usdPerBch - 1e-6);

/** bitcoincash:q…?amount=…&message=… (BIP21); for a token address, c=/f= ask for a token (CashTokens payment requests). */
export function paymentUri(address, { sats, message, category, tokenAmount } = {}) {
  const q = [];
  if (sats) q.push(`amount=${bchText(sats)}`);
  if (category) q.push(`c=${category}`);
  if (category && tokenAmount) q.push(`f=${tokenAmount}`);
  if (message) q.push(`message=${encodeURIComponent(message)}`);
  return q.length ? `${address}?${q.join("&")}` : address;
}

// --- Prices ----------------------------------------------------------------------

export const PRICE_SOURCES = [
  { name: "Coinbase", url: "https://api.coinbase.com/v2/prices/BCH-USD/spot", read: (d) => d?.data?.amount },
  { name: "Kraken", url: "https://api.kraken.com/0/public/Ticker?pair=BCHUSD", read: (d) => d?.result?.BCHUSD?.c?.[0] },
  { name: "Bitstamp", url: "https://www.bitstamp.net/api/v2/ticker/bchusd/", read: (d) => d?.last },
  { name: "CoinGecko", url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd", read: (d) => d?.["bitcoin-cash"]?.usd },
];

/**
 * The BCH price in USD: the middle of the exchanges that answer, used only
 * when at least two agree within maxSpread. Cached briefly.
 */
export function createBchPrices({ fetchImpl = fetch, now = Date.now, sources = PRICE_SOURCES, maxSpread = 0.015, cacheMs = 60_000 } = {}) {
  let cached = null;
  let pending = null;
  async function ask(source) {
    const res = await fetchImpl(source.url, { headers: { Accept: "application/json", "User-Agent": "bch-cashtoken-checkout/1.0" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${res.status}`);
    const n = Number(source.read(await res.json()));
    if (!(n > 1 && n < 1_000_000)) throw new Error("no price");
    return { name: source.name, usd: n };
  }
  async function fresh() {
    const answers = (await Promise.allSettled(sources.map(ask))).filter((r) => r.status === "fulfilled").map((r) => r.value);
    const sorted = answers.map((a) => a.usd).sort((a, b) => a - b);
    if (sorted.length < 2) throw new BchError("Couldn't get the Bitcoin Cash price from at least two exchanges.");
    const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const agreeing = answers.filter((a) => Math.abs(a.usd - mid) / mid <= maxSpread);
    if (agreeing.length < 2) throw new BchError("The exchanges disagree about the Bitcoin Cash price right now.");
    return { usd: Math.round(mid * 100) / 100, sources: agreeing.map((a) => a.name), at: new Date(now()).toISOString() };
  }
  return {
    async usdPerBch() {
      if (cached && now() - Date.parse(cached.at) < cacheMs) return cached;
      pending ??= fresh().finally(() => (pending = null));
      cached = await pending;
      return cached;
    },
    last: () => cached,
  };
}

// --- Transactions ----------------------------------------------------------------

/**
 * True when double-spend proofs can cover the input: a P2PKH spend (a
 * signature and a public key) signed SIGHASH_ALL with FORKID, without
 * ANYONECANPAY (the 2023 SIGHASH_UTXOS flag is allowed).
 */
function coveredInput(unlockingBytecode) {
  const ops = decodeAuthenticationInstructions(unlockingBytecode);
  if (ops.length !== 2 || ops.some((op) => !op.data)) return false;
  const [sig, key] = ops.map((op) => op.data);
  if (!(sig.length === 65 || (sig.length >= 9 && sig.length <= 73)) || !(key.length === 33 || key.length === 65)) return false;
  const type = sig[sig.length - 1];
  return (type & 0x1f) === 0x01 && (type & 0x40) !== 0 && (type & 0x80) === 0;
}

/**
 * What a transaction (raw hex) pays to a locking bytecode: BCH in plain
 * outputs, and any token outputs (category, fungible amount, NFT); and
 * whether double-spend proofs cover all its inputs.
 */
export function readPayment(hex, lockingBytecode) {
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === "string") throw new BchError(`Unreadable transaction (${tx}).`);
  const covered = tx.inputs.every((i) => coveredInput(i.unlockingBytecode));
  let sats = 0;
  const tokens = [];
  tx.outputs.forEach((o, vout) => {
    if (binToHex(o.lockingBytecode) !== lockingBytecode) return;
    if (o.token) {
      tokens.push({
        vout,
        sats: Number(o.valueSatoshis),
        category: binToHex(o.token.category),
        amount: String(o.token.amount ?? 0n),
        nft: o.token.nft ? { capability: o.token.nft.capability, commitment: binToHex(o.token.nft.commitment) } : null,
      });
    } else sats += Number(o.valueSatoshis);
  });
  return { sats, tokens, covered };
}

// --- Chain (Fulcrum) -------------------------------------------------------------

export const FULCRUM_SERVERS = ["bch.imaginary.cash", "cashnode.bch.ninja", "fulcrum.greyh.at", "bch.loping.net", "electrum.imaginary.cash"];

const within = (p, ms, what) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new BchError(`${what} took too long.`)), ms).unref?.())]);

/**
 * A connection to one Fulcrum server at a time (the next one is tried if it
 * fails). onActivity(scripthash) is called when a watched address changes.
 */
export function createBchChain({ servers = FULCRUM_SERVERS, makeClient = (host) => new ElectrumClient("bch-cashtoken-checkout", "1.5", host, { port: 50004, encrypted: true, timeoutInMilliSeconds: 10_000 }), log = () => {} } = {}) {
  let client = null;
  let connecting = null;
  let next = 0;
  let host = null;
  let proofs = null;
  const watched = new Set();
  const listeners = new Set();
  const txCache = new Map();

  async function open() {
    let lastError = null;
    let fallback = null;
    for (let tries = 0; tries < servers.length; tries++) {
      const h = servers[next % servers.length];
      next++;
      const c = makeClient(h);
      try {
        await within(c.connect(), 12_000, `Connecting to ${h}`);
        // Double-spend proofs are what make zero-conf safe: a server without them is only a last resort.
        const features = await within(c.request("server.features"), 10_000, "server.features").catch(() => null);
        const hasProofs = !(features instanceof Error) && features?.dsproof === true;
        if (!hasProofs && tries < servers.length - 1) {
          if (fallback) c.disconnect(true).catch(() => {});
          else fallback = { c, h };
          continue;
        }
        if (fallback && fallback.c !== c) fallback.c.disconnect(true).catch(() => {});
        proofs = hasProofs;
        c.on("notification", (n) => {
          if (n?.method === "blockchain.scripthash.subscribe" && Array.isArray(n.params)) for (const fn of listeners) fn(String(n.params[0]));
        });
        c.on("disconnected", () => {
          // Replaced by a fresh connection on the next call (this one isn't left reconnecting by itself).
          if (client === c) client = null;
          c.disconnect(true).catch(() => {});
        });
        for (const sh of watched) await c.subscribe("blockchain.scripthash.subscribe", sh).catch(() => {});
        host = h;
        log(`[bch] connected to ${h}${hasProofs ? "" : " (without double-spend proofs)"}`);
        return c;
      } catch (e) {
        lastError = e;
        log(`[bch] ${h}: ${e.message}`);
        c.disconnect(true).catch(() => {});
      }
    }
    if (fallback) {
      // Nothing better answered: the one without proofs, rather than none.
      const { c, h } = fallback;
      c.on("notification", (n) => {
        if (n?.method === "blockchain.scripthash.subscribe" && Array.isArray(n.params)) for (const fn of listeners) fn(String(n.params[0]));
      });
      c.on("disconnected", () => {
        if (client === c) client = null;
        c.disconnect(true).catch(() => {});
      });
      for (const sh of watched) await c.subscribe("blockchain.scripthash.subscribe", sh).catch(() => {});
      host = h;
      proofs = false;
      log(`[bch] connected to ${h} (without double-spend proofs)`);
      return c;
    }
    throw new BchError(`Couldn't reach a Bitcoin Cash server (${lastError?.message ?? "no servers"}).`);
  }
  async function connected() {
    if (client) return client;
    connecting ??= open().then((c) => (client = c)).finally(() => (connecting = null));
    return connecting;
  }
  async function call(method, ...params) {
    const c = await connected();
    let r;
    try {
      r = await within(c.request(method, ...params), 15_000, method);
    } catch (e) {
      // A server that stops answering is dropped; the next call tries another.
      if (client === c) client = null;
      c.disconnect(true).catch(() => {});
      throw e instanceof BchError ? e : new BchError(e.message);
    }
    if (r instanceof Error) throw new BchError(r.message);
    return r;
  }

  return {
    server: () => host,
    async tip() {
      const r = await call("blockchain.headers.get_tip");
      return Number(r?.height);
    },
    /** [{ txid, height }]; height 0 or -1: still in the mempool. */
    async history(scripthash) {
      const r = await call("blockchain.scripthash.get_history", scripthash);
      return (Array.isArray(r) ? r : []).map((x) => ({ txid: String(x.tx_hash), height: Number(x.height) }));
    },
    /** The raw transaction (hex); transactions never change, so they're kept. */
    async transaction(txid) {
      if (txCache.has(txid)) return txCache.get(txid);
      const hex = String(await call("blockchain.transaction.get", txid));
      txCache.set(txid, hex);
      if (txCache.size > 2000) txCache.delete(txCache.keys().next().value);
      return hex;
    },
    /**
     * The double-spend proof for the transaction (or a mempool ancestor) if the network has one,
     * null if it has none, or undefined when it can't be told (no answer, or a server without proofs).
     */
    async dsproof(txid) {
      try {
        await connected();
        if (!proofs) return undefined;
        return (await call("blockchain.transaction.dsproof.get", txid)) || null;
      } catch {
        return undefined;
      }
    },
    /** The address's unspent coins: [{ txid, vout, sats, height, token: { category, amount, nft } | null }]. */
    async utxos(scripthash) {
      const r = await call("blockchain.scripthash.listunspent", scripthash);
      return (Array.isArray(r) ? r : []).map((u) => ({
        txid: String(u.tx_hash),
        vout: Number(u.tx_pos),
        sats: Number(u.value),
        height: Number(u.height),
        token: u.token_data
          ? { category: String(u.token_data.category), amount: String(u.token_data.amount ?? "0"), nft: u.token_data.nft ? { capability: String(u.token_data.nft.capability), commitment: String(u.token_data.nft.commitment ?? "") } : null }
          : null,
      }));
    },
    /** Sends a signed transaction (hex) to the network; its txid. */
    async broadcast(hex) {
      return String(await call("blockchain.transaction.broadcast", hex));
    },
    /** Whether the current server relays double-spend proofs (null before connecting). */
    hasProofs: () => proofs,
    watch(scripthash) {
      if (watched.has(scripthash)) return;
      watched.add(scripthash);
      client?.subscribe("blockchain.scripthash.subscribe", scripthash).catch(() => {});
    },
    unwatch(scripthash) {
      if (!watched.delete(scripthash)) return;
      client?.unsubscribe("blockchain.scripthash.subscribe", scripthash).catch(() => {});
    },
    onActivity(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async close() {
      const c = client;
      client = null;
      await c?.disconnect(true).catch(() => {});
    },
  };
}

// --- Token names (BCMR) ----------------------------------------------------------

/** A token's name and symbol from Paytaca's BCMR index (what Cashonize, Paytaca and Electron Cash show). */
export async function tokenInfo(category, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`https://bcmr.paytaca.com/api/tokens/${category}/`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const d = await res.json();
    const name = String(d?.name ?? "").slice(0, 80) || null;
    const symbol = String(d?.token?.symbol ?? d?.symbol ?? "").slice(0, 20) || null;
    const decimals = Number(d?.token?.decimals ?? d?.decimals ?? 0) || 0;
    const icon = String(d?.uris?.icon ?? d?.icon ?? "");
    return { name, symbol, decimals, icon: /^https:\/\//.test(icon) ? icon : null };
  } catch {
    return null;
  }
}

// --- Paying from a connected wallet (BCH WalletConnect: github.com/mainnet-pat/wc2-bch-bcr) ----------
//
// The shop proposes the whole payment as one transaction: the BCH to the order's address and, in the
// same transaction, any tokens the shopper chose to spend. The wallet signs its own inputs (left with
// empty unlocking bytecode), sends it, and hands the signed transaction back; the shop checks it and sends it too.

/** A token output carries a little BCH (wallets use 1000 satoshis; the minimum is about 800). */
export const TOKEN_DUST = 1000;
const CHANGE_DUST = 546;
// A P2PKH input's unlocking bytecode: a signature (up to 73 bytes as ECDSA, 65 as Schnorr) and a public key.
const UNLOCK_ESTIMATE = new Uint8Array(108);

/** A shopper's wallet address (q… or z…; standard single-key addresses only). */
export function walletAddress(raw) {
  let text = String(raw ?? "").trim();
  if (!text.includes(":")) text = `bitcoincash:${text}`;
  const r = cashAddressToLockingBytecode(text.toLowerCase());
  if (typeof r === "string" || r.prefix !== "bitcoincash") throw new BchError("That isn't a Bitcoin Cash address.");
  const lb = r.bytecode;
  if (!(lb.length === 25 && lb[0] === 0x76 && lb[1] === 0xa9 && lb[2] === 0x14 && lb[23] === 0x88 && lb[24] === 0xac)) throw new BchError("Only a standard wallet address can pay here.");
  const at = (tokenSupport) => lockingBytecodeToCashAddress({ bytecode: lb, prefix: "bitcoincash", tokenSupport }).address;
  return { address: at(false), tokenAddress: at(true), lockingBytecode: binToHex(lb), scripthash: binToHex(sha256.hash(lb).reverse()) };
}

/** What the wallet holds: plain BCH, and fungible tokens by category (coins with an NFT or another category are never touched). */
export function walletHoldings(utxos) {
  const tokens = {};
  let sats = 0;
  for (const u of utxos) {
    if (!u.token) sats += u.sats;
    else if (!u.token.nft) tokens[u.token.category] = (BigInt(tokens[u.token.category] ?? 0) + BigInt(u.token.amount)).toString();
  }
  return { sats, tokens };
}

/**
 * The payment as one unsigned transaction from a wallet: `sats` to `payTo` (none if 0), and (if any)
 * `token.amount` of `token.category` to it too, with change back to the wallet. Pays 1 sat a byte.
 * (The shopper's payment to an order; the shop's rewards wallet sending tokens to a shopper.)
 */
export function buildWalletPayment({ wallet, utxos, payTo, sats, token = null, userPrompt }) {
  const from = hexToBin(wallet.lockingBytecode);
  const to = hexToBin(payTo);
  const spend = [];
  // Tokens first: only plain fungible coins of that category, largest first, until there are enough.
  let tokenIn = 0n;
  if (token && BigInt(token.amount) > 0n) {
    const want = BigInt(token.amount);
    const coins = utxos.filter((u) => u.token && !u.token.nft && u.token.category === token.category).sort((a, b) => (BigInt(b.token.amount) > BigInt(a.token.amount) ? 1 : -1));
    for (const u of coins) {
      if (tokenIn >= want) break;
      spend.push(u);
      tokenIn += BigInt(u.token.amount);
    }
    if (tokenIn < want) throw new BchError("Your wallet doesn't have that many tokens.");
  }
  const category = token ? hexToBin(token.category) : null;
  const outputs = [];
  if (sats > 0) outputs.push({ lockingBytecode: to, valueSatoshis: BigInt(sats) });
  if (token && BigInt(token.amount) > 0n) {
    outputs.push({ lockingBytecode: to, valueSatoshis: BigInt(TOKEN_DUST), token: { amount: BigInt(token.amount), category } });
    if (tokenIn > BigInt(token.amount)) outputs.push({ lockingBytecode: from, valueSatoshis: BigInt(TOKEN_DUST), token: { amount: tokenIn - BigInt(token.amount), category } });
  }
  const input = (u, unlockingBytecode) => ({ outpointIndex: u.vout, outpointTransactionHash: hexToBin(u.txid), sequenceNumber: 0, unlockingBytecode });
  const size = (ins, outs) => encodeTransaction({ version: 2, locktime: 0, inputs: ins.map((u) => input(u, UNLOCK_ESTIMATE)), outputs: outs }).length;
  const out = outputs.reduce((n, o) => n + o.valueSatoshis, 0n);
  // Then plain BCH coins, largest first, until they cover the payment, the fee and any change.
  const plain = utxos.filter((u) => !u.token).sort((a, b) => b.sats - a.sats);
  let have = spend.reduce((n, u) => n + BigInt(u.sats), 0n);
  const change = { lockingBytecode: from, valueSatoshis: 0n };
  let fee = size(spend, [...outputs, change]);
  while (have < out + BigInt(fee)) {
    const next = plain.shift();
    if (!next) throw new BchError("Your wallet doesn't have enough Bitcoin Cash for this payment and its network fee.");
    spend.push(next);
    have += BigInt(next.sats);
    fee = size(spend, [...outputs, change]);
  }
  let final = [...outputs, { ...change, valueSatoshis: have - out - BigInt(fee) }];
  if (have - out - BigInt(fee) < BigInt(CHANGE_DUST)) {
    final = outputs; // too little to send back: it goes to the network fee
    fee = Number(have - out);
  }
  const transaction = { version: 2, locktime: 0, inputs: spend.map((u) => input(u, new Uint8Array())), outputs: final };
  const sourceOutputs = spend.map((u) => ({
    ...input(u, new Uint8Array()),
    lockingBytecode: from,
    valueSatoshis: BigInt(u.sats),
    ...(u.token ? { token: { amount: BigInt(u.token.amount), category: hexToBin(u.token.category) } } : {}),
  }));
  return {
    fee,
    transaction,
    sourceOutputs,
    // As the wallet expects it: libauth's stringify (Uint8Array and BigInt as text). The wallet sends it once the
    // shopper approves (Paytaca always does), so the payment goes through even if the shopper's browser was
    // put to sleep meanwhile; the shop sends it too, which changes nothing once it's out.
    request: JSON.parse(stringify({ transaction, sourceOutputs, broadcast: true, userPrompt })),
  };
}

/** A signed transaction from the wallet: its txid, and what it pays to `lockingBytecode` (as readPayment). */
export function readSignedPayment(hex, lockingBytecode) {
  if (!/^[0-9a-f]+$/i.test(String(hex ?? "")) || hex.length > 200_000) throw new BchError("That isn't a signed transaction.");
  const raw = hexToBin(hex);
  const tx = decodeTransaction(raw);
  if (typeof tx === "string") throw new BchError(`Unreadable transaction (${tx}).`);
  if (tx.inputs.some((i) => i.unlockingBytecode.length === 0)) throw new BchError("The transaction isn't signed.");
  return { txid: binToHex(sha256.hash(sha256.hash(raw)).reverse()), ...readPayment(hex, lockingBytecode) };
}

// --- The shop's own wallet for rewards (it holds the tokens it gives back, and a little BCH for fees) ---------

/** A new private key for the rewards wallet, as WIF (the form wallets import). */
export function newWalletKey() {
  const key = generatePrivateKey(() => randomBytes(32));
  return encodePrivateKeyWif(key, "mainnet");
}

/** The rewards wallet from its key: its address (q… and z…), locking bytecode and Electrum key. */
export function keyWallet(wif) {
  const d = decodePrivateKeyWif(String(wif ?? ""));
  if (typeof d === "string") throw new BchError("That isn't a private key (WIF).");
  const pkh = hash160(secp256k1.derivePublicKeyCompressed(d.privateKey));
  const lb = encodeLockingBytecodeP2pkh(pkh);
  return {
    privateKey: d.privateKey,
    address: encodeCashAddress({ prefix: "bitcoincash", type: "p2pkh", payload: pkh }).address,
    tokenAddress: encodeCashAddress({ prefix: "bitcoincash", type: "p2pkhWithTokens", payload: pkh }).address,
    lockingBytecode: binToHex(lb),
    scripthash: binToHex(sha256.hash(lb).reverse()),
  };
}

/**
 * Signs a transaction built by buildWalletPayment with the wallet's key (Schnorr, SIGHASH_ALL|FORKID, which
 * covers the tokens being spent), then runs it through the BCH virtual machine: a transaction that would burn a
 * token, overspend or fail a signature is never returned, so never broadcast.
 */
export function signWalletPayment({ transaction, sourceOutputs }, privateKey) {
  const pub = secp256k1.derivePublicKeyCompressed(privateKey);
  const SIGHASH = 0x41;
  transaction.inputs.forEach((input, i) => {
    if (input.unlockingBytecode.length) return;
    const serialization = generateSigningSerializationBCH({ inputIndex: i, sourceOutputs, transaction }, { coveredBytecode: sourceOutputs[i].lockingBytecode, signingSerializationType: new Uint8Array([SIGHASH]) });
    const sig = secp256k1.signMessageHashSchnorr(privateKey, sha256.hash(sha256.hash(serialization)));
    if (typeof sig === "string") throw new BchError(sig);
    input.unlockingBytecode = Uint8Array.from([65, ...sig, SIGHASH, 33, ...pub]);
  });
  const ok = createVirtualMachineBCH().verify({ sourceOutputs, transaction });
  if (ok !== true) throw new BchError(`The transaction didn't check out (${ok}), so it wasn't sent.`);
  const raw = encodeTransaction(transaction);
  return { hex: binToHex(raw), txid: binToHex(sha256.hash(sha256.hash(raw)).reverse()) };
}

/** The standard (P2PKH) addresses a transaction was paid from, as locking bytecode hex: the payer's wallet. */
export function payerLockingBytecodes(hex) {
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === "string") return [];
  const out = new Set();
  for (const i of tx.inputs) {
    const ops = decodeAuthenticationInstructions(i.unlockingBytecode);
    const key = ops.length === 2 ? ops[1]?.data : null;
    if (key && (key.length === 33 || key.length === 65)) out.add(binToHex(encodeLockingBytecodeP2pkh(hash160(key))));
  }
  return [...out];
}

// --- The shop's own token: minting it, and what wallets show for it ------------------------------------
//
// A CashToken is minted ("token genesis") by spending an output at index 0: the new token's category ID is that
// output's transaction ID. Fungible supply exists only from genesis on (it can never be added to), so the whole
// supply is minted at once. What wallets show (name, symbol, decimals, icon, description) comes from a Bitcoin
// Cash Metadata Registry (CHIP-BCMR): a JSON file, published on chain in the token's "authchain" (each
// transaction spending output 0 of the one before, from the category's transaction) as
// OP_RETURN <'BCMR'> <SHA-256 of the file> <where it is>. Wallets (Paytaca, Cashonize) read it through Paytaca's
// indexer, which follows authchains. A new publication from the chain's newest transaction updates it.

const push = (bytes) => (bytes.length < 76 ? [bytes.length, ...bytes] : bytes.length < 256 ? [0x4c, bytes.length, ...bytes] : [0x4d, bytes.length & 255, bytes.length >> 8, ...bytes]);

/** OP_RETURN <'BCMR'> <SHA-256 of the registry> <uri>: a metadata registry publication (uri without "https://"). */
export function bcmrOutput(registry, uri) {
  const bytes = typeof registry === "string" ? new TextEncoder().encode(registry) : registry;
  const lockingBytecode = Uint8Array.from([0x6a, ...push(new TextEncoder().encode("BCMR")), ...push(sha256.hash(bytes)), ...push(new TextEncoder().encode(uri))]);
  if (lockingBytecode.length > 223) throw new BchError("The registry's address is too long to publish.");
  return { lockingBytecode, valueSatoshis: 0n };
}

/**
 * A transaction from one of the shop's own wallets: `spend` (in that order: genesis needs its index-0 output
 * first), then plain coins for the rest; `outputs`, and change back. 1 sat a byte. Plain coins only besides
 * `spend`: tokens are never touched unless spent on purpose.
 */
export function buildFromWallet({ wallet, utxos, spend = [], outputs }) {
  const from = hexToBin(wallet.lockingBytecode);
  const chosen = [...spend];
  const taken = new Set(chosen.map((u) => `${u.txid}:${u.vout}`));
  const plain = utxos.filter((u) => !u.token && !taken.has(`${u.txid}:${u.vout}`)).sort((a, b) => b.sats - a.sats);
  const out = outputs.reduce((n, o) => n + o.valueSatoshis, 0n);
  const input = (u, unlockingBytecode) => ({ outpointIndex: u.vout, outpointTransactionHash: hexToBin(u.txid), sequenceNumber: 0, unlockingBytecode });
  const size = (ins, outs) => encodeTransaction({ version: 2, locktime: 0, inputs: ins.map((u) => input(u, UNLOCK_ESTIMATE)), outputs: outs }).length;
  const change = { lockingBytecode: from, valueSatoshis: 0n };
  let have = chosen.reduce((n, u) => n + BigInt(u.sats), 0n);
  let fee = size(chosen, [...outputs, change]);
  while (have < out + BigInt(fee)) {
    const next = plain.shift();
    if (!next) throw new BchError("The wallet needs a little more Bitcoin Cash for this (and its network fee).");
    chosen.push(next);
    have += BigInt(next.sats);
    fee = size(chosen, [...outputs, change]);
  }
  let final = [...outputs, { ...change, valueSatoshis: have - out - BigInt(fee) }];
  if (have - out - BigInt(fee) < BigInt(CHANGE_DUST)) {
    final = outputs;
    fee = Number(have - out);
  }
  const transaction = { version: 2, locktime: 0, inputs: chosen.map((u) => input(u, new Uint8Array())), outputs: final };
  const sourceOutputs = chosen.map((u) => ({
    ...input(u, new Uint8Array()),
    lockingBytecode: from,
    valueSatoshis: BigInt(u.sats),
    ...(u.token ? { token: { amount: BigInt(u.token.amount), category: hexToBin(u.token.category), ...(u.token.nft ? { nft: { capability: u.token.nft.capability, commitment: hexToBin(u.token.nft.commitment) } } : {}) } } : {}),
  }));
  return { transaction, sourceOutputs, fee };
}

/** A BCH transaction on a block explorer. */
export const bchExplorerUrl = (txid) => (/^[0-9a-f]{64}$/i.test(String(txid ?? "")) ? `https://blockchair.com/bitcoin-cash/transaction/${txid}` : null);
