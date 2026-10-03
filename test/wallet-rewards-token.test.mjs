import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { binToHex, decodeTransaction, deriveHdPath, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeHdPublicKey, hexToBin } from "@bitauth/libauth";
import { createBchPrices, keyWallet } from "../src/bch.js";
import { createBchCheckout } from "../src/checkout.js";
import { createFileStore } from "../src/file-store.js";
import { createHotWallet, newWalletKey } from "../src/hot-wallet.js";
import { createMemoryStore } from "../src/memory-store.js";
import { createTokenIssuer } from "../src/token.js";
import { checkCoupons, checkRewards } from "../src/tokens.js";
import { createFakeBchChain, createFakeBchPrices, createFakeWallet } from "./fakes.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const account = deriveHdPath(deriveHdPrivateNodeFromSeed(hexToBin("000102030405060708090a0b0c0d0e0f")), "m/44'/145'/0'");
const XPUB = encodeHdPublicKey({ node: deriveHdPublicNode(account), network: "mainnet" }).hdPublicKey;
const TOKEN = "0e".repeat(32);
const SHOP = { category: TOKEN, label: "Shop Rewards", token: "ft", kind: "bch", value: 0.01, symbol: "SHOP", decimals: 0 };
// $60 of items and $6 shipping: $66 at $400 per BCH is 0.165 BCH.
const ORDER = { subtotalCents: 6000, shippingCents: 600, itemCount: 1, shippingLabel: "Standard" };

/** A checkout against the stand-ins; the price is $400 per BCH. */
function setup(options = {}) {
  const chain = options.chain ?? createFakeBchChain();
  const priceApis = createFakeBchPrices({ usd: 400 });
  const store = options.store ?? createMemoryStore();
  const paid = [];
  const bch = createBchCheckout({ xpub: XPUB, store, chain, prices: createBchPrices({ fetchImpl: priceApis.fetch }), proofWaitMs: 0, onPaid: (p) => paid.push(p), ...options });
  const payment = (id) => store.getPayment(id);
  const sats = async (id) => (await payment(id)).windows.at(-1).sats;
  return { bch, chain, store, paid, payment, sats };
}

describe("BCH-valued tokens", () => {
  test("each one takes its BCH off, they add up, and the price being held stays", async () => {
    const { bch, chain, payment, sats } = setup({ coupons: [SHOP] });
    const v = await bch.start({ id: "t1", label: "Order t1", ...ORDER });
    const held = (await payment("t1")).windows[0];
    assert.equal(held.sats, 16_500_000);
    assert.deepEqual(v.coupon, { address: (await payment("t1")).tokenAddress, uri: `${(await payment("t1")).tokenAddress}?c=${TOKEN}`, coupons: [{ label: "Shop Rewards", off: "0.01 BCH off each", send: "up to 15 SHOP" }], stack: true });

    // 3 tokens = 0.03 BCH off, at the rate being held, until the same time.
    chain.pay(v.coupon.address, { token: { category: TOKEN, amount: 3 } });
    await sleep(20);
    assert.equal(await sats("t1"), 13_500_000, "0.165 − 0.03 = 0.135 BCH");
    const p = await payment("t1");
    assert.equal(p.windows.at(-1).expiresAt, held.expiresAt);
    assert.equal(p.windows.at(-1).usdPerBch, held.usdPerBch);
    let now = await bch.view("t1");
    assert.deepEqual(now.applied, { label: "Shop Rewards (3 SHOP)", discountCents: 1200, bch: "0.03" });
    assert.equal(now.coupon.coupons[0].send, "up to 12 SHOP", "more can follow");
    // The order in BCH: the lines add up to exactly what's asked.
    assert.deepEqual(now.breakdown, {
      usdPerBch: 400,
      sources: held.sources,
      lines: [
        { kind: "items", label: "1 item", bch: "0.15", cents: 6000 },
        { kind: "tokens", label: "Shop Rewards", tokens: "3 SHOP", each: "0.01 BCH", bch: "0.03", cents: 1200 },
        { kind: "shipping", label: "Standard", bch: "0.015", cents: 600 },
      ],
      total: { bch: "0.135", cents: 5400 },
    });

    // A few more, then more than the items cost: what's over is flagged to send back.
    chain.pay(v.coupon.address, { token: { category: TOKEN, amount: 2 } });
    await sleep(20);
    assert.equal(await sats("t1"), 11_500_000);
    chain.pay(v.coupon.address, { token: { category: TOKEN, amount: 12 } });
    await sleep(20);
    let q = await payment("t1");
    assert.equal(q.discountCents, 6000, "never more than the items");
    assert.equal(q.totalCents, 600, "just the shipping left");
    assert.equal(await sats("t1"), 1_500_000);
    assert.equal(q.coupon.tokens, "15");
    assert.ok(q.problems.some((x) => x.kind === "coupon" && /12 SHOP “Shop Rewards” arrived; 10 SHOP covered the items, so send the other 2 SHOP back/.test(x.message)), JSON.stringify(q.problems));
    assert.equal((await bch.view("t1")).coupon, null, "the items are covered");
    chain.pay(v.coupon.address, { token: { category: TOKEN, amount: 1 } });
    await sleep(20);
    assert.ok((await payment("t1")).problems.some((x) => /already fully covered/.test(x.message)));

    // Paying the rest; the renewals left aren't used up by the tokens.
    assert.equal((await payment("t1")).couponWindows, 3);
    chain.pay(v.address, { sats: await sats("t1") });
    await sleep(20);
    q = await payment("t1");
    assert.equal(q.status, "paid");
    assert.equal(q.coupon.sats, 15_000_000);
    now = await bch.view("t1");
    assert.equal(now.state, "paid");
  });

  test("with decimal places: 1.5 tokens is 1.5 × the value", async () => {
    const { bch, chain, sats } = setup({ coupons: [{ ...SHOP, decimals: 2 }] });
    const v = await bch.start({ id: "t2", ...ORDER });
    chain.pay(v.coupon.address, { token: { category: TOKEN, amount: 150 } });
    await sleep(20);
    assert.equal(await sats("t2"), 16_500_000 - 1_500_000);
    assert.deepEqual((await bch.view("t2")).applied, { label: "Shop Rewards (1.5 SHOP)", discountCents: 600, bch: "0.015" });
  });

  test("sales tax is worked out on the lower price (in proportion, or by onCoupon)", async () => {
    const { bch, chain, payment, sats } = setup({ coupons: [SHOP] });
    const v = await bch.start({ id: "t3", ...ORDER, taxCents: 660 });
    assert.equal((await payment("t3")).totalCents, 7260);
    chain.pay(v.coupon.address, { token: { category: TOKEN, amount: 3 } });
    await sleep(20);
    const p = await payment("t3");
    assert.equal(p.taxCents, 540, "10% of $54");
    assert.equal(p.totalCents, 5940);
    assert.equal(await sats("t3"), 14_850_000);
    const lines = (await bch.view("t3")).breakdown.lines;
    assert.deepEqual(lines.map((l) => [l.kind, l.bch]), [["items", "0.15"], ["tokens", "0.03"], ["shipping", "0.015"], ["tax", "0.0135"]]);

    const calls = [];
    const own = setup({ coupons: [SHOP], onCoupon: async (q, c, discount) => (calls.push([q.id, c.kind, discount]), { totalCents: 6000 - discount + 600 + 100, taxCents: 100 }) });
    const w = await own.bch.start({ id: "t4", ...ORDER, taxCents: 660 });
    own.chain.pay(w.coupon.address, { token: { category: TOKEN, amount: 3 } });
    await sleep(20);
    assert.deepEqual(calls, [["t4", "bch", 1200]]);
    assert.equal((await own.payment("t4")).taxCents, 100);
    assert.equal((await own.payment("t4")).totalCents, 5500);
  });
});

describe("Connect wallet", () => {
  test("the shopper picks how many tokens, and the tokens and the BCH go in one transaction", async () => {
    const { bch, chain, payment } = setup({ coupons: [SHOP] });
    const v = await bch.start({ id: "w1", label: "Order w1", ...ORDER });
    assert.equal(v.walletPay, true);
    const wallet = createFakeWallet(11);
    chain.fund(wallet.address, { sats: 30_000_000 });
    chain.fund(wallet.address, { sats: 1000, token: { category: TOKEN, amount: 5 } });
    chain.fund(wallet.address, { sats: 1000, token: { category: TOKEN, amount: 2 } });
    chain.fund(wallet.address, { sats: 1000, token: { category: "ab".repeat(32), amount: 9 } });
    chain.fund(wallet.address, { sats: 1000, token: { category: TOKEN, amount: 0, nft: { capability: "minting", commitment: "" } } });

    // What the wallet holds that this order can use: never more than covers the items ($60 = 15 SHOP).
    const info = await bch.walletInfo("w1", wallet.address);
    assert.equal(info.bch, "0.3", "plain BCH only");
    assert.deepEqual(info.tokens, [{ category: TOKEN, label: "Shop Rewards", symbol: "SHOP", decimals: 0, value: 0.01, have: "7", max: "7", useful: "15", haveText: "7 SHOP", maxText: "7 SHOP" }]);
    await assert.rejects(bch.walletInfo("w1", "bitcoincash:nope"), (e) => e.status === 400);

    // A quote as the slider moves.
    let q = await bch.walletQuote("w1", { category: TOKEN, amount: "3" });
    assert.equal(q.amountBch, "0.135");
    assert.equal(q.breakdown.total.bch, "0.135");
    assert.deepEqual(q.breakdown.lines[1], { kind: "tokens", label: "Shop Rewards", tokens: "3 SHOP", each: "0.01 BCH", bch: "0.03", cents: 1200 });
    assert.equal((await bch.walletQuote("w1", { category: TOKEN, amount: "0" })).amountBch, "0.165");
    q = await bch.walletQuote("w1", { category: TOKEN, amount: "99" });
    assert.equal(q.tokens.amount, "15", "no more than covers the items");

    // The transaction to sign: 0.135 BCH and 3 SHOP to the order, the rest of the 5-token coin and the change back.
    const built = await bch.walletBuild("w1", { address: wallet.address, category: TOKEN, amount: "3" });
    assert.equal(built.amountBch, "0.135");
    assert.equal(built.request.broadcast, true, "the wallet sends it once approved (Paytaca always does)");
    assert.equal(built.request.userPrompt, "Order w1");
    assert.match(built.request.transaction.outputs[0].valueSatoshis, /^<bigint: 13500000n>$/);
    const signed = wallet.sign(built.request);
    assert.equal(wallet.verify(signed), true, "the network would accept it: signatures, fee, and no token burned");
    const to = hexToBin((await payment("w1")).lockingBytecode);
    const out = signed.transaction.outputs;
    assert.deepEqual(out.filter((o) => o.token && String(o.lockingBytecode) === String(to)).map((o) => o.token.amount), [3n]);
    assert.deepEqual(out.filter((o) => o.token && String(o.lockingBytecode) !== String(to)).map((o) => o.token.amount), [2n], "the 2-token coin isn't needed");
    assert.equal(signed.sourceOutputs.some((so) => so.token && binToHex(so.token.category) === "ab".repeat(32)), false, "another token is never touched");
    assert.equal(signed.sourceOutputs.some((so) => so.token?.nft), false, "nor an NFT");

    // Handed back signed: checked, broadcast, and the order is paid with its tokens.
    const before = chain.state.broadcasts.length;
    assert.equal((await bch.walletSubmit("w1", signed.hex)).ok, true);
    assert.equal(chain.state.broadcasts.length, before + 1);
    await sleep(30);
    const p = await payment("w1");
    assert.equal(p.status, "paid", JSON.stringify(p.events.map((e) => e.message)));
    assert.equal(p.discountCents, 1200);
    assert.equal(p.totalCents, 5400);
    assert.equal(p.coupon.tokens, "3");
    assert.deepEqual(p.problems, []);
    assert.ok(p.events.some((e) => /Paid from the shopper's connected wallet, with 3 SHOP/.test(e.message)));
    await assert.rejects(bch.walletInfo("w1", wallet.address), (e) => e.status === 409 && /already paid/.test(e.message));
  });

  test("the wallet sends the payment itself (the page may be asleep); handing it in afterwards is fine", async () => {
    const { bch, chain, payment } = setup();
    await bch.start({ id: "w2", ...ORDER });
    const wallet = createFakeWallet(14);
    chain.fund(wallet.address, { sats: 20_000_000 });
    const signed = wallet.sign((await bch.walletBuild("w2", { address: wallet.address })).request);
    await chain.broadcast(signed.hex); // the wallet's own broadcast
    await sleep(30);
    assert.equal((await payment("w2")).status, "paid", "noticed without the page");
    assert.equal((await bch.walletSubmit("w2", signed.hex)).ok, true);
  });

  test("not enough BCH says so; a transaction that doesn't match isn't sent; a refused broadcast says nothing was sent", async () => {
    const { bch, chain, payment } = setup();
    await bch.start({ id: "w3", ...ORDER });
    const poor = createFakeWallet(12);
    chain.fund(poor.address, { sats: 1_000_000 });
    await assert.rejects(bch.walletBuild("w3", { address: poor.address }), (e) => e.status === 409 && /enough Bitcoin Cash/.test(e.message));

    const wallet = createFakeWallet(13);
    chain.fund(wallet.address, { sats: 9_000_000 });
    chain.fund(wallet.address, { sats: 9_000_000 });
    assert.deepEqual((await bch.walletInfo("w3", wallet.address)).tokens, []);
    const built = await bch.walletBuild("w3", { address: wallet.address });
    assert.equal(built.amountBch, "0.165");
    // Altered to pay less: refused, and never broadcast.
    const tampered = wallet.revive(built.request);
    tampered.transaction.outputs[0].valueSatoshis = 1_000_000n;
    const bad = wallet.sign(JSON.parse(JSON.stringify(tampered, (_k, v) => (typeof v === "bigint" ? `<bigint: ${v}n>` : v instanceof Uint8Array ? `<Uint8Array: 0x${binToHex(v)}>` : v))));
    const sent = chain.state.broadcasts.length;
    await assert.rejects(bch.walletSubmit("w3", bad.hex), (e) => e.status === 409);
    assert.equal(chain.state.broadcasts.length, sent, "never broadcast");
    await assert.rejects(bch.walletSubmit("w3", "zz"), (e) => e.status === 400);

    const good = wallet.sign((await bch.walletBuild("w3", { address: wallet.address })).request);
    assert.equal(wallet.verify(good), true);
    chain.state.rejectBroadcast = "bad-txns-inputs-missingorspent";
    await assert.rejects(bch.walletSubmit("w3", good.hex), (e) => e.status === 502 && /Nothing was sent/.test(e.message));
    chain.state.rejectBroadcast = null;
    assert.equal((await bch.walletSubmit("w3", good.hex)).ok, true);
    await sleep(30);
    assert.equal((await payment("w3")).status, "paid");
  });
});

describe("Rewards", () => {
  const RULES = { enabled: true, category: TOKEN, label: "Shop Rewards", symbol: "SHOP", decimals: 0, perBch: 0.1, tokens: 1 };

  test("the shop's tokens back to the wallet that paid (1 per 0.1 BCH); claimed on the order page otherwise", async () => {
    const chain = createFakeBchChain();
    const hot = createHotWallet({ wif: newWalletKey(), chain });
    const { bch, payment } = setup({ chain, rewards: { wallet: hot, settings: RULES } });
    const key = hot.info();
    assert.match(key.tokenAddress, /^bitcoincash:z/);
    // The supply minted into it once, and a little BCH for fees.
    chain.fund(key.tokenAddress, { sats: 1000, token: { category: TOKEN, amount: 1_000_000 } });
    chain.fund(key.address, { sats: 50_000 });
    assert.deepEqual((await bch.rewardsStatus()).balance, { bch: "0.0005", tokens: "1000000 SHOP" });

    // While paying, the promotion shows.
    const v = await bch.start({ id: "r1", ...ORDER });
    assert.deepEqual(v.rewardOffer, { label: "Shop Rewards", symbol: "SHOP", decimals: 0, perBch: 0.1, tokens: 1, maxPerOrder: null, endsOn: null });

    // Paid from a connected wallet: 0.165 BCH earns 1 SHOP, sent straight back to that wallet.
    const payer = createFakeWallet(21);
    chain.fund(payer.address, { sats: 30_000_000 });
    const sent0 = chain.state.broadcasts.length;
    await bch.walletSubmit("r1", payer.sign((await bch.walletBuild("r1", { address: payer.address })).request).hex);
    await sleep(60);
    let p = await payment("r1");
    assert.equal(p.status, "paid");
    const rewardTx = chain.state.broadcasts.slice(sent0 + 1);
    assert.equal(rewardTx.length, 1, "one reward transaction");
    const tokensTo = (hex) => decodeTransaction(hexToBin(hex)).outputs.filter((o) => o.token).map((o) => ({ to: binToHex(o.lockingBytecode), amount: o.token.amount }));
    assert.deepEqual(tokensTo(rewardTx[0]), [
      { to: payer.lockingBytecode, amount: 1n },
      { to: key.lockingBytecode, amount: 999_999n },
    ]);
    assert.ok(p.events.some((e) => /Earned 1 SHOP \(1 SHOP for every 0\.1 BCH\): sending them back to the wallet that paid/.test(e.message)));
    assert.ok(p.events.some((e) => /Sent 1 SHOP to bitcoincash:z/.test(e.message)));
    let reward = (await bch.view("r1")).reward;
    assert.equal(reward.state, "sent");
    assert.equal(reward.text, "1 SHOP");
    assert.ok(reward.txUrl);

    // Paid from any wallet (it might be an exchange): claimable on the order page instead.
    const w = await bch.start({ id: "r2", ...ORDER });
    chain.pay(w.address, { sats: 25_000_000 });
    await sleep(60);
    reward = (await bch.view("r2")).reward;
    assert.equal(reward.state, "claimable");
    assert.equal(reward.text, "2 SHOP");
    assert.ok(reward.claimUntil);
    await assert.rejects(bch.claimReward("r2", "bitcoincash:nope"), (e) => e.status === 400);
    const shopper = createFakeWallet(22);
    const claimed = await bch.claimReward("r2", shopper.address);
    assert.equal(claimed.reward.state, "sent");
    assert.deepEqual(tokensTo(chain.state.broadcasts.at(-1))[0], { to: shopper.lockingBytecode, amount: 2n });
    p = await payment("r2");
    assert.ok(p.events.some((e) => /The shopper claimed 2 SHOP to bitcoincash:z/.test(e.message)));
    assert.equal((await bch.claimReward("r2", shopper.address)).reward.state, "sent", "claiming again changes nothing");
    assert.equal((await bch.rewardsStatus()).recent.length, 2);
  });

  test("a hot wallet without fees waits, and the reward goes once it's topped up", async () => {
    const chain = createFakeBchChain();
    const hot = createHotWallet({ wif: newWalletKey(), chain });
    const { bch, payment } = setup({ chain, rewards: { wallet: hot, settings: RULES } });
    chain.fund(hot.info().tokenAddress, { sats: 1000, token: { category: TOKEN, amount: 100 } });
    const payer = createFakeWallet(31);
    chain.fund(payer.address, { sats: 30_000_000 });
    await bch.start({ id: "r3", ...ORDER });
    await bch.walletSubmit("r3", payer.sign((await bch.walletBuild("r3", { address: payer.address })).request).hex);
    await sleep(60);
    let p = await payment("r3");
    assert.equal(p.reward.state, "pending");
    assert.match(p.reward.error, /needs a little Bitcoin Cash/);
    chain.fund(hot.info().address, { sats: 20_000 });
    await bch.tick();
    p = await payment("r3");
    assert.equal(p.reward.state, "sent");
  });

  test("off, or past its end date, nothing is earned", async () => {
    const chain = createFakeBchChain();
    const hot = createHotWallet({ wif: newWalletKey(), chain });
    let rules = { ...RULES, endsOn: "2020-01-01" };
    const { bch, payment } = setup({ chain, rewards: { wallet: hot, settings: () => rules } });
    const v = await bch.start({ id: "r4", ...ORDER });
    assert.equal(v.rewardOffer, null);
    chain.pay(v.address, { sats: 16_500_000 });
    await sleep(40);
    assert.equal((await payment("r4")).reward, null);
    rules = { ...RULES, enabled: false };
    assert.equal((await bch.start({ id: "r5", ...ORDER })).rewardOffer, null);
  });
});

describe("the shop's token: minted from your server, with what wallets show for it (BCMR)", () => {
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  const txOf = (hex) => decodeTransaction(hexToBin(hex));
  const txidOf = (hex) => Buffer.from(createHash("sha256").update(createHash("sha256").update(Buffer.from(hex, "hex")).digest()).digest()).reverse().toString("hex");
  const spends = (tx) => tx.inputs.map((i) => `${binToHex(i.outpointTransactionHash)}:${i.outpointIndex}`);
  /** An OP_RETURN BCMR publication: the registry's SHA-256 and where it's served. */
  const publication = (tx) => {
    const b = tx.outputs.find((x) => x.lockingBytecode[0] === 0x6a).lockingBytecode;
    assert.equal(Buffer.from(b.slice(2, 6)).toString(), "BCMR");
    assert.equal(b[6], 32);
    const [len, at] = b[39] === 0x4c ? [b[40], 41] : [b[39], 40];
    assert.equal(b.length, at + len);
    return { hash: binToHex(b.slice(7, 39)), uri: Buffer.from(b.slice(at, at + len)).toString() };
  };

  test("minted in two small transactions into the hot wallet; the registry's hash is on chain; rewards never spend the identity; updates keep it", async () => {
    const chain = createFakeBchChain();
    const store = createMemoryStore();
    const hot = createHotWallet({ wif: newWalletKey(), chain });
    const issuer = createTokenIssuer({ wallet: hot, store, siteUrl: "https://shop.example", registryName: "Example Shop" });
    const key = keyWallet(hot.info().wif);
    const mint = { name: "Shop Rewards", symbol: "shop", supply: 1_000_000, decimals: 0, description: "Earned at the shop.", icon: "https://shop.example/token.png" };
    assert.equal((await issuer.status()).token, null);
    assert.equal((await issuer.status()).registryHost, "shop.example");

    // Checked first; and it needs a little BCH for fees.
    await assert.rejects(issuer.create({ ...mint, symbol: "x", supply: "lots", decimals: 9 }), (e) => assert.deepEqual(Object.keys(e.errors).sort(), ["decimals", "supply", "symbol"]) ?? true);
    await assert.rejects(issuer.create({ ...mint, icon: "http://not-secure.example/x.png" }), (e) => Boolean(e.errors.icon));
    await assert.rejects(issuer.create(mint), (e) => e.status === 409 && /Send the hot wallet about 0\.0001 BCH/.test(e.message));
    assert.equal(chain.state.broadcasts.length, 0);

    // The first try: the authbase goes through, the genesis isn't taken. The authbase is kept for the next try.
    chain.fund(key.address, { sats: 100_000 });
    const real = chain.broadcast;
    let n = 0;
    chain.broadcast = async (hex) => {
      if (++n === 2) throw new Error("connection lost");
      return real(hex);
    };
    await assert.rejects(issuer.create(mint), (e) => e.status === 502);
    chain.broadcast = real;
    assert.equal((await issuer.status()).minting, true);
    const [baseHex] = chain.state.broadcasts;
    const category = txidOf(baseHex);
    assert.equal(txOf(baseHex).outputs[0].valueSatoshis, 2000n);

    const minted = await issuer.create(mint);
    assert.equal(chain.state.broadcasts.length, 2, "the authbase once, then the genesis");
    const genesisHex = chain.state.broadcasts[1];
    const genesis = txOf(genesisHex);
    const genesisTxid = txidOf(genesisHex);
    assert.equal(spends(genesis)[0], `${category}:0`, "mints from the authbase's output 0: the category is its transaction ID");
    assert.equal(genesis.outputs[0].valueSatoshis, 1000n, "output 0: the identity output…");
    assert.equal(binToHex(genesis.outputs[0].lockingBytecode), key.lockingBytecode, "…kept by the hot wallet");
    assert.equal(genesis.outputs[0].token, undefined);
    assert.equal(binToHex(genesis.outputs[1].token.category), category);
    assert.equal(genesis.outputs[1].token.amount, 1_000_000n, "the whole supply into the hot wallet");
    assert.equal(minted.token.supply, "1000000 SHOP");
    assert.equal(minted.token.held, "1000000 SHOP");
    await assert.rejects(issuer.create(mint), (e) => e.status === 409, "minted once");

    // What wallets read: the registry served on the website's address, whose hash is the one on chain.
    const pub = publication(genesis);
    assert.equal(pub.uri, `shop.example/bcmr/${category}.json`);
    const json = await issuer.registry(category);
    assert.equal(sha(json), pub.hash);
    assert.equal(await issuer.registry("ab".repeat(32)), null);
    const reg = JSON.parse(json);
    assert.equal(reg.$schema, "https://cashtokens.org/bcmr-v2.schema.json");
    assert.equal(reg.registryIdentity.name, "Example Shop");
    const [at] = Object.keys(reg.identities[category]);
    assert.equal(reg.latestRevision, at);
    const id = reg.identities[category][at];
    assert.deepEqual(id.token, { category, symbol: "SHOP", decimals: 0 });
    assert.equal(id.name, "Shop Rewards");
    assert.deepEqual(id.uris, { icon: "https://shop.example/token.png", web: "https://shop.example" });

    // Rewards from the same wallet never spend the identity output.
    const { bch } = setup({ chain, rewards: { wallet: hot, settings: { enabled: true, category, label: "Shop Rewards", symbol: "SHOP", perBch: 0.1, tokens: 1 } } });
    const shopper = createFakeWallet(41);
    assert.match((await bch.testReward({ address: shopper.address, amount: 3 })).sent, /^3 SHOP$/);
    assert.ok(!spends(txOf(chain.state.broadcasts.at(-1))).includes(`${genesisTxid}:0`));
    // Left with only the identity output and the tokens: no BCH to send a reward with (the identity's isn't counted).
    chain.state.coins.set(key.scripthash, chain.state.coins.get(key.scripthash).filter((c) => c.token || (c.txid === genesisTxid && c.vout === 0)));
    await assert.rejects(bch.testReward({ address: shopper.address, amount: 1 }), (e) => e.status === 409 && /needs a little Bitcoin Cash/.test(e.message));
    chain.fund(key.address, { sats: 30_000 });

    // New details: a new snapshot, published by spending the identity output (the reply lost, but it went through).
    const before = chain.state.broadcasts.length;
    chain.broadcast = async (hex) => {
      await real(hex);
      throw new Error("timeout");
    };
    const updated = await issuer.update({ name: "Shop Rewards Club", description: "Earned at the shop.", web: "https://shop.example/rewards", icon: "https://shop.example/token-2.png" });
    chain.broadcast = real;
    assert.equal(chain.state.broadcasts.length, before + 1);
    const upHex = chain.state.broadcasts.at(-1);
    const up = txOf(upHex);
    assert.equal(spends(up)[0], `${genesisTxid}:0`, "spends the identity output");
    assert.equal(up.outputs[0].valueSatoshis, 1000n);
    assert.equal(binToHex(up.outputs[0].lockingBytecode), key.lockingBytecode, "and keeps the identity");
    assert.ok(up.outputs.every((o) => !o.token), "moves no tokens");
    const reg2 = JSON.parse(await issuer.registry(category));
    assert.equal(sha(await issuer.registry(category)), publication(up).hash);
    assert.equal(Object.keys(reg2.identities[category]).length, 2, "the first snapshot is kept");
    assert.deepEqual(reg2.version, { major: 1, minor: 1, patch: 0 });
    const latest = reg2.identities[category][reg2.latestRevision];
    assert.equal(latest.name, "Shop Rewards Club");
    assert.deepEqual(latest.token, { category, symbol: "SHOP", decimals: 0 }, "symbol and decimals stay as minted");
    assert.equal(updated.token.updates, 1);

    // Not taken by the network: nothing changes, and the next try still spends the current identity output.
    chain.state.rejectBroadcast = "connection lost";
    await assert.rejects(issuer.update({ name: "Shop Rewards" }), (e) => e.status === 502);
    chain.state.rejectBroadcast = null;
    assert.equal(sha(await issuer.registry(category)), publication(up).hash, "the registry is unchanged");
    const again = await issuer.update({ name: "Shop Rewards" });
    assert.equal(spends(txOf(chain.state.broadcasts.at(-1)))[0], `${txidOf(upHex)}:0`);
    assert.deepEqual(again.token.history.map((x) => x.name), ["Shop Rewards", "Shop Rewards Club", "Shop Rewards"], "every version, oldest first");
    // And a reward after all that still leaves the newest identity output alone.
    await bch.testReward({ address: shopper.address, amount: 1 });
    assert.ok(!spends(txOf(chain.state.broadcasts.at(-1))).includes(`${txidOf(chain.state.broadcasts.at(-2))}:0`));
  });
});

describe("settings and storage", () => {
  test("coupons and rewards are checked", () => {
    assert.throws(() => checkCoupons([{ category: TOKEN, label: "x", token: "nft", kind: "bch", value: 20 }]), (e) => Boolean(e.errors["0.value"] && e.errors["0.token"]));
    assert.throws(() => checkCoupons([{ category: "nope", kind: "percent", value: 15 }, { category: TOKEN, kind: "percent", value: 95 }]), (e) => Boolean(e.errors["0.category"] && e.errors["1.value"]));
    assert.deepEqual(checkCoupons([{ ...SHOP, category: TOKEN.toUpperCase(), value: "0.01" }]), [{ ...SHOP, units: 1, active: true }]);
    assert.throws(() => checkRewards({ enabled: true, category: "" }), (e) => Boolean(e.errors.category));
    assert.throws(() => checkRewards({ decimals: 0, tokens: 1.5 }), (e) => Boolean(e.errors.tokens));
    assert.equal(checkRewards({ enabled: true, category: TOKEN, decimals: 1, tokens: 1.5 }).tokens, 1.5);
  });

  test("the file store keeps payments, addresses and the token's state across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bch-kit-"));
    try {
      const path = join(dir, "data", "bch.json");
      const one = setup({ store: createFileStore(path) });
      const v = await one.bch.start({ id: "f1", ...ORDER });
      await one.store.putMeta("bch_token", { category: TOKEN });
      const two = setup({ store: createFileStore(path) });
      assert.equal((await two.bch.view("f1")).address, v.address);
      assert.deepEqual(await two.store.getMeta("bch_token"), { category: TOKEN });
      assert.notEqual((await two.bch.start({ id: "f2", ...ORDER })).address, v.address, "the address stays reserved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
