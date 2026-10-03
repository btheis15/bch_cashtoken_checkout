import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deriveHdPath, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeHdPrivateKey, encodeHdPublicKey, hexToBin } from "@bitauth/libauth";
import { addressAt, createBchCheckout, parseXpub } from "../src/checkout.js";
import { createBchPrices } from "../src/bch.js";
import { createMemoryStore } from "../src/memory-store.js";
import { createFakeBchChain, createFakeBchPrices } from "./fakes.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const account = deriveHdPath(deriveHdPrivateNodeFromSeed(hexToBin("000102030405060708090a0b0c0d0e0f")), "m/44'/145'/0'");
const XPUB = encodeHdPublicKey({ node: deriveHdPublicNode(account), network: "mainnet" }).hdPublicKey;
const XPRV = encodeHdPrivateKey({ node: account, network: "mainnet" }).hdPrivateKey;
const wallet = parseXpub(XPUB);
const COUPON = "c0".repeat(32);

/** A checkout against the stand-ins; the price is $400 per BCH. */
function setup(options = {}) {
  const chain = createFakeBchChain();
  const priceApis = createFakeBchPrices({ usd: 400 });
  const store = createMemoryStore();
  const paid = [];
  const notices = [];
  const bch = createBchCheckout({ xpub: XPUB, store, chain, prices: createBchPrices({ fetchImpl: priceApis.fetch }), proofWaitMs: 0, onPaid: (p) => paid.push(p), onNotice: (_p, n) => notices.push(n), ...options });
  const payment = (id) => store.getPayment(id);
  const runOut = async (id) => {
    const p = await store.getPayment(id);
    p.windows.at(-1).expiresAt = new Date(Date.now() - 2 * 60_000).toISOString();
    await store.putPayment(p);
  };
  return { bch, chain, priceApis, store, paid, notices, payment, runOut };
}

describe("payments", () => {
  test("the wallet is an xPub, never a private key", () => {
    assert.throws(() => createBchCheckout({ xpub: XPRV, store: createMemoryStore(), chain: createFakeBchChain() }), /private key/);
    assert.throws(() => createBchCheckout({ xpub: "xpub-nope", store: createMemoryStore(), chain: createFakeBchChain() }), /starts with “xpub”/);
  });

  test("each order gets its own address and price; a payment is accepted at zero-conf", async () => {
    const { bch, chain, paid } = setup();
    const v = await bch.start({ id: "1001", label: "Order 1001", subtotalCents: 6000, otherCents: 600 });
    const a0 = addressAt(wallet, 0);
    assert.equal(v.state, "waiting");
    assert.equal(v.address, a0.address);
    assert.equal(v.amountBch, "0.165", "$66 at $400");
    assert.equal(v.uri, `${a0.address}?amount=0.165&message=Order%201001`);
    assert.ok(chain.state.watched.has(a0.scripthash));
    const txid = chain.pay(a0.address, { sats: 16_500_000 });
    await sleep(20);
    assert.equal((await bch.view("1001")).state, "paid");
    assert.equal(paid.length, 1);
    assert.equal(paid[0].payTxs[0], txid);
    chain.confirm(txid);
    await sleep(20);
    assert.ok(!chain.state.watched.has(a0.scripthash), "no longer watched once in a block");
  });

  test("an address the wallet already used is skipped", async () => {
    const { bch, chain } = setup();
    chain.pay(addressAt(wallet, 0).address, { sats: 1000, notify: false });
    const v = await bch.start({ id: "a", subtotalCents: 1000 });
    assert.equal(v.address, addressAt(wallet, 1).address);
  });

  test("it listens for a double-spend proof first: none, and it's paid a moment later", async () => {
    const { bch, chain, payment } = setup({ proofWaitMs: 300 });
    const v = await bch.start({ id: "b", subtotalCents: 1000 });
    chain.pay(v.address, { sats: (await payment("b")).windows[0].sats });
    await sleep(30);
    assert.equal((await bch.view("b")).state, "arrived");
    await sleep(500);
    assert.equal((await bch.view("b")).state, "paid");
  });

  test("with a double-spend proof, the payment is held until a block settles it", async () => {
    const { bch, chain, payment, paid } = setup();
    const v = await bch.start({ id: "c", subtotalCents: 1000 });
    const txid = chain.pay(v.address, { sats: (await payment("c")).windows[0].sats, notify: false });
    chain.proof(txid);
    assert.equal((await bch.check("c")).state, "checking");
    assert.ok((await payment("c")).problems.some((p) => p.kind === "dropped"));
    chain.confirm(txid);
    await sleep(20);
    assert.equal((await bch.view("c")).state, "paid");
    assert.equal((await payment("c")).problems.length, 0);
    assert.equal(paid.length, 1);
  });

  test("a payment from a wallet proofs can't cover goes through, flagged until a block", async () => {
    const { bch, chain, payment } = setup();
    const v = await bch.start({ id: "d", subtotalCents: 1000 });
    const txid = chain.pay(v.address, { sats: (await payment("d")).windows[0].sats, script: true });
    await sleep(20);
    assert.ok((await payment("d")).problems.some((p) => p.kind === "unprotected"));
    chain.confirm(txid);
    await sleep(20);
    assert.equal((await payment("d")).problems.length, 0);
  });

  test("a payment that vanishes before its block is flagged", async () => {
    const { bch, chain, payment } = setup();
    const v = await bch.start({ id: "e", subtotalCents: 1000 });
    const txid = chain.pay(v.address, { sats: (await payment("e")).windows[0].sats });
    await sleep(20);
    chain.drop(txid);
    await sleep(20);
    assert.ok((await payment("e")).problems.some((p) => p.kind === "dropped"));
  });

  test("part of a payment asks for the rest; if the price runs out first, no new price", async () => {
    const { bch, chain, payment, runOut } = setup();
    const v = await bch.start({ id: "f", subtotalCents: 6000, otherCents: 600 });
    chain.pay(v.address, { sats: 6_500_000 });
    await sleep(20);
    let now = await bch.view("f");
    assert.equal(now.state, "partial");
    assert.equal(now.amountBch, "0.1", "what's left");
    await runOut("f");
    await bch.check("f");
    now = await bch.view("f");
    assert.equal(now.state, "expired_partial");
    await assert.rejects(bch.renew("f"), /Part of the payment/);
    assert.ok((await payment("f")).problems.some((p) => p.kind === "partial"));
  });

  test("an ended price can be renewed (same address); a full payment just after it ended still counts", async () => {
    const { bch, chain, payment, runOut, priceApis } = setup();
    const v = await bch.start({ id: "g", subtotalCents: 1000 });
    await runOut("g");
    assert.equal((await bch.check("g")).state, "expired");
    priceApis.set(380);
    const r = await bch.renew("g");
    assert.equal(r.state, "waiting");
    assert.equal(r.address, v.address);
    const late = await bch.start({ id: "h", subtotalCents: 1000 });
    const sats = (await payment("h")).windows[0].sats;
    await runOut("h");
    chain.pay(late.address, { sats });
    await sleep(20);
    assert.equal((await bch.view("h")).state, "paid");
  });

  test("a closed order's address is handed out again after a week, unless a late payment turned up", async () => {
    const { bch, chain, store, payment } = setup();
    const a = await bch.start({ id: "i", subtotalCents: 1000 });
    const b = await bch.start({ id: "j", subtotalCents: 1000 });
    await bch.close("i");
    await bch.close("j");
    const c = await bch.start({ id: "k", subtotalCents: 1000 });
    assert.notEqual(c.address, a.address, "not within the week");
    for (const x of store._addresses().filter((x) => x.state === "free")) await store.setAddress(x.wallet, x.index, { releasedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    chain.pay(a.address, { sats: (await payment("i")).windows[0].sats, notify: false });
    const d = await bch.start({ id: "l", subtotalCents: 1000 });
    assert.equal(d.address, b.address, "a's address was paid late, so b's is used");
    await sleep(20);
    const lateOrder = await payment("i");
    assert.equal(lateOrder.status, "paid");
    assert.ok(lateOrder.problems.some((p) => p.kind === "late"));
  });
});

describe("CashTokens coupons", () => {
  const coupons = [
    { category: COUPON, label: "Loyal friend 15%", token: "ft", units: 1, kind: "percent", value: 15, symbol: "SHOP" },
    { category: "d1".repeat(32), label: "Ten dollars off", token: "nft", kind: "amount", value: 10 },
  ];

  test("a coupon sent to the order's token address takes the discount off and gives a new price", async () => {
    const { bch, chain, payment } = setup({ coupons: [coupons[0]] });
    const v = await bch.start({ id: "m", subtotalCents: 6000, otherCents: 600 });
    assert.deepEqual(v.coupon, { address: addressAt(wallet, 0).tokenAddress, uri: `${addressAt(wallet, 0).tokenAddress}?c=${COUPON}&f=1`, coupons: [{ label: "Loyal friend 15%", off: "15% off", send: "1 SHOP" }], stack: false });
    chain.pay(v.coupon.address, { token: { category: "ab".repeat(32), amount: 3 } });
    chain.pay(v.coupon.address, { token: { category: COUPON, amount: 1 } });
    await sleep(30);
    const after = await bch.view("m");
    assert.deepEqual(after.applied, { label: "Loyal friend 15%", discountCents: 900 });
    assert.equal(after.usdCents, 5700);
    assert.equal(after.amountBch, "0.1425");
    assert.equal(after.coupon, null, "one per order");
    const p = await payment("m");
    assert.ok(p.events.some((e) => /isn't one of your coupons/.test(e.message)));
    chain.pay(v.coupon.address, { token: { category: COUPON, amount: 1 } });
    await sleep(20);
    assert.equal((await payment("m")).discountCents, 900, "a second coupon doesn't count");
    chain.pay(v.address, { sats: 14_250_000 });
    await sleep(20);
    assert.equal((await bch.view("m")).state, "paid");
  });

  test("onCoupon can work out the new total (e.g. sales tax again)", async () => {
    const { bch, chain } = setup({ coupons: [coupons[0]], onCoupon: async (p, _c, discount) => p.subtotalCents - discount + 600 + 100 });
    const v = await bch.start({ id: "n", subtotalCents: 6000, otherCents: 1200 });
    chain.pay(v.coupon.address, { token: { category: COUPON, amount: 1 } });
    await sleep(30);
    assert.equal((await bch.view("n")).usdCents, 5800);
  });

  test("a minting NFT is never a coupon, and a coupon after payment isn't applied", async () => {
    const { bch, chain, payment } = setup({ coupons });
    const v = await bch.start({ id: "o", subtotalCents: 2000 });
    assert.equal(v.coupon.uri, v.coupon.address, "two kinds: just the address");
    chain.pay(v.coupon.address, { token: { category: "d1".repeat(32), nft: { capability: "minting", commitment: "" } } });
    await sleep(20);
    assert.equal((await payment("o")).discountCents, 0);
    chain.pay(v.address, { sats: (await payment("o")).windows.at(-1).sats });
    await sleep(20);
    chain.pay(v.coupon.address, { token: { category: "d1".repeat(32), nft: { capability: "none", commitment: "07" } } });
    await sleep(20);
    const p = await payment("o");
    assert.equal(p.discountCents, 0);
    assert.ok(p.problems.some((x) => x.kind === "coupon"));
  });
});

describe("prices", () => {
  test("only used when at least two exchanges agree", async () => {
    const f = createFakeBchPrices({ usd: 400 });
    f.set(401, ["Kraken"]);
    assert.equal((await createBchPrices({ fetchImpl: f.fetch }).usdPerBch()).usd, 400, "the middle one");
    f.state.down = new Set(["Coinbase", "Kraken", "Bitstamp"]);
    await assert.rejects(createBchPrices({ fetchImpl: f.fetch }).usdPerBch(), /at least two/);
    f.state.down = new Set(["Coinbase", "Kraken"]);
    f.set(460, ["CoinGecko"]);
    await assert.rejects(createBchPrices({ fetchImpl: f.fetch }).usdPerBch(), /disagree/);
  });
});
