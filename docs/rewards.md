# Rewards: cash back in your own token

After a Bitcoin Cash payment, the shopper earns your tokens: for example 1
SHOP for every 0.1 BCH paid. Next time, those tokens take BCH off (a
BCH-valued coupon, [docs/coupons.md](coupons.md)).

## Set it up

1. **A hot wallet.** `npm run new-wallet` makes a key. Keep it with your
   server's secrets and back it up (Electron Cash or Cashonize can import it).
2. **The supply in it.** Mint your token into it from your server
   ([docs/token.md](token.md)), or send it tokens minted elsewhere. Fungible
   CashTokens can only be created when a token is minted, so mint a large
   supply once.
3. **A little BCH for fees.** Each reward costs about 500 satoshis
   (0.000005 BCH), so 0.0002 BCH covers about 40.
4. **Turn it on:**

```js
import { createHotWallet } from "bch-cashtoken-checkout/hot-wallet";

const wallet = createHotWallet({ wif: process.env.BCH_HOT_WALLET_WIF, chain });
const bch = createBchCheckout({
  xpub, store, chain, coupons,
  rewards: {
    wallet,
    // An object, or a function for live settings (checkRewards in src/tokens.js checks them).
    settings: { enabled: true, category: "<64 hex>", label: "Shop Rewards", symbol: "SHOP", decimals: 0, perBch: 0.1, tokens: 1, maxPerOrder: null, endsOn: null, claimDays: 90 },
  },
});
```

| Setting | |
|---|---|
| `enabled` | Off until true. |
| `category` | The token to give (its category ID). |
| `perBch`, `tokens` | `tokens` for every `perBch` BCH paid (whole steps: 0.165 BCH at 0.1 earns 1). |
| `maxPerOrder` | At most this many per order (optional). |
| `endsOn` | The promotion's last day, YYYY-MM-DD (optional). |
| `claimDays` | How long a reward can be claimed (default 90). |
| `label`, `symbol`, `decimals` | How it's shown, and the token's decimal places as minted. |

## Where the tokens go

- **Paid from a connected wallet** ([docs/wallet-connect.md](wallet-connect.md)):
  straight back to that wallet. It holds tokens, and the payment's own inputs
  prove it paid.
- **Paid from any other wallet:** that might be an exchange, which would lose
  them. So the reward is **claimable** on the order page for `claimDays`. The
  shopper connects a wallet or pastes a token address, and `claimReward(id,
  address)` sends it.

While paying, the screen shows the promotion ("Earn 1 SHOP back for every 0.1
BCH") and what this payment earns. Once paid, the reward card shows it on its
way, sent (with a link to the transaction), or ready to claim.

## How it's sent

Each reward is built from the hot wallet's coins, signed (Schnorr), and run
through the BCH virtual machine. It's recorded with its transaction, and only
then broadcast:

- **A retry sends the very same transaction**, so a lost reply never pays twice.
- **One send at a time.** Coins just spent are left alone for ten minutes.
- **It never spends the token's identity output** (whoever does would control
  what wallets show, [docs/token.md](token.md)).
- **Not enough tokens, or BCH for fees?** The reward waits, with a notice, and
  goes on the next `tick()` once the wallet is topped up.

## For your admin screen

- `rewardsStatus()`: the hot wallet's addresses, its balance (BCH and the
  token), the settings, and the last 25 rewards with their state and any error.
- `testReward({ address, amount })`: sends a few tokens now, to try it out.
