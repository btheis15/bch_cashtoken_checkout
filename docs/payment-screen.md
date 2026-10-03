# The payment screen

[`examples/react/`](../examples/react) is the payment screen as React
components with one plain stylesheet. No Tailwind, no framework: it works in
Next.js, Vite, Remix or anything else with React 18+.

| File | What it is |
|---|---|
| `BchPay.tsx` | The screen. It shows the amount, the price hold, the "Pay now" button, the order in BCH, live status, the "Payment received!" burst, "Paid", and help. |
| `PaySheet.tsx` | The sheet that slides up, with Connect wallet (wallet, token slider, one tap to pay, approve in the wallet) and Any wallet (QR code or "Open in my wallet app", copy buttons, tokens first). |
| `ReceiptToken.tsx` | The receipt as a CashToken: paper, then folded into a coin, spun and thrown into the wallet ("in your wallet", Replay, View receipt), or claimed. `ReceiptChoice` is the email / CashToken / both choice for checkout ([docs/receipts.md](receipts.md)). |
| `BchRewardCard.tsx` | The reward after paying: on its way, sent, or claim it with a connected wallet or a pasted address. |
| `parts.tsx` | The QR code (drawn on the page), copy button, rolling digits, address, the order in BCH, and the Bitcoin Cash mark. |
| `walletConnect.ts` | The WalletConnect connector ([docs/wallet-connect.md](wallet-connect.md)). |
| `api.ts` | Calls your server ([the routes](integration.md#your-api)). |
| `types.ts` | The view and the rest, as your server returns them. |
| `bch-pay.css` | All the styles and animations, every class prefixed `bchpay-`. |

```sh
npm i uqr                                              # the QR code
npm i @walletconnect/sign-client @walletconnect/types  # Connect wallet (optional)
```

```tsx
import "./bch-pay.css";
import { BchPay } from "./BchPay";
import { createBchApi } from "./api";
import { createBchWalletConnect } from "./walletConnect";

const wc = createBchWalletConnect({ projectId, name: "Example Shop", icon: "/logo.png" });

<BchPay
  api={createBchApi(order.id)}               // or your own BchApi
  initial={view}                             // createBchCheckout().view(id), from your server
  brand={{ name: "Example Shop", logo: "/logo.png", contactUrl: "/contact", tokenName: "Shop Rewards" }}
  wc={wc}                                    // null: "Any wallet" only
  test={order.mode === "test"}               // a note that it's a small real payment
  onPaid={() => cart.clear()}
/>
```

Create the API and the connector once (outside the component, or with
`useMemo`), not on every render: the screen re-asks for quotes when they change.

## What moves

- **The pay sheet** slides up from the bottom on a phone, or pops into the
  middle on a computer, over a blurred page. Dragging its top down closes it.
  Each step slides in. It opens by itself once when the shopper arrives
  (`autoOpen`).
- **The QR code** pops up and ripples out from the middle. A ring draws round
  the logo, a sheen passes over, and soft rings pulse out behind it while it
  waits.
- **Amounts** roll into place digit by digit, again whenever they change (as
  the token slider moves).
- **The price hold** is a bar that runs down with light along it, and changes
  color in the last two minutes.
- **"Pay now"** has a slow glow of your accents turning through it.
- **Copy** rolls "Copied" up, turns green and draws a tick.
- **Approving in the wallet:** rings ripple out from the wallet.
- **Paid:** the tick pops and draws itself, rings spread, and threads in your
  colors burst out.
- **The reward card** settles in with its coin spinning into place.
- **The receipt** prints out of the printer, then folds down into a coin that
  pops out, spins as the light catches it, and is thrown in an arc (ghost coins
  streaking behind, sparks bursting off it) into a wallet that slides in to
  catch it, bumps, and shows "+1". Then it settles to "in your wallet". The coin
  wears `brand.logo` (or the Bitcoin Cash mark), in `--bchpay-coin`, a gradient
  of your accent colors that you can override.

All of it stops for people who ask for reduced motion.

## Make it yours

Override the variables in your own stylesheet (after `bch-pay.css`), or pass
them to `BchPay` as `style`:

```css
.bchpay {
  --bchpay-bg: #fdfaf2;           /* surfaces */
  --bchpay-soft: #f4efe3;
  --bchpay-line: #e6dfcf;
  --bchpay-ink: #233142;          /* text and the dark buttons */
  --bchpay-muted: #66717f;
  --bchpay-accent: #b8873a;       /* the price hold, rings, slider, QR eyes */
  --bchpay-accent-light: #e3bf80;
  --bchpay-accent-2: #b0285e;     /* a second highlight (glow, burst) */
  --bchpay-ok: #23706f;           /* paid, savings */
  --bchpay-font: "Your Sans", sans-serif;
  --bchpay-font-display: "Your Serif", serif;
  --bchpay-radius: 1rem;
}
```

The QR code has its own variables, which default to the ones above:
`--bchpay-qr-bg`, `--bchpay-qr-dots`, `--bchpay-qr-marker`, `--bchpay-qr-eye`
and `--bchpay-qr-ring`. `brand.logo` goes in the middle of the QR code and
the sheet's header; without one, it's the Bitcoin Cash mark. `brand.money`
formats amounts if you don't want `$12.34`.

The Bitcoin Cash mark itself (green, the ₿ leaning left) is the BCH
community's, not Bitcoin's orange one. Keep it as it is.
