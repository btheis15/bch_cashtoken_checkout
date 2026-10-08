/**
 * The demo's "server": the kit's real checkout engine (../src), running in the browser against a simulated
 * Bitcoin Cash network (../test/fakes.mjs, the same stand-in the tests use: real transactions, built and signed
 * with libauth, just not broadcast to the real network). Everything else is as a shop would set it up: an xPub
 * for the takings, a hot wallet for rewards, receipts and commissions, the shop's own token as coupons and
 * rewards, CashToken receipts, and a sales partner.
 */
import { binToHex, decodeTransaction, deriveHdPath, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeHdPublicKey, hexToBin, sha256 } from "@bitauth/libauth";
import { addressAt, bchText, createBchPrices, parseXpub } from "../../src/bch.js";
import { createBchCheckout } from "../../src/checkout.js";
import { createHotWallet, newWalletKey } from "../../src/hot-wallet.js";
import { createMemoryStore } from "../../src/memory-store.js";
import { createReceiptIssuer } from "../../src/receipts.js";
import { createFakeBchChain, createFakeBchPrices, createFakeWallet } from "../../test/fakes.mjs";

export const USD_PER_BCH = 400;
// The shop's own token (in a real shop, minted once from the admin: src/token.js).
export const OMT = "0a".repeat(32);
export const SITE = "https://omthreadsboutique.vercel.app";

// A demo wallet's xPub (from a published test seed: never use it for real money).
const account = deriveHdPath(deriveHdPrivateNodeFromSeed(hexToBin("000102030405060708090a0b0c0d0e0f")), "m/44'/145'/0'");
const XPUB = encodeHdPublicKey({ node: deriveHdPublicNode(account), network: "mainnet" }).hdPublicKey;
const shopWallet = parseXpub(XPUB);

/** Everything the page watches: the event log and every transaction, with who each output went to. */
function createFeed() {
  const listeners = new Set();
  const feed = { events: [], txs: [], version: 0 };
  const changed = () => {
    feed.version++;
    for (const fn of listeners) fn();
  };
  return {
    feed,
    changed,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    snapshot: () => feed.version,
  };
}

export async function createDemoShop() {
  const chain = createFakeBchChain();
  const store = createMemoryStore();
  const hot = createHotWallet({ wif: newWalletKey(), chain });
  const hw = hot.info();
  const { feed, changed, subscribe, snapshot } = createFeed();

  // The shopper's wallet (for Connect wallet): 1 BCH and 5 of the shop's tokens. And the sales partner's.
  const shopper = createFakeWallet(21);
  const partner = createFakeWallet(41);
  chain.fund(shopper.address, { sats: 100_000_000 });
  chain.fund(shopper.address, { sats: 1000, token: { category: OMT, amount: 5 } });
  // The hot wallet: the shop token's supply and a little BCH for fees, rewards, receipts and commissions.
  chain.fund(hw.tokenAddress, { sats: 1000, token: { category: OMT, amount: 1_000_000 } });
  chain.fund(hw.address, { sats: 50_000_000 });

  // Who each output pays, for the transaction list.
  const names = new Map([
    [shopper.lockingBytecode, "Shopper's wallet"],
    [partner.lockingBytecode, "Sales partner (Priya)"],
    [hw.lockingBytecode, "Shop's hot wallet"],
  ]);
  const nameOf = (lb) => {
    if (names.has(lb)) return names.get(lb);
    for (let i = 0; i < 40; i++) if (addressAt(shopWallet, i).lockingBytecode === lb) return `Shop's wallet (order address #${i})`;
    return "Elsewhere";
  };
  const record = (hex, label) => {
    const tx = decodeTransaction(hexToBin(hex));
    if (typeof tx === "string") return;
    const txid = binToHex(sha256.hash(sha256.hash(hexToBin(hex))).reverse());
    if (feed.txs.some((t) => t.txid === txid)) return;
    feed.txs.unshift({
      txid,
      label,
      at: new Date().toISOString(),
      outputs: tx.outputs.map((o) => ({ to: o.lockingBytecode[0] === 0x6a ? "Data (OP_RETURN: the registry's hash)" : nameOf(binToHex(o.lockingBytecode)), bch: bchText(Number(o.valueSatoshis)), token: o.token ? { amount: String(o.token.amount), nft: Boolean(o.token.nft), baton: o.token.nft?.capability === "minting", omt: binToHex(o.token.category) === OMT } : null })),
    });
    changed();
  };
  // Every broadcast (the shopper's connected wallet, the hot wallet) is recorded as it happens, named by what it does.
  const describe = (hex) => {
    const tx = decodeTransaction(hexToBin(hex));
    if (typeof tx === "string") return "A transaction";
    const to = tx.outputs.map((o) => nameOf(binToHex(o.lockingBytecode)));
    const order = to.some((t) => t.startsWith("Shop's wallet"));
    if (order && to.includes("Sales partner (Priya)")) return "The connected wallet pays: the shop's share and the partner's, in one transaction";
    if (order) return "The connected wallet pays";
    if (tx.outputs.some((o) => o.token?.nft)) return "Hot wallet mints the receipt as a CashToken";
    if (to.includes("Sales partner (Priya)")) return "Hot wallet pays the partner's commission";
    if (to.includes("Shopper's wallet") && tx.outputs.some((o) => o.token)) return "Hot wallet sends the shopper their reward tokens";
    if (tx.outputs.some((o) => o.token && binToHex(o.token.category) === OMT && nameOf(binToHex(o.lockingBytecode)) === "Elsewhere")) return "Hot wallet sends the claimed reward tokens";
    return "Hot wallet transaction";
  };
  const broadcast = chain.broadcast;
  chain.broadcast = async (hex) => {
    const txid = await broadcast(hex);
    record(hex, describe(hex));
    return txid;
  };

  const receipts = createReceiptIssuer({
    wallet: hot,
    store,
    siteUrl: SITE,
    shopName: "Om Threads Boutique",
    symbol: "OMR",
    look: { contact: `${SITE}/contact`, returns: `30-day US returns: ${SITE}/policies/returns` },
  });
  await receipts.create({ name: "Om Receipt", description: "Your receipt from Om Threads Boutique, as a one-of-a-kind CashToken.", icon: `${SITE}/icon.png` });
  // That was the shop's one-time setup (its receipt collection): the list starts with the first order.
  feed.txs.length = 0;

  const prices = createBchPrices({ fetchImpl: createFakeBchPrices({ usd: USD_PER_BCH }).fetch });
  const bch = createBchCheckout({
    xpub: XPUB,
    store,
    chain,
    prices,
    coupons: [{ category: OMT, label: "Om Threads", token: "ft", kind: "bch", value: 0.01, symbol: "OMT", decimals: 0 }],
    rewards: { wallet: hot, settings: { enabled: true, category: OMT, label: "Om Threads", symbol: "OMT", decimals: 0, perBch: 0.1, tokens: 1 } },
    receipts,
    commissions: { wallet: hot },
    onNotice: (p, n) => {
      feed.events.unshift({ at: new Date().toISOString(), order: p.id, kind: n.kind, message: n.message, problem: n.problem });
      changed();
    },
  });
  // As a server would: every few seconds, catch anything missed and send what's waiting.
  setInterval(() => bch.tick().catch(() => {}), 4000);

  /** The simulated network's buttons. */
  const network = {
    /** Any wallet pays the order's address (a QR code or "open in wallet"): `sats`, or exactly what's asked. */
    async payFromAnyWallet(id, { part = false, script = false } = {}) {
      const p = await store.getPayment(id);
      const view = await bch.view(id);
      const sats = Math.round(Number(view.amountBch) * 1e8);
      const txid = chain.pay(p.address, { sats: part ? Math.floor(sats / 2) : sats, script });
      record(chain.state.txs.get(txid).hex, part ? "Any wallet: part of the payment" : script ? "A script wallet pays (double-spend proofs can't cover it)" : "Any wallet pays the QR code");
      return txid;
    },
    /** Someone tries to spend the same coins elsewhere: the network has a double-spend proof for the payment. */
    async doubleSpendAttempt(id) {
      const p = await store.getPayment(id);
      const view = await bch.view(id);
      const txid = chain.pay(p.address, { sats: Math.round(Number(view.amountBch) * 1e8), notify: false });
      record(chain.state.txs.get(txid).hex, "Any wallet pays… and the same coins are spent elsewhere too");
      chain.proof(txid);
      for (const fn of chain.state.listeners) fn(p.scripthash);
      feed.events.unshift({ at: new Date().toISOString(), order: id, kind: "network", message: "The network relayed a double-spend proof for this payment." });
      changed();
    },
    /** A coupon: the shopper sends some of the shop's tokens to the order's token address first. */
    async sendCoupons(id, amount = 3) {
      const p = await store.getPayment(id);
      const txid = chain.pay(p.tokenAddress, { token: { category: OMT, amount } });
      record(chain.state.txs.get(txid).hex, `The shopper sends ${amount} OMT (worth 0.01 BCH each) to the order`);
    },
    /** A block: every transaction waiting in the mempool is confirmed. */
    mineBlock() {
      chain.state.tip++;
      for (const [txid, t] of chain.state.txs) if (!(t.height > 0)) chain.confirm(txid);
      feed.events.unshift({ at: new Date().toISOString(), order: null, kind: "network", message: `Block ${chain.state.tip.toLocaleString()} mined: everything waiting is confirmed.` });
      changed();
      setTimeout(() => bch.tick().catch(() => {}), 50);
    },
  };

  /** Connect wallet, simulated: a wallet that "scans" the code, then signs (and sends) what it's asked to. */
  const wc = {
    enabled: true,
    async resume() {
      return null;
    },
    async start() {
      const session = { topic: "demo", pairingTopic: "demo", address: shopper.address, name: "Demo wallet (1 BCH, 5 OMT)", canCancel: false };
      return { uri: "wc:demo-session@2?relay-protocol=irn&symKey=demo", connected: new Promise((r) => setTimeout(() => r(session), 1600)) };
    },
    appLink: () => "#",
    async disconnect() {},
    async sign(_w, request) {
      await new Promise((r) => setTimeout(r, 1200));
      const { hex } = shopper.sign(request);
      // The wallet sends it itself (as Paytaca does); the shop sends it too, which changes nothing.
      await chain.broadcast(hex).catch(() => {});
      return hex;
    },
  };

  /** The API the payment screen calls (examples/react/api.ts), here answered by the engine directly. */
  const apiFor = (id) => ({
    status: () => bch.view(id),
    renew: () => bch.renew(id),
    wallet: (address) => bch.walletInfo(id, address),
    quote: (input) => bch.walletQuote(id, input),
    build: (input) => bch.walletBuild(id, input),
    submit: (hex) => bch.walletSubmit(id, hex),
    claim: (address) => bch.claimReward(id, address),
    receipt: (address) => bch.claimReceipt(id, address),
  });

  return { bch, store, network, wc, apiFor, feed, subscribe, snapshot, partner: { id: "priya", name: "Priya", address: partner.address }, shopper };
}
