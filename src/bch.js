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
 *           an address's history and transactions, block height, double-spend
 *           proofs, and a notice when an address is paid. Token (CashTokens)
 *           outputs are read too, for coupons.
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
  decodeAuthenticationInstructions,
  decodeHdPublicKey,
  decodeTransaction,
  deriveHdPathRelative,
  encodeCashAddress,
  encodeLockingBytecodeP2pkh,
  hash160,
  hexToBin,
  sha256,
} from "@bitauth/libauth";
import { ElectrumClient } from "@electrum-cash/network";

export const SATS = 100_000_000;

export class BchError extends Error {}

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

/** The sats for a USD amount at a price, rounded up (the merchant is never paid short by rounding). */
export const satsFor = (cents, usdPerBch) => Math.ceil((cents / 100 / usdPerBch) * SATS);

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

/** A BCH transaction on a block explorer. */
export const bchExplorerUrl = (txid) => (/^[0-9a-f]{64}$/i.test(String(txid ?? "")) ? `https://blockchair.com/bitcoin-cash/transaction/${txid}` : null);
