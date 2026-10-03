/**
 * Makes a key for the hot wallet (rewards, and minting your token):
 *
 *   npm run new-wallet
 *
 * Put the key in your server's secrets as HOT_WALLET_WIF, and keep a copy somewhere safe: it can be
 * imported into Electron Cash (File → New → Import Bitcoin Cash addresses or private keys) or Cashonize.
 * Anyone with it can spend what the hot wallet holds, so keep only what rewards need in it.
 */
import { keyWallet, newWalletKey } from "../src/bch.js";

const wif = newWalletKey();
const w = keyWallet(wif);
console.log(`HOT_WALLET_WIF=${wif}\n`);
console.log(`Address (send it a little BCH for fees, e.g. 0.0002): ${w.address}`);
console.log(`Token address (where token supply lives):         ${w.tokenAddress}`);
