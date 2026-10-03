# The live demo

The kit's own code (`../src`) and payment screen (`../examples/react`), running in the browser against a simulated
Bitcoin Cash network (`../test/fakes.mjs`: real transactions, built and signed with libauth, never broadcast) and a
simulated wallet for Connect wallet. The sample shop is [Om Threads Boutique](https://omthreadsboutique.vercel.app).

```sh
npm run demo            # from the repository's root: http://localhost:5173
```

- `src/shop.js` is the "server": `createBchCheckout` with coupons, rewards, receipts as CashTokens and commissions,
  set up as a shop would, plus the network's buttons.
- `src/App.tsx` is the page: the shop, the payment screen, and the panel that shows what happens.
- Published by `.github/workflows/demo.yml` to GitHub Pages.
