# bch_cashtoken_checkout

Accept **Bitcoin Cash** on your own website, paid straight into your own wallet. Give loyal customers **CashTokens** they hold in their own wallets: coupons at checkout, and rewards after they pay, in a token you mint yourself.

Fork it, copy what you need into your shop, and make the payment screen look like your site.

- **No payment company, account or fees.** You give your server your wallet's
  **xPub**. That extended *public* key lists the wallet's addresses but can't spend.
- **Each order gets its own address** in your wallet. Your server watches the
  blockchain itself through the community's public Fulcrum servers.
- **Zero-conf, as the BCH community expects.** A payment counts seconds after
  it reaches the network. Before that, the server listens briefly for a
  **double-spend proof**. See [docs/zero-conf.md](docs/zero-conf.md).
- **CashTokens coupons.** Percent or dollar coupons, one per order. Or
  **BCH-valued tokens** (each worth, say, 0.01 BCH off) that add up, a few at
  a time. Sales tax is worked out on the lower price. See [docs/coupons.md](docs/coupons.md).
- **Connect wallet.** Cashonize, Paytaca and Zapit connect over
  WalletConnect. The shopper picks how many tokens to use on a slider, then
  approves **one transaction** that pays the BCH and spends the tokens
  together. See [docs/wallet-connect.md](docs/wallet-connect.md).
- **Rewards.** Cash back in your own token after a BCH payment, such as 1
  token for every 0.1 BCH. It's sent straight back to a connected wallet, or
  claimed on the order page. See [docs/rewards.md](docs/rewards.md).
- **Receipts as CashTokens.** The shopper picks email, CashToken or both. The
  CashToken is a one-of-a-kind NFT in their wallet ("Receipt #1042"), and what
  wallets show is published with each one, with nothing personal on chain. On
  screen, the paper receipt folds into a coin that's thrown into their
  wallet. See [docs/receipts.md](docs/receipts.md).
- **Mint your own token from your server.** The whole supply goes into a
  small hot wallet, along with what wallets show for the token: name, symbol,
  icon and description, published on chain as a BCMR registry. You can update
  it later. See [docs/token.md](docs/token.md).
- **A payment screen people enjoy using.** It's React with plain CSS, themed
  with CSS variables. See [docs/payment-screen.md](docs/payment-screen.md).
  - A pay sheet that slides up, with "Connect wallet" and "Any wallet" (QR code or "Open in my wallet app")
  - A QR code that ripples in around your logo, and digits that roll into place
  - A price-hold bar that runs down, and copy buttons that tick
  - The order in BCH, line by line, which updates as the token slider moves
  - A "Payment received!" burst when the payment lands, then the reward card
  - The receipt folding into a coin, spinning, and thrown into the shopper's wallet

```
 your checkout ──▶ start(order): address xpub/0/<n> reserved, BCH price from the exchanges
 payment screen ─▶ Connect wallet ─▶ walletBuild: one transaction (BCH + tokens) ─▶ the wallet signs and sends it
                └▶ Any wallet: QR / "open in wallet"  (bitcoincash:q…?amount=…&message=…)
 the network ──Fulcrum notice──▶ check(order):
                       · enough arrived → listen ~3 s for a double-spend proof → paid (onPaid) → reward
                       · a double-spend proof → held until a block settles it
                       · less than asked → the screen asks for the rest
                       · coupon tokens (to the z… form of the same address) → discount, new price
 rewards ─▶ from your hot wallet: back to the wallet that paid, or claimed on the order page
 your token ─▶ minted from the hot wallet; wallets read /bcmr/<category>.json (its hash is on chain)
```

## What's here

| Path | What it is |
|---|---|
| [`src/checkout.js`](src/checkout.js) | The payment engine: `start`, `view`, `check`, `renew`, `close`, `tick`. It has the zero-conf and coupon rules, Connect wallet (`walletInfo`, `walletQuote`, `walletBuild`, `walletSubmit`) and rewards (`claimReward`, `rewardsStatus`, `testReward`). |
| [`src/bch.js`](src/bch.js) | The Bitcoin Cash layer. Wallet addresses from an xPub, and exchange prices (two must agree). The Fulcrum connection, which prefers servers with double-spend proofs. Reading payments and tokens from raw transactions. Building, signing and checking transactions (WalletConnect payments, rewards, minting) with the BCH virtual machine. BCMR publications. |
| [`src/tokens.js`](src/tokens.js) | Token amounts, plus `checkCoupons` and `checkRewards` to validate your settings. |
| [`src/hot-wallet.js`](src/hot-wallet.js) | The small wallet whose key is on your server. It sends rewards and mints your token, one send at a time, and never spends the token's identity output. |
| [`src/rewards.js`](src/rewards.js) | The rewards engine, used by `createBchCheckout({ rewards })`. |
| [`src/receipts.js`](src/receipts.js) | Receipts as CashTokens: the collection (a minting baton in the hot wallet), and each receipt minted with the registry that lists it. |
| [`src/token.js`](src/token.js) | Minting your token and updating what wallets show for it (CashTokens genesis, CHIP-BCMR authchain). |
| [`src/memory-store.js`](src/memory-store.js), [`src/file-store.js`](src/file-store.js) | The storage interface, in memory or in a JSON file. Use your database in production; [docs/integration.md](docs/integration.md) has a SQL schema. |
| [`examples/server.mjs`](examples/server.mjs) | A JSON API around all of it (Node's `http`, no framework): checkout, Connect wallet, rewards, the BCMR registry, and admin routes for minting. |
| [`examples/react/`](examples/react) | The payment screen: `BchPay`, `PaySheet`, `BchRewardCard`, and `ReceiptToken` and `ReceiptChoice`, plus the WalletConnect connector, the API client and `bch-pay.css`. |
| [`test/`](test) | Tests against a stand-in network that builds real BCH transactions (libauth). Wallet payments, rewards and minting are signed and run through the BCH virtual machine. |
| [`docs/`](docs) | [Integration](docs/integration.md) · [Zero-conf](docs/zero-conf.md) · [Coupons](docs/coupons.md) · [Connect wallet](docs/wallet-connect.md) · [Rewards](docs/rewards.md) · [Receipts](docs/receipts.md) · [Your token](docs/token.md) · [Payment screen](docs/payment-screen.md) · [Wallets](docs/wallets.md) |

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

The server prints your wallet's first receiving address; check it matches your
wallet. Send the amount shown from any BCH wallet. Within a few seconds the
order shows `"state": "paid"`, and the money is in your wallet.

Then add the rest:

1. `npm run new-wallet` makes the hot wallet's key. Restart with
   `HOT_WALLET_WIF=… SITE_URL=https://your.shop ADMIN_TOKEN=…`, and send the
   hot wallet about 0.0002 BCH.
2. Mint your token:
   ```sh
   curl -X POST localhost:8080/admin/token -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"name":"Shop Rewards","symbol":"SHOP","supply":1000000,"icon":"https://your.shop/token.png"}'
   ```
3. Use its category ID in `COUPONS` and `REWARDS` (see the top of
   [`examples/server.mjs`](examples/server.mjs)), and serve `/bcmr/*` from
   your website.

## In your shop

```js
import { createBchCheckout } from "bch-cashtoken-checkout";
import { createBchChain } from "bch-cashtoken-checkout/bch";
import { createHotWallet } from "bch-cashtoken-checkout/hot-wallet";

const chain = createBchChain();                       // shared by everything below
const wallet = createHotWallet({ wif: process.env.BCH_HOT_WALLET_WIF, chain });

const bch = createBchCheckout({
  xpub: process.env.BCH_XPUB,                         // keep it private: it reveals your wallet's history
  store: myDatabaseStore,                             // see src/memory-store.js for the interface
  chain,
  coupons: () => settings.bchCoupons,                 // e.g. [{ category, label: "Shop token", token: "ft", kind: "bch", value: 0.01, symbol: "SHOP" }]
  rewards: { wallet, settings: () => settings.bchRewards }, // e.g. { enabled: true, category, symbol: "SHOP", perBch: 0.1, tokens: 1 }
  onCoupon: async (payment, coupon, discountCents) => recalcTax(payment, discountCents), // → { totalCents, taxCents }
  onPaid: (p) => fulfil(p.id),                        // lower stock, email the receipt…
  onNotice: (p, n) => n.problem && alertOwner(p.id, n.message),
});

// At checkout, with the amounts from your own database (never from the browser):
const view = await bch.start({ id: order.id, label: `Order ${order.number}`, subtotalCents, shippingCents, taxCents, itemCount });
// The payment screen polls your API, which returns bch.check(id) (throttled) or bch.view(id).
setInterval(() => bch.tick(), 60_000);
await bch.watchAll();                                 // after a restart
```

Read [docs/integration.md](docs/integration.md) before going live. It covers
the store interface, the background job, test orders (BCH has no test
network), refunds, and a security checklist.

## Decisions, and why

- **xPub, not a payment processor.** Money goes straight to the merchant, and
  nothing on the server can spend it. A private key (xprv) is refused outright.
  The only key on the server belongs to the **hot wallet**. It holds the
  token supply and a little BCH for fees, never the shop's takings.
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
  price is held 30 minutes. Tokens sent during a price keep that price's rate
  and end time.
- **Addresses are reused carefully.**
  - An abandoned checkout's address is handed out again after a week, if nothing ever arrived.
  - That keeps unused addresses within the 20 a wallet looks ahead (BIP44's gap limit; Selene uses 20).
  - An address that has ever received anything is never handed out again.
- **Coupons move.** A coupon token is sent to the merchant (to the order's
  address), so it can't be used twice. No signing step or registry of used
  serials is needed. It works from any wallet that holds CashTokens, and from
  a connected wallet in the same transaction as the payment.
- **The server builds the wallet transaction, the wallet signs it.** It pays
  exactly what was quoted, spends only plain coins and that one token
  (never an NFT or another token), and the wallet sends it itself. The signed
  copy is checked against the quote before the server sends it too.
- **Every transaction from the hot wallet is checked and recorded first.**
  Rewards and minting run through the BCH virtual machine before they're
  recorded, and only then broadcast. A retry sends the very same transaction,
  so a lost reply never pays twice or mints twice.
- **Rewards only go where tokens are safe.** A connected wallet is proved by
  the payment's own inputs. Anything else (perhaps an exchange) has to claim.

## License

MIT. Dependencies: [libauth](https://github.com/bitauth/libauth) (MIT) and
[@electrum-cash/network](https://gitlab.com/electrum-cash/network) (MIT). The
payment screen uses [uqr](https://github.com/unjs/uqr) (MIT) and, for Connect
wallet, [@walletconnect/sign-client](https://github.com/WalletConnect/walletconnect-monorepo) (Apache-2.0).
