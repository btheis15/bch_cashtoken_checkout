# bch_cashtoken_checkout

Accept **Bitcoin Cash** on your own website, paid straight into your own wallet. Let loyal customers redeem **CashTokens coupons** you mint yourself.

- **No payment company, account or fees.** You give your server your wallet's
  **xPub**. That extended *public* key lists the wallet's addresses but can't spend.
- **Each order gets its own address** in your wallet. Your server watches the
  blockchain itself through the community's public Fulcrum servers.
- **Zero-conf, as the BCH community expects.** A payment counts seconds after
  it reaches the network. Before that, the server listens briefly for a
  **double-spend proof**. See [docs/zero-conf.md](docs/zero-conf.md).
- **CashTokens coupons.** The shopper sends one of your coupon tokens to the
  order's address before paying. The discount comes off and the price updates.
  See [docs/coupons.md](docs/coupons.md).
- **A payment screen people can use:**
  - a QR code on a computer, "Open in my wallet app" on a phone
  - copy buttons and a price countdown
  - live status, part payments, and "get a new price"

This kit was built for [Om Threads Boutique](https://omthreadsboutique.vercel.app)'s checkout, and is shared here so other shops can do the same.

```
 your checkout ──▶ start(order): address xpub/0/<n> reserved, BCH price from the exchanges
 payment screen ─▶ QR / "open in wallet"  (bitcoincash:q…?amount=…&message=…)
 shopper's wallet ─▶ the network ──Fulcrum notice──▶ check(order):
                       · enough arrived → listen ~3 s for a double-spend proof → paid (onPaid)
                       · a double-spend proof → held until a block settles it
                       · less than asked → the screen asks for the rest
                       · a coupon token (to the z… form of the same address) → discount, new price
```

## What's here

| Path | What it is |
|---|---|
| [`src/bch.js`](src/bch.js) | Wallet addresses from an xPub, exchange prices (two must agree), the Fulcrum connection (prefers servers with double-spend proofs), and reading payments, tokens and proof coverage from raw transactions. |
| [`src/checkout.js`](src/checkout.js) | The payment engine: `start`, `view`, `check`, `renew`, `close`, `tick`, with the zero-conf and coupon rules. |
| [`src/memory-store.js`](src/memory-store.js) | The storage interface, kept in memory. Use your database in production; [docs/integration.md](docs/integration.md) has a SQL schema. |
| [`examples/server.mjs`](examples/server.mjs) | A minimal JSON API around it (Node's `http`, no framework). |
| [`examples/react/BchPay.tsx`](examples/react/BchPay.tsx) | The payment screen as a React component, with [`bch-pay.css`](examples/react/bch-pay.css). |
| [`test/`](test) | Tests against a stand-in network that builds real BCH transactions (libauth). |
| [`docs/`](docs) | [Integration](docs/integration.md) · [Zero-conf and double-spend proofs](docs/zero-conf.md) · [CashTokens coupons](docs/coupons.md) · [Wallets](docs/wallets.md) |

## Try it

You need Node 22+ and a Bitcoin Cash wallet that shows its xPub. Use a wallet
just for the shop:

- **Selene:** Settings → Wallet → xPub (to make one just for the shop, add a new wallet)
- **Electron Cash:** Wallet → Information → Master Public Key

```sh
npm install
npm test
XPUB=xpub6… npm run example
curl -X POST localhost:8080/api/orders -d '{"id":"1001","subtotalCents":25}'
curl localhost:8080/api/orders/1001
```

The first command prints your wallet's first receiving address; check it
matches your wallet. Send the amount shown from any BCH wallet. Within a few
seconds the order shows `"state": "paid"`, and the money is in your wallet.

## In your shop

```js
import { createBchCheckout } from "bch-cashtoken-checkout";
import { createMemoryStore } from "bch-cashtoken-checkout/memory-store";

const bch = createBchCheckout({
  xpub: process.env.BCH_XPUB,          // keep it private: it reveals your wallet's history
  store: createMemoryStore(),          // your database in production
  coupons: [{ category: "<token category id>", label: "Loyal customer 15%", token: "ft", units: 1, kind: "percent", value: 15 }],
  onPaid: (p) => fulfil(p.id),         // lower stock, email the receipt…
  onNotice: (p, n) => n.problem && alertOwner(p.id, n.message),
});

// At checkout, with the total from your own database (never from the browser):
const view = await bch.start({ id: order.id, label: `Order ${order.number}`, subtotalCents: order.itemsCents, otherCents: order.shippingCents + order.taxCents });
// The payment screen polls your API, which returns bch.view(id) (or bch.check(id), throttled).
// "Get a new price": bch.renew(id). Abandoned or sold out: bch.close(id).
setInterval(() => bch.tick(), 60_000);
await bch.watchAll();                  // after a restart
```

Read [docs/integration.md](docs/integration.md) before going live. It covers
the store interface, the background job, test orders (BCH has no test
network), refunds, and a security checklist.

## Decisions, and why

- **xPub, not a payment processor.** Money goes straight to the merchant, and
  nothing can spend it but the merchant's wallet. A private key (xprv) is
  refused outright.
- **Zero-conf with double-spend proofs:**
  - BCH nodes keep the first-seen transaction, don't do replace-by-fee, and relay DSProofs.
  - The DSProof spec tells merchants to wait a few seconds for a proof, which
    arrive in under 3 seconds, before accepting.
  - Payments proofs can't cover (from script or multisig wallets) still go
    through, flagged "wait for a block before shipping".
  - [docs/zero-conf.md](docs/zero-conf.md) has the sources.
- **Two agreeing exchanges.** Prices come from Coinbase, Kraken, Bitstamp and
  CoinGecko. The middle one is used, and only when at least two agree within
  1.5%; otherwise the checkout says BCH is unavailable rather than guess. A
  price is held 30 minutes.
- **Addresses are reused carefully.**
  - An abandoned checkout's address is handed out again after a week, if nothing ever arrived.
  - That keeps unused addresses within the 20 a wallet looks ahead (BIP44's gap limit; Selene uses 20).
  - An address that has ever received anything is never handed out again.
- **Coupons move.** A coupon token is sent to the merchant (to the order's
  address), so it can't be used twice. No signing step or registry of used
  serials is needed, and it works from any wallet that holds CashTokens.

## License

MIT. Dependencies: [libauth](https://github.com/bitauth/libauth) (MIT) and
[@electrum-cash/network](https://gitlab.com/electrum-cash/network) (MIT). The
example component uses [uqr](https://github.com/unjs/uqr) (MIT).
