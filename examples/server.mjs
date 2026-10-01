/**
 * A minimal server around the checkout (Node's own http, no framework), to
 * see it work against the real Bitcoin Cash network:
 *
 *   XPUB=xpub6… node examples/server.mjs
 *   curl -X POST localhost:8080/api/orders -d '{"id":"1001","subtotalCents":25}'
 *   curl localhost:8080/api/orders/1001          # the payment screen's data
 *   curl -X POST localhost:8080/api/orders/1001/renew
 *
 * Pay the amount at the address shown (from any BCH wallet) and the next
 * GET shows "paid". COUPONS may hold your coupons as JSON, e.g.
 *   COUPONS='[{"category":"<64 hex>","label":"15% off","token":"ft","units":1,"kind":"percent","value":15}]'
 *
 * In a real shop, the order's total comes from your own database (never from
 * the browser), and onPaid fulfils the order.
 */
import http from "node:http";
import { createBchCheckout } from "../src/checkout.js";
import { createMemoryStore } from "../src/memory-store.js";

const bch = createBchCheckout({
  xpub: process.env.XPUB,
  store: createMemoryStore(),
  coupons: JSON.parse(process.env.COUPONS || "[]"),
  onPaid: (p) => console.log(`[paid] order ${p.id}: ${p.receivedSats} sats (tx ${p.payTxs[0]})`),
  onNotice: (p, n) => console.log(`[${n.problem ? "look" : "note"}] order ${p.id}: ${n.message}`),
});
console.log(`Wallet's first receiving address: ${bch.firstAddress()} (check it matches your wallet)`);

const json = (res, status, body) => res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
const body = (req) => new Promise((resolve) => {
  let s = "";
  req.on("data", (c) => (s += c));
  req.on("end", () => resolve(s ? JSON.parse(s) : {}));
});

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      let m;
      if (req.method === "POST" && url.pathname === "/api/orders") {
        const b = await body(req);
        return json(res, 200, await bch.start({ id: String(b.id), label: `Order ${b.id}`, subtotalCents: Number(b.subtotalCents), otherCents: Number(b.otherCents ?? 0) }));
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/api\/orders\/([\w-]+)$/))) return json(res, 200, await bch.check(m[1]));
      if (req.method === "POST" && (m = url.pathname.match(/^\/api\/orders\/([\w-]+)\/renew$/))) return json(res, 200, await bch.renew(m[1]));
      json(res, 404, { error: "Not found" });
    } catch (e) {
      json(res, 400, { error: e.message });
    }
  })
  .listen(Number(process.env.PORT || 8080), () => console.log(`Listening on http://localhost:${process.env.PORT || 8080}`));

// Catch anything a notice from the network missed, late payments, double-spends before the first block.
setInterval(() => bch.tick().catch(() => {}), 60_000).unref();
await bch.watchAll();
