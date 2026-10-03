# Integrating it into your shop

## The engine

```js
const chain = createBchChain();   // one connection, shared with the hot wallet
const bch = createBchCheckout({
  xpub,                 // the shop wallet's xPub (account level, e.g. m/44'/145'/0')
  store,                // see "Storage" below
  chain,
  coupons,              // an array, or a synchronous function returning one (docs/coupons.md)
  rewards,              // optional: { wallet: createHotWallet(…), settings } (docs/rewards.md)
  onPaid(payment),      // fulfil the order: called once, when the payment counts
  onNotice(payment, { kind, message, problem }), // problem: true means look before shipping
  onCoupon(payment, coupon, discountCents) → { totalCents, taxCents },  // optional: e.g. sales tax again
  priceMinutes: 30, maxPrices: 4, proofWaitMs: 3000, tolerance: 0.002, reuseDays: 7, minSats: 1000,
  prices,               // default: four exchanges (src/bch.js)
});
```

| Call | When |
|---|---|
| `start({ id, label, subtotalCents, shippingCents, taxCents, otherCents, itemCount, shippingLabel })` | When the shopper chooses Bitcoin Cash and confirms the address. `subtotalCents` is the items, which coupons take a share of. Take the amounts from your database, never from the browser. `itemCount` and `shippingLabel` only label the order's lines; `otherCents` is anything else (or shipping and tax together). `label` becomes the payment's message in wallets. Returns the view. |
| `view(id)` | What the payment screen shows (no network calls). |
| `check(id)` | Reads the address from the blockchain. It's called for you when the network says the address changed. Also call it from the screen's polling, but throttled: once every few seconds per order is plenty. |
| `renew(id)` | "Get a new price", once a price ran out with nothing sent. Check your stock first, and `close()` if something sold out. |
| `close(id)` | The order is abandoned or something sold out. A payment that still arrives is accepted with a "late" problem. |
| `tick()` | Every minute: anything a notice missed, late payments, double-spends before the first block, and rewards waiting to be sent. It also closes open payments 15 minutes after their price ended. |
| `watchAll()` | After a restart. |
| `walletInfo` · `walletQuote` · `walletBuild` · `walletSubmit` | Connect wallet ([docs/wallet-connect.md](wallet-connect.md)). |
| `claimReward(id, address)` · `rewardsStatus()` · `testReward({ address, amount })` | Rewards ([docs/rewards.md](rewards.md)). |
| `claimReceipt(id, address)` · `receiptReplacesEmail(payment)` | Receipts as CashTokens ([docs/receipts.md](receipts.md)). `start()` also takes `number`, `items` and `receipt` (`"email"`, `"token"` or `"both"`). |

Errors are `BchError`s with a message for the shopper and an HTTP-style
`status`: 400 for bad input, 404 for an unknown order, 409 when the order's
state doesn't allow it, and 502 when the network didn't answer. Settings
errors also carry `errors` (`{ field: message }`).

### Sales tax and coupons

A coupon changes what's taxed. Without `onCoupon`, the sales tax is lowered
in proportion to the discount: $66 with $6.60 tax and $12 off becomes $54
with $5.40 tax. With `onCoupon`, you work it out (for example with your tax
service) and return `{ totalCents, taxCents }`. It's called for every coupon,
and for every quote while a shopper moves the token slider. Quotes are cached
per amount, but keep it fast.

### The view

- `state`: `waiting` · `partial` · `arrived` · `paid` · `checking` · `expired` · `expired_partial`
- `amountBch` / `uri`: what to pay now. For `partial`, that's what's left.
- `address`, `expiresAt`, `canRenew`, `txUrl`, `applied`
- `coupon`: the coupon offer, while `waiting`. `stack: true` when BCH-valued
  tokens can be sent a few at a time.
- `breakdown`: the order in BCH at the price being held. The lines (items,
  tokens or coupon, shipping, tax) add up to exactly what's asked.
- `walletPay`: Connect wallet can be offered (the order is `waiting` or `partial`).
- `rewardOffer`: the rewards promotion while paying. `reward`: what the order earned, once paid.
- `receipt`: the receipt as a CashToken, once paid (if chosen). `receiptPref`: the shopper's choice.

[`examples/react/BchPay.tsx`](../examples/react/BchPay.tsx) renders all of it
([docs/payment-screen.md](payment-screen.md)).

### The payment

`payment(id)` returns the full record:

- `status`: `awaiting` · `paid` · `closed`
- `receivedSats`, `confirmations`, `payTxs`
- `windows`: the prices quoted
- `coupon`, `discountCents`, `taxCents`, `totalCents`
- `walletPlan`: the last transaction built for a connected wallet
- `reward`: the reward and its transaction
- `problems`, `events`

## Your API

The payment screen needs these routes, all keyed by an order id the browser
can't guess. [`examples/server.mjs`](../examples/server.mjs) has them all;
[`examples/react/api.ts`](../examples/react/api.ts) calls them.

| Route | Calls |
|---|---|
| `GET /api/orders/:id` | `check(id)` (throttled) |
| `POST /api/orders/:id/renew` | `renew(id)` |
| `POST /api/orders/:id/wallet` `{ address }` | `walletInfo(id, address)` |
| `POST /api/orders/:id/quote` `{ category, amount }` | `walletQuote(id, …)` |
| `POST /api/orders/:id/build` `{ address, category, amount }` | `walletBuild(id, …)` |
| `POST /api/orders/:id/submit` `{ hex }` | `walletSubmit(id, hex)` |
| `POST /api/orders/:id/claim` `{ address }` | `claimReward(id, address)` |
| `POST /api/orders/:id/receipt` `{ address }` | `claimReceipt(id, address)` |
| `GET /bcmr/<category>.json` | `token.registry(category)` or `receipts.registry(category)`, with `Access-Control-Allow-Origin: *` ([docs/token.md](token.md)) |

## Storage

[`src/memory-store.js`](../src/memory-store.js) shows the whole interface.
[`src/file-store.js`](../src/file-store.js) keeps it in a JSON file, which is
fine for trying it out or a small shop on one server.

**Payments:** `getPayment`, `putPayment`, `listPayments`.

**Addresses:**

- `claimFreeAddress` and `claimNewAddress` must be **atomic**, so two checkouts
  at once never get the same address.
- Also: `setAddress`, `releaseAddress`, `markAddressUsed`,
  `orderForScripthash`, `unusedAhead`.

**Meta:** `getMeta(name)`, `putMeta(name, value)`. These hold named JSON
values: the token's state, including the registry file whose hash is on
chain. Back it up.

A SQL version:

```sql
CREATE TABLE bch_payments (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);  -- data: the payment as JSON
CREATE TABLE bch_addresses (
  wallet      TEXT NOT NULL,      -- which xPub (a fingerprint)
  idx         INTEGER NOT NULL,   -- receiving address xpub/0/idx
  address     TEXT NOT NULL,
  scripthash  TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('reserved', 'used', 'free')),
  order_id    TEXT,
  reserved_at TEXT,
  released_at TEXT,               -- NULL: free straight away
  PRIMARY KEY (wallet, idx)
);
CREATE INDEX bch_addresses_by_scripthash ON bch_addresses (scripthash);
CREATE TABLE bch_meta (name TEXT PRIMARY KEY, data TEXT NOT NULL);  -- data: JSON
-- claimFreeAddress: in one transaction, select the lowest idx with state = 'free'
--   AND (released_at IS NULL OR released_at < :reuseBefore), then
--   UPDATE ... SET state = 'reserved', order_id = :order WHERE wallet = ? AND idx = ? AND state = 'free'
-- claimNewAddress:  INSERT the next idx (MAX(idx) + 1) ... ON CONFLICT DO NOTHING, and retry if it lost the race
```

## Test orders

Bitcoin Cash has no test network. To try the whole flow, make a test order
for a small real amount, such as $0.25 (`subtotalCents: 25`). The money goes
into your own wallet. Coupons and rewards work the same way: mint a token, and
send yourself a few with `testReward`.

## Refunds

Payments are in your wallet, so refunds are sent from your wallet. Ask the
customer for an address: the one the payment came from may belong to an
exchange. Tokens sent with an order are in your wallet too. Send them back
from a wallet that holds CashTokens (Electron Cash, Cashonize, Paytaca).

## Security checklist

- [ ] Only the **xPub** of the shop's wallet is on the server, and it's stored
      privately. It can't spend, but it reveals the wallet's addresses and
      history. Never accept an xprv or recovery words; `parseXpub` refuses an xprv.
- [ ] Use a **wallet just for the shop**. Don't hand out its addresses for
      anything else: an address that already has history is skipped, but one
      given out by the wallet at the same moment could overlap.
- [ ] The **hot wallet's key** (`HOT_WALLET_WIF`) is a secret like your API
      keys, and backed up. Keep only what rewards need in it: the token
      supply and a little BCH for fees.
- [ ] Order totals come from your database. The browser only sends the order
      id, which can't be guessed.
- [ ] Show the merchant `firstAddress()` to compare with the wallet's first
      receiving address before going live.
- [ ] Run `tick()` every minute, and `watchAll()` on start.
- [ ] Watch `onNotice` problems (`dropped`, `unprotected`, `late`, `partial`,
      `double`, `coupon`) and don't ship until they're resolved.
- [ ] If `unusedAhead()` passes about 15, tell the merchant to use the wallet's
      "scan for more addresses" if a payment doesn't show.
- [ ] Protect your admin routes (minting, test rewards) like the rest of your admin.
