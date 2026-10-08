import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { binToHex, decodeTransaction, deriveHdPath, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeHdPublicKey, hexToBin } from "@bitauth/libauth";
import { createBchPrices } from "../src/bch.js";
import { createBchCheckout } from "../src/checkout.js";
import { createHotWallet, newWalletKey } from "../src/hot-wallet.js";
import { createMemoryStore } from "../src/memory-store.js";
import { createReceiptIssuer } from "../src/receipts.js";
import { createFakeBchChain, createFakeBchPrices, createFakeWallet } from "./fakes.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const account = deriveHdPath(deriveHdPrivateNodeFromSeed(hexToBin("000102030405060708090a0b0c0d0e0f")), "m/44'/145'/0'");
const XPUB = encodeHdPublicKey({ node: deriveHdPublicNode(account), network: "mainnet" }).hdPublicKey;
const TOKEN = "0e".repeat(32);
const RULES = { enabled: true, category: TOKEN, label: "Shop Rewards", symbol: "SHOP", decimals: 0, perBch: 0.1, tokens: 1 };
const ORDER = { subtotalCents: 6000, shippingCents: 600, itemCount: 1, shippingLabel: "Standard", items: [{ title: "Kullu Stole", qty: 1, cents: 6000 }], receipt: "token" };

/**
 * A shop with everything on (rewards, CashToken receipts, partner commissions), all sent from one hot wallet. The
 * stand-in network refuses a coin spent twice, as a real one does, so sends that trip over each other would show.
 */
async function busyShop({ hotSats = 5_000_000 } = {}) {
  const chain = createFakeBchChain();
  const store = createMemoryStore();
  const hot = createHotWallet({ wif: newWalletKey(), chain });
  chain.fund(hot.info().tokenAddress, { sats: 1000, token: { category: TOKEN, amount: 1_000_000 } });
  chain.fund(hot.info().address, { sats: hotSats });
  const receipts = createReceiptIssuer({ wallet: hot, store, siteUrl: "https://shop.example", shopName: "Example Shop" });
  await receipts.create({ name: "Example Receipt" });
  const partner = createFakeWallet(41);
  const bch = createBchCheckout({
    xpub: XPUB, store, chain, prices: createBchPrices({ fetchImpl: createFakeBchPrices({ usd: 400 }).fetch }), proofWaitMs: 0,
    rewards: { wallet: hot, settings: RULES }, receipts, commissions: { wallet: hot },
  });
  const refused = [];
  const broadcast = chain.broadcast;
  chain.broadcast = (hex) => broadcast(hex).catch((e) => (refused.push(e.message), Promise.reject(e)));
  return { bch, chain, store, hot, receipts, refused, partner: { id: "priya", address: partner.address, ratePercent: 5 } };
}

/** tick() until nothing is left to send (or give up). */
async function drain(bch, store, ids) {
  for (let i = 0; i < 12; i++) {
    await sleep(20);
    const ps = await Promise.all(ids.map((id) => store.getPayment(id)));
    const waiting = ps.some((p) => [p.reward, p.receipt, p.commission].some((x) => x && ["pending", "sending"].includes(x.state)));
    if (!waiting) return i;
    await bch.tick();
  }
  return null;
}

const nftsIn = (chain, category) =>
  [...chain.state.txs.values()].flatMap((t) => decodeTransaction(hexToBin(t.hex)).outputs.filter((o) => o.token?.nft?.capability === "none" && binToHex(o.token.category) === category).map((o) => binToHex(o.token.nft.commitment)));

describe("a busy shop: many orders at once, one hot wallet", () => {
  test("six orders paid together: every reward, receipt and commission goes, none twice, none trips over another", async () => {
    const { bch, chain, store, receipts, refused, partner } = await busyShop();
    const ids = ["b1", "b2", "b3", "b4", "b5", "b6"];
    for (const [n, id] of ids.entries()) await bch.start({ id, number: 1000 + n, ...ORDER, partner });
    // Three from connected wallets (one transaction each, the partner's share in it), three by QR code, all at once.
    const payers = [51, 52, 53].map((n) => createFakeWallet(n));
    for (const w of payers) chain.fund(w.address, { sats: 30_000_000 });
    const built = await Promise.all(payers.map((w, i) => bch.walletBuild(ids[i], { address: w.address })));
    await Promise.all([
      ...payers.map((w, i) => bch.walletSubmit(ids[i], w.sign(built[i].request).hex)),
      ...ids.slice(3).map(async (id) => chain.pay((await store.getPayment(id)).address, { sats: (await store.getPayment(id)).windows.at(-1).sats })),
    ]);
    assert.notEqual(await drain(bch, store, ids), null, "everything went within a few ticks");

    for (const [i, id] of ids.entries()) {
      const p = await store.getPayment(id);
      assert.equal(p.status, "paid", id);
      assert.equal(p.commission.state, "sent", `${id}: commission`);
      assert.equal(p.commission.how, i < 3 ? "split" : "wallet");
      assert.equal(p.reward.state, i < 3 ? "sent" : "claimable", `${id}: reward`);
      assert.equal(p.receipt.state, i < 3 ? "sent" : "claimable", `${id}: receipt`);
    }

    // The three paid by QR code claim their receipt and reward, all at the same moment.
    const claimers = [61, 62, 63].map((n) => createFakeWallet(n));
    await Promise.all(ids.slice(3).flatMap((id, i) => [bch.claimReceipt(id, claimers[i].address), bch.claimReward(id, claimers[i].address)]));
    assert.notEqual(await drain(bch, store, ids), null);
    for (const id of ids) {
      const p = await store.getPayment(id);
      assert.equal(p.reward.state, "sent", `${id}: reward`);
      assert.equal(p.receipt.state, "sent", `${id}: receipt`);
      assert.ok(chain.state.txs.has(p.reward.txid) && chain.state.txs.has(p.receipt.txid), `${id}: on the network`);
    }

    // Six receipts, one each, each listed in the registry wallets read; nothing was refused along the way.
    const category = (await receipts.status()).collection.category;
    const minted = nftsIn(chain, category);
    assert.equal(minted.length, 6);
    assert.equal(new Set(minted).size, 6, "one of a kind");
    const types = Object.values(JSON.parse(await receipts.registry(category)).identities[category])[0].token.nfts.parse.types;
    for (const c of minted) assert.ok(types[c], "listed");
    assert.deepEqual(refused, [], "no transaction refused (no coin spent twice)");
    // Each got its own reward amount: 0.165 BCH earns 1.
    const rewards = await Promise.all(ids.map(async (id) => (await bch.view(id)).reward.text));
    assert.deepEqual(rewards, Array(6).fill("1 SHOP"));
  });

  test("the hot wallet runs low partway through: what's left waits, then goes once it's topped up", async () => {
    const { bch, chain, store, hot, refused } = await busyShop({ hotSats: 4000 });
    const ids = ["l1", "l2", "l3"];
    for (const [n, id] of ids.entries()) await bch.start({ id, number: 2000 + n, ...ORDER });
    const payers = [71, 72, 73].map((n) => createFakeWallet(n));
    for (const w of payers) chain.fund(w.address, { sats: 30_000_000 });
    for (const [i, w] of payers.entries()) await bch.walletSubmit(ids[i], w.sign((await bch.walletBuild(ids[i], { address: w.address })).request).hex);
    await sleep(60);
    await bch.tick();
    const left = (await Promise.all(ids.map((id) => store.getPayment(id)))).flatMap((p) => [p.reward, p.receipt]).filter((x) => x.state !== "sent");
    assert.ok(left.length > 0, "some had to wait");
    // While they wait, the shopper sees "on its way", not an error.
    for (const id of ids) assert.ok(["sending", "sent"].includes((await bch.view(id)).receipt.state));
    chain.fund(hot.info().address, { sats: 200_000 });
    assert.notEqual(await drain(bch, store, ids), null);
    for (const id of ids) {
      const p = await store.getPayment(id);
      assert.equal(p.reward.state, "sent");
      assert.equal(p.receipt.state, "sent");
    }
    assert.deepEqual(refused, []);
  });
});
