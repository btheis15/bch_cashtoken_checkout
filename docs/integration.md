# Integrating it into your shop

## The engine

```js
const bch = createBchCheckout({
  xpub,                 // the shop wallet's xPub (account level, e.g. m/44'/145'/0')
  store,                // see "Storage" below
  coupons,              // an array, or a synchronous function returning one (docs/coupons.md)
  onPaid(payment),      // fulfil the order: called once, when the payment counts
  onNotice(payment, { kind, message, problem }), // problem: true means look before shipping
  onCoupon(payment, coupon, discountCents) → newTotalCents,  // optional: e.g. sales tax again
  priceMinutes: 30, maxPrices: 4, proofWaitMs: 3000, tolerance: 0.002, reuseDays: 7,
  chain, prices,        // defaults: public Fulcrum servers, four exchanges (src/bch.js)
});
```

| Call | When |
|---|---|
| `start({ id, label, subtotalCents, otherCents })` | When the shopper chooses Bitcoin Cash and confirms the address. `subtotalCents` is the items (coupons take a share of these); `otherCents` is shipping and tax. Take the amounts from your database, never from the browser. Returns the view. |
| `view(id)` | What the payment screen shows (no network calls). |
| `check(id)` | Reads the address from the blockchain. It's called for you when the network says the address changed. Also call it from the screen's polling, but throttled: once every few seconds per order is plenty. |
| `renew(id)` | "Get a new price", once a price ran out with nothing sent. |
| `close(id)` | The order is abandoned or something sold out. A payment that still arrives is accepted with a "late" problem. |
| `tick()` | Every minute: anything a notice missed, late payments, double-spends before the first block. It also closes open payments 15 minutes after their price ended. |
| `watchAll()` | After a restart. |

### The view

- `state`: `waiting` · `partial` · `arrived` · `paid` · `checking` · `expired` · `expired_partial`
- `amountBch` / `uri`: what to pay now. For `partial`, that's what's left.
- `address`, `expiresAt`, `canRenew`, `txUrl`, `applied`
- `coupon`: the coupon offer, while `waiting`

[`examples/react/BchPay.tsx`](../examples/react/BchPay.tsx) renders all of it.

### The payment

`payment(id)` returns the full record:

- `status`: `awaiting` · `paid` · `closed`
- `receivedSats`, `confirmations`, `payTxs`
- `windows`: the prices quoted
- `coupon`, `discountCents`, `totalCents`
- `problems`, `events`

## Storage

[`src/memory-store.js`](../src/memory-store.js) shows the whole interface.

**Payments:** `getPayment`, `putPayment`, `listPayments`.

**Addresses:**

- `claimFreeAddress` and `claimNewAddress` must be **atomic**, so two checkouts
  at once never get the same address.
- Also: `setAddress`, `releaseAddress`, `markAddressUsed`,
  `orderForScripthash`, `unusedAhead`.

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
-- claimFreeAddress: in one transaction, select the lowest idx with state = 'free'
--   AND (released_at IS NULL OR released_at < :reuseBefore), then
--   UPDATE ... SET state = 'reserved', order_id = :order WHERE wallet = ? AND idx = ? AND state = 'free'
-- claimNewAddress:  INSERT the next idx (MAX(idx) + 1) ... ON CONFLICT DO NOTHING, and retry if it lost the race
```

## Test orders

Bitcoin Cash has no test network. To try the whole flow, make a test order
for a small real amount, such as $0.25 (`subtotalCents: 25`). The money goes
into your own wallet. Coupons work the same way: mint a test token.

## Refunds

Payments are in your wallet, so refunds are sent from your wallet. Ask the
customer for an address: the one the payment came from may belong to an
exchange.

## Security checklist

- [ ] Only the **xPub** is on the server, and it's stored privately. It can't
      spend, but it reveals the wallet's addresses and history. Never accept an
      xprv or recovery words; `parseXpub` refuses an xprv.
- [ ] Use a **wallet just for the shop**. Don't hand out its addresses for
      anything else: an address that already has history is skipped, but one
      given out by the wallet at the same moment could overlap.
- [ ] Order totals come from your database. The browser only sends the order id.
- [ ] Show the merchant `firstAddress()` to compare with the wallet's first
      receiving address before going live.
- [ ] Run `tick()` every minute, and `watchAll()` on start.
- [ ] Watch `onNotice` problems (`dropped`, `unprotected`, `late`, `partial`,
      `double`, `coupon`) and don't ship until they're resolved.
- [ ] If `unusedAhead()` passes about 15, tell the merchant to use the wallet's
      "scan for more addresses" if a payment doesn't show.
