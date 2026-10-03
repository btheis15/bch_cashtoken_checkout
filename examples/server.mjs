/**
 * A small server around the kit (Node's own http, no framework), to see it all work against the real
 * Bitcoin Cash network. Copy what you need into your own backend.
 *
 *   XPUB=xpub6… node examples/server.mjs
 *   curl -X POST localhost:8080/api/orders -d '{"id":"1001","subtotalCents":25}'
 *   curl localhost:8080/api/orders/1001          # the payment screen's data
 *
 * Pay the amount at the address shown (from any BCH wallet) and the next GET shows "paid".
 *
 * Optional, in the environment:
 *   DATA_FILE       where payments, addresses and the token's state are kept (default ./data/bch.json)
 *   COUPONS         your coupons as JSON, e.g.
 *                   '[{"category":"<64 hex>","label":"Shop token","token":"ft","kind":"bch","value":0.01,"symbol":"SHOP"}]'
 *   HOT_WALLET_WIF  the hot wallet's key (npm run new-wallet): rewards, and minting your token
 *   REWARDS         the rewards promotion as JSON, e.g. '{"enabled":true,"category":"<64 hex>","label":"Shop Rewards","symbol":"SHOP","perBch":0.1,"tokens":1}'
 *   PARTNERS        sales partners as JSON, by the code in their link (?s=<code>), with HOT_WALLET_WIF: their share of
 *                   each order through it is paid when you're paid (docs/commissions.md), e.g.
 *                   '{"priya":{"address":"bitcoincash:q…","ratePercent":5}}'. Their addresses are checked against the
 *                   US sanctions list (src/sanctions.js), downloaded daily.
 *   SITE_URL        your website (https://…), where wallets read the token's and receipts' details (/bcmr/<category>.json)
 *   SHOP_NAME       your shop's name (on receipts as CashTokens, and the registries)
 *   ADMIN_TOKEN     protects the /admin routes (Authorization: Bearer <token>)
 *   PORT            default 8080
 *
 * Routes for the payment screen (examples/react/api.ts calls them):
 *   POST /api/orders/:id/renew · /wallet {address} · /quote {category, amount} · /build {address, category, amount}
 *        /submit {hex} · /claim {address} · /receipt {address}
 * For wallets: GET /bcmr/<category>.json
 * For you: GET|POST|PUT /admin/token, GET|POST|PUT /admin/receipts, GET /admin/rewards, POST /admin/rewards/test {address, amount},
 *          GET /admin/orders/:id/commission
 *
 * In a real shop, the order's total comes from your own database (never from the browser), the order id
 * the browser uses is unguessable, and onPaid fulfils the order.
 */
import http from "node:http";
import { createBchChain } from "../src/bch.js";
import { createBchCheckout } from "../src/checkout.js";
import { createFileStore } from "../src/file-store.js";
import { createHotWallet } from "../src/hot-wallet.js";
import { createReceiptIssuer } from "../src/receipts.js";
import { createSanctions } from "../src/sanctions.js";
import { createTokenIssuer } from "../src/token.js";
import { checkCoupons, checkRewards } from "../src/tokens.js";

const env = process.env;
const chain = createBchChain({ log: console.log });
const store = createFileStore(env.DATA_FILE || "./data/bch.json");
const wallet = env.HOT_WALLET_WIF ? createHotWallet({ wif: env.HOT_WALLET_WIF, chain }) : null;
const token = wallet ? createTokenIssuer({ wallet, store, siteUrl: env.SITE_URL, registryName: env.SHOP_NAME || "Token registry" }) : null;
// Sales partners by their link's code; in a real shop they sign up and live in your database.
const partners = JSON.parse(env.PARTNERS || "{}");
let sanctionsList = null;
const sanctions = createSanctions({ getMeta: () => sanctionsList, setMeta: (v) => (sanctionsList = v), log: console.log });
const receipts = wallet ? createReceiptIssuer({ wallet, store, siteUrl: env.SITE_URL, shopName: env.SHOP_NAME || "Receipts" }) : null;

const bch = createBchCheckout({
  xpub: env.XPUB,
  store,
  chain,
  coupons: checkCoupons(JSON.parse(env.COUPONS || "[]")),
  rewards: wallet && env.REWARDS ? { wallet, settings: checkRewards(JSON.parse(env.REWARDS)) } : null,
  receipts,
  commissions: wallet ? { wallet, isBlocked: sanctions.isBlocked, onCommission: (p, c) => console.log(`[commission] order ${p.id}: partner ${c.partnerId} ${c.state}, $${(c.cents / 100).toFixed(2)} (${c.how})`) } : null,
  // Skip your receipt email when the shopper chose the CashToken alone and it's going straight to their wallet.
  onPaid: (p) => console.log(`[paid] order ${p.id}: ${p.receivedSats} sats (tx ${p.payTxs[0]})${bch.receiptReplacesEmail(p) ? ", receipt as a CashToken (no email)" : ""}`),
  onNotice: (p, n) => console.log(`[${n.problem ? "look" : "note"}] order ${p.id}: ${n.message}`),
});
console.log(`Wallet's first receiving address: ${bch.firstAddress()} (check it matches your wallet)`);
if (wallet) console.log(`Hot wallet: ${wallet.info().address} (tokens: ${wallet.info().tokenAddress})`);

const send = (res, status, body, headers = {}) => res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }).end(typeof body === "string" ? body : JSON.stringify(body));
const body = (req) =>
  new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 300_000) reject(new Error("Too large."));
    });
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Error("That isn't JSON."));
      }
    });
  });
const admin = (req) => env.ADMIN_TOKEN && req.headers.authorization === `Bearer ${env.ADMIN_TOKEN}`;

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      const path = url.pathname;
      let m;

      // What wallets show for the token: the exact file whose hash is on chain, readable from any site.
      if (req.method === "GET" && (m = path.match(/^\/bcmr\/([0-9a-f]{64})\.json$/))) {
        const json = (token ? await token.registry(m[1]) : null) ?? (receipts ? await receipts.registry(m[1]) : null);
        return json ? send(res, 200, json, { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" }) : send(res, 404, { error: "Not found" });
      }

      if (req.method === "POST" && path === "/api/orders") {
        const b = await body(req);
        // The partner whose link the shopper came through (b.partner: the code, kept in a cookie by your site).
        const pc = typeof b.partner === "string" && Object.hasOwn(partners, b.partner) ? partners[b.partner] : null;
        const partner = pc ? { id: b.partner, address: pc.address, ratePercent: pc.ratePercent } : null;
        return send(res, 200, await bch.start({ id: String(b.id), label: `Order ${b.id}`, subtotalCents: Number(b.subtotalCents), shippingCents: Number(b.shippingCents ?? 0), taxCents: Number(b.taxCents ?? 0), itemCount: b.itemCount ?? null, number: Number.isInteger(b.number) ? b.number : null, items: Array.isArray(b.items) ? b.items : null, receipt: b.receipt, partner }));
      }
      if (req.method === "GET" && (m = path.match(/^\/api\/orders\/([\w-]+)$/))) return send(res, 200, await bch.check(m[1]));
      if (req.method === "POST" && (m = path.match(/^\/api\/orders\/([\w-]+)\/(renew|wallet|quote|build|submit|claim|receipt)$/))) {
        const [, id, action] = m;
        const b = await body(req);
        if (action === "renew") return send(res, 200, await bch.renew(id));
        if (action === "wallet") return send(res, 200, await bch.walletInfo(id, b.address));
        if (action === "quote") return send(res, 200, await bch.walletQuote(id, b));
        if (action === "build") return send(res, 200, await bch.walletBuild(id, b));
        if (action === "submit") return send(res, 200, await bch.walletSubmit(id, b.hex));
        if (action === "claim") return send(res, 200, await bch.claimReward(id, b.address));
        if (action === "receipt") return send(res, 200, await bch.claimReceipt(id, b.address));
      }

      if (path.startsWith("/admin/")) {
        if (!admin(req)) return send(res, 401, { error: "Set ADMIN_TOKEN and send it as Authorization: Bearer <token>." });
        if (path === "/admin/token") {
          if (!token) return send(res, 409, { error: "Set HOT_WALLET_WIF first (npm run new-wallet)." });
          if (req.method === "GET") return send(res, 200, await token.status());
          if (req.method === "POST") return send(res, 200, await token.create(await body(req)));
          if (req.method === "PUT") return send(res, 200, await token.update(await body(req)));
        }
        if (path === "/admin/receipts") {
          if (!receipts) return send(res, 409, { error: "Set HOT_WALLET_WIF first (npm run new-wallet)." });
          if (req.method === "GET") return send(res, 200, await receipts.status());
          if (req.method === "POST") return send(res, 200, await receipts.create(await body(req)));
          if (req.method === "PUT") return send(res, 200, await receipts.update(await body(req)));
        }
        if (req.method === "GET" && path === "/admin/rewards") return send(res, 200, await bch.rewardsStatus());
        if (req.method === "GET" && (m = path.match(/^\/admin\/orders\/([\w-]+)\/commission$/))) return send(res, 200, await bch.commission(m[1]));
        if (req.method === "POST" && path === "/admin/rewards/test") return send(res, 200, await bch.testReward(await body(req)));
      }
      send(res, 404, { error: "Not found" });
    } catch (e) {
      send(res, e.status ?? 400, { error: e.message, ...(e.errors ? { errors: e.errors } : {}) });
    }
  })
  .listen(Number(env.PORT || 8080), () => console.log(`Listening on http://localhost:${env.PORT || 8080}`));

// Catch anything a notice from the network missed, late payments, double-spends before the first block, rewards to send.
setInterval(() => bch.tick().catch(() => {}), 60_000).unref();
// The US sanctions list, for partners' payout addresses (at most once a day).
if (Object.keys(partners).length) {
  sanctions.refresh().catch(() => {});
  setInterval(() => sanctions.refresh().catch(() => {}), 3_600_000).unref();
}
await bch.watchAll();
