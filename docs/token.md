# Your token: minted from your server, and what wallets show for it

Mint your shop's own fungible CashToken from the hot wallet, and publish what
wallets show for it (name, symbol, decimals, description, icon, website). Then
use it for rewards and BCH-valued coupons.

```js
import { createTokenIssuer } from "bch-cashtoken-checkout/token";

const token = createTokenIssuer({ wallet, store, siteUrl: "https://your.shop", registryName: "Example Shop" });

await token.create({
  name: "Shop Rewards",       // up to 40 characters
  symbol: "SHOP",             // 2–12 letters or numbers
  supply: 1_000_000,          // whole tokens, minted once and never added to
  decimals: 0,                // 0–8 (0: whole tokens)
  description: "Earned at Example Shop, spent at Example Shop.",
  icon: "https://your.shop/token.png",   // a square PNG or SVG, ideally 512px (https:// or ipfs://)
  web: "https://your.shop",
});
// → token.status(): { token: { category, supply, held, registryUrl, genesisUrl, … }, wallet, minting }

await token.update({ name, description, icon, web });  // later: what wallets show (symbol and decimals stay)
```

Serve the registry where wallets look for it, readable from any site:

```js
app.get("/bcmr/:category.json", async (req, res) => {
  const json = await token.registry(req.params.category);
  if (!json) return res.sendStatus(404);
  res.set("Access-Control-Allow-Origin", "*").type("application/json").send(json);  // the exact text: its hash is on chain
});
```

Then use `status().token.category` in your coupons (`kind: "bch"`) and rewards settings.

## What happens on chain

A fungible token's whole supply is made in one transaction (its **genesis**),
and can never be added to. The kit mints in two small transactions from the
hot wallet:

1. **The authbase.** A fresh output at index 0 (2000 satoshis) back to the hot
   wallet. A genesis must spend an index-0 output, and that output's
   transaction ID becomes the token's **category ID**.
2. **The genesis.** It spends the authbase and makes:
   - output 0: 1000 satoshis back to the hot wallet, the token's **identity output**
   - output 1: the whole supply, into the hot wallet
   - an `OP_RETURN <'BCMR'> <SHA-256 of the registry> <your.shop/bcmr/<category>.json>`
     ([CHIP-BCMR](https://cashtokens.org/docs/bcmr/chip/))

Fees are about 0.00001 BCH, plus 0.00003 BCH kept with the token's outputs.
Send the hot wallet about 0.0001 BCH first.

**Updates** spend the identity output in a new transaction. It publishes the
new registry (every snapshot so far, newest last) and keeps output 0 as the
new identity output. That chain of identity outputs is the token's
**authchain**: wallets (Paytaca, Cashonize) follow it through Paytaca's
indexer to find the newest registry. Whoever spends the identity output
controls what wallets show, so rewards never spend it.

**Nothing is lost to a dropped reply.** Each step's transaction is recorded
before it's sent, and a retry sends the very same one. If the network refuses
the genesis, the authbase stays reserved for the next try. A token is never
minted twice, and an update never loses the identity.

## Keep safe

- The token's state (in your store's meta) holds the registry text whose hash
  is on chain. Back it up with your database.
- The hot wallet's key controls the supply and the identity. Back it up, and
  keep it as secret as your API keys.
