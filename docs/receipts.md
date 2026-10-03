# Receipts as CashTokens

A shopper paying with Bitcoin Cash can choose their receipt as a CashToken: an
NFT in their own wallet, such as "Example Receipt #1042". It's one of a kind,
numbered by the order, can never be changed, and shows what they bought. On
the payment screen, the paper receipt folds into a coin, which spins and is
thrown into their wallet.

## Set it up

```js
import { createReceiptIssuer } from "bch-cashtoken-checkout/receipts";

const receipts = createReceiptIssuer({ wallet, store, siteUrl: "https://your.shop", shopName: "Example Shop" });
await receipts.create({ name: "Example Receipt", description: "Your receipt from Example Shop.", icon: "https://your.shop/receipt.png" });  // once

const bch = createBchCheckout({ xpub, store, chain, coupons, receipts,
  onPaid: (p) => { if (!bch.receiptReplacesEmail(p)) sendReceiptEmail(p.id); fulfil(p.id); },
});

// At checkout, with the shopper's choice:
await bch.start({ id, label: "Order 1042", number: 1042, items: [{ title: "Linen Scarf", qty: 1, cents: 6000 }], subtotalCents, shippingCents, taxCents, receipt: "token" });
```

- `wallet` is the hot wallet (`createHotWallet`, the same one as rewards).
  Making the collection uses about 0.00003 BCH, and each receipt about
  0.000015 BCH.
- `create()` makes the collection once: an authbase, then the genesis. That
  keeps the identity output (output 0) and a minting NFT, the "baton" (output
  1), in the hot wallet. Every receipt is minted from the baton.
- Serve `receipts.registry(category)` at `/bcmr/<category>.json` with
  `Access-Control-Allow-Origin: *`, as for your token ([docs/token.md](token.md)).
  The example server does it.
- `start({ receipt })`: `"email"` (the default), `"token"` or `"both"`. Offer
  the choice only when paying with Bitcoin Cash.
  [`ReceiptChoice`](../examples/react/ReceiptToken.tsx) is the three options.
- `number` (an integer) goes into the token. `items` and the amounts are what
  the receipt shows.

## Where it goes

- **Paid from a connected wallet** ([docs/wallet-connect.md](wallet-connect.md)):
  straight back to it. The payment's own inputs prove the wallet paid, and it
  holds tokens.
- **Paid from any other wallet** (which might be an exchange): **claimable** on
  the order page for 90 days, with a connected wallet or a pasted token
  address (`claimReceipt(id, address)`).
- `receiptReplacesEmail(payment)` is true when the shopper chose the CashToken
  alone and it's going straight to their wallet. That's when to skip your
  receipt email. When it has to be claimed, send the email anyway, so nobody
  is left without a receipt.

`view(id).receipt` is the receipt for the payment screen: `sending`, `sent`,
`claimable` or `expired`, with what it shows. `view(id).receiptPref` is the
shopper's choice. [`ReceiptToken`](../examples/react/ReceiptToken.tsx) renders
it, and `BchPay` shows it once paid.

## What's on chain, and what isn't

- **In the token:** an NFT holds at most 40 bytes. The commitment is
  `01 · the order number (4 bytes) · the SHA-256 of the receipt`, which is 37
  bytes. Anyone holding the receipt can check it against the token.
- **What wallets show** (the name, and a description with the items, amounts,
  date and payment transaction) is in the collection's registry
  (CHIP-BCMR), one NFT type per receipt.
- **It's public.** Anyone can look a receipt up, so it carries nothing
  personal: no name, address, email or phone. Keep those in your own records
  and emails.

## How each one is minted

One transaction mints the receipt *and* publishes the registry with it in:

- it spends the identity output and the baton, and gives both back (outputs 0 and 1)
- it sends the receipt, an immutable NFT, to the shopper (output 2)
- it carries `OP_RETURN <'BCMR'> <hash> <your.shop/bcmr/<category>.json>`

It's built, signed and checked by the BCH virtual machine, recorded, and only
then broadcast. A retry sends the very same transaction, so a receipt is never
minted twice. Receipts go one at a time, and the one already on its way goes
first. Rewards and the token never spend the identity output or the baton.
