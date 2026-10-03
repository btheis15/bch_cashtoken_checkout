# Wallets

## The merchant's xPub

The xPub is the wallet's account-level extended public key (BIP44
`m/44'/145'/0'` for BCH). Receiving addresses are `xpub/0/<index>`: what the
wallet shows as receiving addresses, in order.

| Wallet | Where |
|---|---|
| Selene | Settings → Wallet → xPub. To keep the shop separate, add a new wallet first. |
| Electron Cash | Wallet → Information → Master Public Key |

Check the setup: `firstAddress()` should match the first receiving address the
wallet shows (Selene: Receive; Electron Cash: Addresses tab).

**Gap limit.** A wallet looks about 20 unused addresses ahead; Selene's
`ADDRESS_GAP_LIMIT` is 20.

- Abandoned checkouts leave unused addresses, so the kit hands them out again
  after `reuseDays` (7).
- If many checkouts were abandoned in a week, a payment can land beyond what the
  wallet scans. It's safe, but hidden until you use the wallet's "scan for more
  addresses".

## Payment links (BIP21)

- **Paying BCH:** `bitcoincash:q…?amount=0.165&message=Order%201001`.
  - Wallets fill in the amount; `message` shows next to the payment.
  - Selene ignores `label`.
  - Always show a **q…** address for BCH payments. Selene can pay a z…
    address with a stablecoin token when its stablecoin mode is on.
- **Sending a coupon:** `bitcoincash:z…?c=<category>&f=<amount>`, a CashTokens
  payment request. Selene and Cashonize fill in the token; other wallets just
  take the address.

The QR code holds the same link. Phones open the `bitcoincash:` link in the
installed wallet: Selene registers it on iOS and Android.

## Wallets shoppers can pay with

Any Bitcoin Cash wallet: Selene, Paytaca, Cashonize, Electron Cash, Exodus and
others. For coupons and rewards, the wallet must hold CashTokens: Selene,
Paytaca, Cashonize, Zapit and Electron Cash do.

**Connect wallet** (BCH WalletConnect, [docs/wallet-connect.md](wallet-connect.md)):
Cashonize (web and app), Paytaca and Zapit. They connect by scanning a `wc:`
QR code, or by opening the link on the same phone. Cashonize on the web takes
it as `https://cashonize.com/?uri=<wc link>`.

## The hot wallet

The small wallet for rewards and minting has an ordinary private key (WIF)
from `npm run new-wallet`. To see or move what's in it yourself, import the
key into Electron Cash (File → New/Restore → Import Bitcoin Cash addresses or
private keys) or Cashonize. Don't spend its token's identity output by hand:
that's the 1000-satoshi output 0 of the genesis, or of the last update
([docs/token.md](token.md)).
