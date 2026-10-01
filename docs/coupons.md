# CashTokens coupons

Give loyal customers a coupon they hold in their own wallet. At checkout they
send it to you, and the discount comes off.

## 1. Mint your coupons

CashTokens are native Bitcoin Cash tokens. Two kinds work as coupons:

- **A fungible token** (simplest). For example, mint 100 "OMT" and give each
  loyal customer 1. A coupon is `units` tokens, usually 1.
- **NFTs.** Each is a separate coupon, for example with a serial number in the
  commitment. Only **immutable** NFTs (capability `none`) count. A minting or
  mutable NFT is never taken as a coupon, so a minting NFT sent by mistake isn't
  used up.

Where to mint (no code needed):

- [Cashonize](https://cashonize.com) (v0.14+): **Create tokens**, a guided
  token creation.
- [CashTokens Studio](https://cashtokens.studio) (by Paytaca): connects to your
  wallet over WalletConnect.
- Electron Cash 4.3+ can mint too.

Minting costs a few hundred satoshis in fees, plus about 800–1000 satoshis
locked in each token output. You get that back when coupons come back to you.

Give the token a **name and icon while minting**. That is its BCMR metadata,
which these tools publish on-chain. Wallets (Cashonize, Paytaca, Electron Cash)
then show it by name, through Paytaca's index at `bcmr.paytaca.com`.
`tokenInfo(category)` in `src/bch.js` reads the same index, so your admin can
show the name too.

The token's **category ID** (64 hex characters) is what you configure:

```js
coupons: [
  { category: "<64 hex>", label: "Loyal customer 15%", token: "ft", units: 1, kind: "percent", value: 15, symbol: "OMT" },
  { category: "<64 hex>", label: "$10 off", token: "nft", kind: "amount", value: 10 },
]
```

- `kind: "percent"` takes a whole percentage (1–90) off the items.
- `kind: "amount"` takes dollars off the items, never more than the items cost.
- `active: false` switches a coupon off.

## 2. How a shopper uses one

On the payment screen, before paying, "Use a coupon" shows the order's
**token address**:

- It's the z… form of the order's own address. CashTokens can only be sent to
  token-aware addresses, and wallets refuse to send tokens to a q… address.
- With a single kind of coupon, the link and QR code ask for that token
  (`bitcoincash:z…?c=<category>&f=<units>`). Selene and Cashonize fill it in.
- With several kinds, it's just the address.

The shopper sends the coupon from their wallet. Within seconds the server sees
the token output, checks it, takes the discount off, and gives a new BCH price.
With `onCoupon` you can work out the new total yourself, for example sales tax
on the lower price. The screen shows "Coupon applied", and the shopper then
pays the new amount to the usual q… address.

## 3. The rules

- **One coupon per order.** A second one is noted and not applied.
- **Only before paying.** A coupon that arrives after any BCH (or after the
  order closed) isn't applied, and is flagged so you can refund the discount or
  send the coupon back.
- **It can't be used twice.** The token itself moves to your wallet. There's
  no signing step and no list of used serials to keep. You can give the coupon
  out again later.
- **Unknown tokens** sent by mistake are noted, and stay in your wallet.
- **Zero-conf applies to coupons too.** A coupon transaction that vanishes
  before a block (double-spent) is visible in the payment's history.

## Why "send it to the shop"?

Three approaches were compared:

| | Send the coupon (this kit) | Sign a message proving you hold it | WalletConnect, one transaction |
|---|---|---|---|
| Works with | any CashTokens wallet | wallets with message signing (few on mobile) | wallets with WalletConnect for BCH |
| Reuse prevented by | the token moving to the shop | a server list of used NFT serials (fungible coupons can't be tracked) | the token moving |
| Shopper steps | send coupon, then pay | copy a message, sign it, paste it back, then pay | connect, approve one transaction |

Sending works everywhere today and needs no extra infrastructure. A "connect
wallet" fast path (WalletConnect `bch_signTransaction`, or Selene's
WizardConnect) could later do the coupon and the payment in one approval.
