# Commissions for sales partners

Let other people sell for you. A sales partner (an affiliate) shares a link to
your shop or to one piece; when a shopper pays with Bitcoin Cash through it,
the partner gets their share **at the moment you're paid**. Only you set prices
and rates: the link only says who sent the shopper.

## Turning it on

```js
import { createBchCheckout } from "bch-cashtoken-checkout";
import { createHotWallet } from "bch-cashtoken-checkout/hot-wallet";
import { createSanctions } from "bch-cashtoken-checkout/sanctions";

const sanctions = createSanctions({ getMeta: () => db.get("ofac"), setMeta: (v) => db.set("ofac", v) });
setInterval(() => sanctions.refresh(), 3_600_000); // downloads at most once a day

const bch = createBchCheckout({
  // …
  commissions: {
    wallet,                          // the hot wallet (createHotWallet): pays when the shopper's payment can't
    isBlocked: sanctions.isBlocked,  // no payouts to an address on the US sanctions list
    onCommission: (payment, c) => recordCommission(payment.id, c), // once it's sent (or cancelled)
  },
});

// At checkout, for an order through a partner's link (their code, kept in a cookie by your site):
await bch.start({ id, subtotalCents, shippingCents, taxCents, partner: { id: "priya", address: "bitcoincash:q…", ratePercent: 5 } });
```

Your partners (who they are, their codes, rates and payout addresses) live in
your own database; `start()` is given the order's partner, if any.

## What the partner earns

`ratePercent` of the **items as sold**: `subtotalCents` (pass it at your sale
prices) less any coupon. **Never shipping or tax.** It's converted at the BCH
rate the shopper pays at.

Two optional numbers per partner, on each `start()`:

- `maxCents`: the most this order may earn them. For example, keep each US
  partner under the yearly amount that needs a 1099-NEC ($2,000 for 2026) by
  passing what's left of it, and your accounting never has to send forms.
- `owedCents`: what they owe you (a commission on an order that was refunded
  later). It comes off first, and `onCommission` reports it as `offsetCents`
  so you can lower what they owe.

## How it's paid

- **Connect wallet:** the shopper's one transaction pays two outputs: your
  share to the order's address in your wallet, and the partner's to them.
  The partner's output counts toward the order only up to their share, so
  paying the partner extra doesn't pay the order, and `walletSubmit` refuses
  a signed transaction that pays the partner less.
- **QR code or "open in wallet":** a payment link holds one address and
  amount, so you get it all, and the partner's share is sent from the hot
  wallet as soon as the payment counts. Keep a little extra BCH there. If
  it's short, the commission waits and goes from `tick()` once it's topped
  up.
- A payment double-spend proofs can't vouch for (a proof was seen, or a
  script or multisig wallet paid) waits **one block** before the hot wallet
  pays the partner.
- Like rewards, each payout is built, signed and recorded before it's
  broadcast; a retry sends the very same transaction, so a lost reply never
  pays twice.

`bch.commission(id)` gives the order's breakdown for your admin: the
partner's share, how it was paid (and the transaction), and `yourCents`.

## Staying compliant (US)

This is general information, not legal advice; check with your accountant.

- **US sanctions (OFAC).** You may not pay anyone on the SDN list. The list
  includes Bitcoin Cash addresses: `createSanctions()` downloads it daily and
  `isBlocked` stops splits and payouts to those addresses. Also ask partners
  to certify they're not on it or in an embargoed country (Cuba, Iran, North
  Korea, Syria, and occupied regions of Ukraine), and don't accept partners
  from those countries.
- **1099-NEC.** Paying a partner for selling for you is reportable once a US
  person gets $2,000 or more from you in a calendar year (2026; it rises with
  inflation after that), even when the coins go straight from the shopper's
  transaction. Either collect a W-9 and send a 1099, or cap US partners below
  the amount with `maxCents`. Partners abroad aren't sent a 1099.
- **A written agreement.** Some states require one with independent
  contractors (Illinois's Freelance Worker Protection Act, for example: both
  parties' names and addresses, the work, the pay and when it's paid). Have
  partners agree to your terms before their account exists, and keep which
  version they agreed to.
- **Disclosure.** Partners must say they earn a commission when they share
  their link (the FTC's endorsement rules).
