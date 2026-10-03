# CashTokens coupons

Give loyal customers a coupon they hold in their own wallet. At checkout they
send it to you, and the discount comes off.

## 1. Kinds of coupons

CashTokens are native Bitcoin Cash tokens. Three kinds work as coupons:

- **BCH-valued tokens** (`kind: "bch"`). Each token takes a set amount of BCH
  off, such as 0.01 BCH. A shopper sends any number of them, all at once or a
  few at a time, until the items are covered. It's the natural partner for
  rewards ([docs/rewards.md](rewards.md)): earn tokens with one order, spend
  them on the next.
- **A fungible token as a coupon** (`kind: "percent"` or `"amount"`). For
  example, mint 100 "SHOP" and give each loyal customer 1. A coupon is `units`
  tokens, usually 1, and one coupon counts per order.
- **NFTs.** Each is a separate coupon, for example with a serial number in the
  commitment. Only **immutable** NFTs (capability `none`) count. A minting or
  mutable NFT is never taken as a coupon, so a minting NFT sent by mistake isn't
  used up.

```js
coupons: [
  { category: "<64 hex>", label: "Shop token", token: "ft", kind: "bch", value: 0.01, symbol: "SHOP", decimals: 0 },
  { category: "<64 hex>", label: "Loyal customer 15%", token: "ft", units: 1, kind: "percent", value: 15, symbol: "LOYAL" },
  { category: "<64 hex>", label: "$10 off", token: "nft", kind: "amount", value: 10 },
]
```

- `kind: "bch"` takes `value` BCH off per whole token (0.00001–10), fungible tokens only.
- `kind: "percent"` takes a whole percentage (1–90) off the items.
- `kind: "amount"` takes dollars off the items, never more than the items cost.
- `decimals` must match the token's (as minted): with 2, 150 on the chain is 1.5 tokens.
- `active: false` switches a coupon off.

`checkCoupons(list)` in [`src/tokens.js`](../src/tokens.js) checks and tidies
a list from your admin screen, and throws a `BchError` whose `errors` say
what's wrong.

## 2. Minting them

Mint your own token from your server ([docs/token.md](token.md)), or with a
wallet (no code needed):

- [Cashonize](https://cashonize.com) (v0.14+): **Create tokens**, a guided
  token creation.
- [CashTokens Studio](https://cashtokens.studio) (by Paytaca): connects to your
  wallet over WalletConnect.
- Electron Cash 4.3+ can mint too.

Minting costs a few hundred satoshis in fees, plus about 800–1000 satoshis
locked in each token output. You get that back when coupons come back to you.

Give the token a **name and icon while minting**. That is its BCMR metadata,
published on chain, and wallets (Cashonize, Paytaca, Electron Cash) show the
token by that name through Paytaca's index at `bcmr.paytaca.com`.
`tokenInfo(category)` in `src/bch.js` reads the same index, so your admin can
show the name too.

The token's **category ID** (64 hex characters) is what you configure.

## 3. How a shopper uses them

**From a connected wallet** ([docs/wallet-connect.md](wallet-connect.md)):
the shopper picks how many BCH-valued tokens to use on a slider, and they go
in the same transaction as the payment.

**From any wallet:** on the payment screen, before paying, "Have tokens?"
shows the order's **token address**.

- It's the z… form of the order's own address. CashTokens can only be sent to
  token-aware addresses, and wallets refuse to send tokens to a q… address.
- With a single kind of coupon, the link and QR code ask for that token
  (`bitcoincash:z…?c=<category>`, with `&f=<units>` for a one-per-order coupon).
  Selene and Cashonize fill it in.
- With several kinds, it's just the address.

The shopper sends the tokens from their wallet. Within seconds the server sees
the token output, checks it, takes the discount off, and gives a new BCH price.
BCH-valued tokens sent while a price is held keep its rate and end time, and
take exactly their BCH off. The sales tax is worked out on the lower price
([docs/integration.md](integration.md#sales-tax-and-coupons)). The screen
shows "Tokens applied" or "Coupon applied", and the shopper pays the new
amount to the usual q… address.

## 4. The rules

- **One percent or dollar coupon per order.** A second one is noted and not
  applied. BCH-valued tokens of the same kind add up.
- **Never more than the items.** Tokens beyond what covers the items are
  flagged so you can send them back. Shipping and tax are always paid in BCH.
- **Only before paying.** Tokens that arrive after any BCH (or after the order
  closed) aren't applied, and are flagged so you can refund the discount or
  send them back. Tokens in the same transaction as the payment do count.
- **They can't be used twice.** The token itself moves to your wallet. There's
  no signing step and no list of used serials to keep. You can give the coupon
  out again later.
- **Unknown tokens** sent by mistake are noted, and stay in your wallet.
- **Zero-conf applies to coupons too.** A coupon transaction that vanishes
  before a block (double-spent) is visible in the payment's history.
- **A coupon's new price isn't a renewal.** Each one adds to how many prices
  the order can have.

## Why "send it to the shop"?

Three approaches were compared:

| | Send the coupon (this kit) | Sign a message proving you hold it | WalletConnect, one transaction (this kit too) |
|---|---|---|---|
| Works with | any CashTokens wallet | wallets with message signing (few on mobile) | Cashonize, Paytaca, Zapit |
| Reuse prevented by | the token moving to the shop | a server list of used NFT serials (fungible coupons can't be tracked) | the token moving |
| Shopper steps | send coupon, then pay | copy a message, sign it, paste it back, then pay | connect, approve one transaction |

Sending works everywhere and needs no extra infrastructure. Connect wallet is
the fast path where the wallet supports it. Both move the token, so the rules
are the same.
