import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { binToHex, cashAddressToLockingBytecode, decodeTransaction, deriveHdPath, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeHdPublicKey, hexToBin, lockingBytecodeToBase58Address } from "@bitauth/libauth";
import { createBchPrices } from "../src/bch.js";
import { createBchCheckout } from "../src/checkout.js";
import { createHotWallet, newWalletKey } from "../src/hot-wallet.js";
import { createMemoryStore } from "../src/memory-store.js";
import { bchAddressesIn, createSanctions, lockingOf } from "../src/sanctions.js";
import { createFakeBchChain, createFakeBchPrices, createFakeWallet } from "./fakes.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const account = deriveHdPath(deriveHdPrivateNodeFromSeed(hexToBin("000102030405060708090a0b0c0d0e0f")), "m/44'/145'/0'");
const XPUB = encodeHdPublicKey({ node: deriveHdPublicNode(account), network: "mainnet" }).hdPublicKey;
// $60 of items (at your sale price) and $6 shipping: $66 at $400 per BCH is 0.165 BCH.
const ORDER = { subtotalCents: 6000, shippingCents: 600, itemCount: 1, shippingLabel: "Standard" };
const seller = createFakeWallet(41);
const PARTNER = { id: "priya", address: seller.address, ratePercent: 5 };

/** A checkout with commissions, its hot wallet funded; the price is $400 per BCH. */
function setup({ fund = true, isBlocked } = {}) {
  const chain = createFakeBchChain();
  const store = createMemoryStore();
  const hot = createHotWallet({ wif: newWalletKey(), chain });
  if (fund) chain.fund(hot.info().address, { sats: 5_000_000 });
  const reported = [];
  const bch = createBchCheckout({
    xpub: XPUB, store, chain, prices: createBchPrices({ fetchImpl: createFakeBchPrices({ usd: 400 }).fetch }), proofWaitMs: 0,
    commissions: { wallet: hot, isBlocked, onCommission: (p, c) => reported.push({ id: p.id, ...c }) },
  });
  return { bch, chain, store, hot, reported, payment: (id) => store.getPayment(id) };
}
const outputsOf = (hex) => decodeTransaction(hexToBin(hex)).outputs.map((o) => [binToHex(o.lockingBytecode), Number(o.valueSatoshis)]);

describe("commissions for sales partners", () => {
  test("paid by QR code: you get it all, and the partner's 5% of the items goes from the hot wallet at once", async () => {
    const { bch, chain, payment, reported } = setup();
    await bch.start({ id: "q1", ...ORDER, partner: PARTNER });
    const sent0 = chain.state.broadcasts.length;
    chain.pay((await payment("q1")).address, { sats: (await payment("q1")).windows.at(-1).sats });
    await sleep(60);
    const p = await payment("q1");
    assert.equal(p.status, "paid");
    assert.equal(p.commission.state, "sent");
    assert.equal(p.commission.baseCents, 6000, "the items, never shipping or tax");
    assert.equal(p.commission.cents, 300);
    assert.equal(p.commission.sats, 750_000, "$3.00 at the $400 the shopper paid at");
    assert.deepEqual(outputsOf(chain.state.broadcasts[sent0])[0], [seller.lockingBytecode, 750_000]);
    assert.equal(reported.length, 1, "reported once, for your records");
    const c = await bch.commission("q1");
    assert.equal(c.how, "wallet");
    assert.equal(c.yourCents, 6600 - 300);
    await bch.tick();
    assert.equal(chain.state.broadcasts.length, sent0 + 1, "paid once");
  });

  test("paid from a connected wallet: one transaction pays you your share and the partner theirs", async () => {
    const { bch, chain, payment, reported } = setup({ fund: false });
    await bch.start({ id: "w1", ...ORDER, partner: PARTNER });
    const p0 = await payment("w1");
    const total = p0.windows.at(-1).sats;
    const payer = createFakeWallet(51);
    chain.fund(payer.address, { sats: 50_000_000 });
    const built = await bch.walletBuild("w1", { address: payer.address });
    assert.equal(built.amountBch, "0.165", "the shopper sees the same total");
    const signed = payer.sign(built.request);
    assert.deepEqual(outputsOf(signed.hex).slice(0, 2), [[binToHex(cashAddressToLockingBytecode(p0.address).bytecode), total - 750_000], [seller.lockingBytecode, 750_000]]);
    // A version that shortchanges the partner isn't sent.
    const req = payer.revive(built.request);
    req.transaction.outputs[1].valueSatoshis = 1000n;
    const enc = (x) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `<bigint: ${v}n>` : v instanceof Uint8Array ? `<Uint8Array: 0x${binToHex(v)}>` : v)));
    await assert.rejects(bch.walletSubmit("w1", payer.sign(enc(req)).hex), (e) => e.status === 409);
    const sent0 = chain.state.broadcasts.length;
    await bch.walletSubmit("w1", signed.hex);
    await sleep(60);
    const p = await payment("w1");
    assert.equal(p.status, "paid", "the partner's share counts toward the payment");
    assert.equal(p.commission.how, "split");
    assert.equal(p.commission.state, "sent");
    assert.equal(chain.state.broadcasts.length, sent0 + 1, "only the shopper's transaction: the hot wallet (empty here) isn't needed");
    assert.equal(reported[0].how, "split");
  });

  test("paying the partner extra doesn't pay the order: only their share counts", async () => {
    const { bch, chain, payment } = setup();
    await bch.start({ id: "x1", ...ORDER, partner: PARTNER });
    const payer = createFakeWallet(52);
    chain.fund(payer.address, { sats: 50_000_000 });
    const req = payer.revive((await bch.walletBuild("x1", { address: payer.address })).request);
    const shop = req.transaction.outputs[0].valueSatoshis;
    req.transaction.outputs[0].valueSatoshis = 2000n;
    req.transaction.outputs[1].valueSatoshis += shop - 2000n;
    const enc = (x) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `<bigint: ${v}n>` : v instanceof Uint8Array ? `<Uint8Array: 0x${binToHex(v)}>` : v)));
    await chain.broadcast(payer.sign(enc(req)).hex);
    await sleep(60);
    assert.notEqual((await payment("x1")).status, "paid");
  });

  test("the share is on the items (not shipping); maxCents caps it, owedCents comes off first", async () => {
    const { bch, chain, payment } = setup();
    await bch.start({ id: "c1", ...ORDER, partner: { ...PARTNER, maxCents: 250, owedCents: 100 } });
    chain.pay((await payment("c1")).address, { sats: (await payment("c1")).windows.at(-1).sats });
    await sleep(60);
    const c = (await payment("c1")).commission;
    assert.deepEqual([c.baseCents, c.earnedCents, c.offsetCents, c.cents], [6000, 250, 100, 150], "$3 capped at $2.50, then $1 repaid: $1.50 sent");
  });

  test("a payment proofs can't vouch for (a script wallet) waits one block before the hot wallet pays", async () => {
    const { bch, chain, payment } = setup();
    await bch.start({ id: "s1", ...ORDER, partner: PARTNER });
    const txid = chain.pay((await payment("s1")).address, { sats: (await payment("s1")).windows.at(-1).sats, script: true });
    await sleep(60);
    assert.equal((await payment("s1")).commission.state, "pending");
    assert.match((await bch.commission("s1")).waiting, /one block/);
    chain.confirm(txid);
    await sleep(60);
    await bch.tick();
    assert.equal((await payment("s1")).commission.state, "sent");
  });

  test("a blocked address (e.g. on the US sanctions list) gets no split and nothing sent", async () => {
    const { bch, chain, payment } = setup({ isBlocked: (a) => a === seller.address });
    await bch.start({ id: "b1", ...ORDER, partner: PARTNER });
    const payer = createFakeWallet(53);
    chain.fund(payer.address, { sats: 50_000_000 });
    const built = await bch.walletBuild("b1", { address: payer.address });
    assert.ok(!outputsOf(payer.sign(built.request).hex).some(([lb]) => lb === seller.lockingBytecode), "no split to a blocked address");
    await bch.walletSubmit("b1", payer.sign(built.request).hex);
    await sleep(60);
    const c = (await payment("b1")).commission;
    assert.equal(c.state, "cancelled");
    assert.match(c.note, /blocked/);
  });

  test("the sanctions list: BCH addresses in OFAC's SDN list (CashAddr or legacy) are blocked; a failed download keeps the last list", async () => {
    const listed = createFakeWallet(61);
    const legacy = lockingBytecodeToBase58Address(hexToBin(createFakeWallet(62).lockingBytecode), "mainnet");
    const filler = Array.from({ length: 200 }, (_, i) => `${i},"PERSON ${i}","individual","SDGT","-0-","-0-","-0-","-0-","-0-","-0-","-0-","DOB 1970."`).join("\n");
    const csv = `${filler}\n36001,"EXAMPLE","individual","CYBER2","-0-","-0-","-0-","-0-","-0-","-0-","-0-","Digital Currency Address - BCH ${listed.address}; Digital Currency Address - BCH ${legacy}; alt. Digital Currency Address - XBT 1BoatSLRHtKNngkdXEeobR76b53LETtpyT;"`;
    assert.equal(bchAddressesIn(csv).length, 2);
    let saved = null;
    let down = false;
    let t = Date.parse("2026-10-03T12:00:00Z");
    const s = createSanctions({ getMeta: () => saved, setMeta: (v) => (saved = v), fetchImpl: async () => (down ? new Response("oops", { status: 500 }) : new Response(csv)), now: () => t });
    assert.equal(await s.refresh(), true);
    assert.equal(s.isBlocked(listed.address), true);
    assert.equal(s.isBlocked(createFakeWallet(62).address), true, "the legacy entry matches the CashAddr form");
    assert.equal(s.isBlocked(seller.address), false);
    assert.equal(lockingOf("not an address"), null);
    assert.equal(await s.refresh(), false, "once a day");
    t += 2 * 86_400_000;
    down = true;
    assert.equal(await s.refresh(), false);
    assert.equal(s.isBlocked(listed.address), true, "the last list stays");
  });
});
