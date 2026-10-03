# Connect wallet (BCH WalletConnect)

Shoppers whose wallet speaks WalletConnect (Cashonize, Paytaca, Zapit) can
connect it on the payment screen, see what's in it, choose how many of your
tokens to spend, and approve **one transaction** that pays the BCH and spends
the tokens together. Other wallets still pay by QR code or link.

The spec is [wc2-bch-bcr](https://github.com/mainnet-pat/wc2-bch-bcr): the
`bch:bitcoincash` chain with `bch_getAddresses`, `bch_signTransaction` and,
optionally, `bch_cancelPendingRequests`.

## How it goes

1. **Connect.** The screen shows a `wc:` QR code, or opens the wallet app on a
   phone. Once approved, the wallet's address comes back. It's remembered, so
   a later visit reconnects without asking.
2. **What it holds.** `walletInfo(id, address)` reads the wallet's coins from
   Fulcrum and returns its plain BCH and, for each BCH-valued coupon, how many
   tokens it has and how many would cover the items.
3. **Choose.** As the slider moves, `walletQuote(id, { category, amount })`
   returns the BCH to pay and the order in BCH with those tokens off. A quote
   and the real thing come from the same code, so what's shown is what's charged.
4. **Build.** `walletBuild(id, { address, category, amount })` builds the
   payment as one unsigned transaction:
   - BCH to the order's address, and the tokens to the same address
   - change back to the wallet, including any tokens not spent
   - only plain BCH coins and coins of that one token, largest first (an NFT
     or another token is never touched)
   - 1 satoshi a byte

   It returns the `bch_signTransaction` request (libauth's `stringify` form,
   with `broadcast: true` and your order's label as `userPrompt`).
5. **Approve.** The wallet signs its inputs and sends the transaction itself,
   so the payment goes through even if the shopper's browser went to sleep.
6. **Hand back.** `walletSubmit(id, hex)` checks the signed transaction pays
   at least what was built (BCH and tokens), and broadcasts it too, which
   changes nothing if it's already out. If the order already saw it arrive,
   that's fine. A transaction that doesn't match is refused and never sent.

The tokens arrive in the same transaction as the BCH, so they count as a
coupon. They don't count as tokens sent "after part of the payment".

## On your site

```tsx
import { createBchWalletConnect } from "./walletConnect";

const wc = createBchWalletConnect({
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID!,  // free at dashboard.reown.com
  name: "Example Shop",
  description: "Pay with Bitcoin Cash.",
  icon: "/icon.png",
});
<BchPay api={api} initial={view} brand={brand} wc={wc} />
```

- `npm i @walletconnect/sign-client @walletconnect/types`. The client loads
  only when a shopper connects.
- In the project's dashboard, add your site's domain to the allowed origins.
- Without a project ID, the screen just offers "Any wallet".

## Rewards and connected wallets

A connected wallet holds tokens, so rewards go straight back to it
([docs/rewards.md](rewards.md)). The kit checks the payment's own inputs came
from that address before sending anything there.
