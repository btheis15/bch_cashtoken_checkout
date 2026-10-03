/**
 * The shop's own token: minted from your server, and what wallets show for it (CashTokens, CHIP-BCMR).
 *
 *   const token = createTokenIssuer({ wallet, store, siteUrl: "https://shop.example" });
 *   await token.create({ name: "Shop Rewards", symbol: "SHOP", supply: 1_000_000, decimals: 0, description, icon, web });
 *   // serve token.registry(category) at https://shop.example/bcmr/<category>.json (Access-Control-Allow-Origin: *)
 *
 * A fungible token's whole supply is made in one transaction (its "genesis") and never added to. Minting
 * spends an output at index 0 made for it: that output's transaction, the "authbase", gives the token its
 * category ID. The supply goes into the hot wallet (src/hot-wallet.js), which hands it out as rewards.
 *
 * The genesis also publishes what wallets show for the token (name, symbol, decimals, description, icon,
 * website): a registry file served at <site>/bcmr/<category>.json, with its SHA-256 on chain as
 * OP_RETURN <'BCMR'> <hash> <uri>. Output 0 of the genesis, a little BCH back to the hot wallet, is the
 * token's identity output. An update spends it in a new transaction that publishes the new registry and
 * keeps output 0, so the identity stays with the shop. Wallets (Paytaca, Cashonize) follow this chain of
 * outputs (the "authchain") through Paytaca's indexer. Reward sends never spend it: whoever does would
 * control what wallets show.
 *
 * Each step's transaction is recorded before it's sent, and a retry sends the very same one, so a lost
 * reply never mints twice or loses the identity. Costs: about 0.00001 BCH in fees, plus 0.00002 BCH kept
 * with the token's outputs.
 */
import { hexToBin } from "@bitauth/libauth";
import { BchError, bcmrOutput, bchExplorerUrl, buildFromWallet, signWalletPayment } from "./bch.js";
import { tokenText } from "./tokens.js";

const IDENTITY_SATS = 1000;
const AUTHBASE_SATS = 2000;
const MAX_FT = 9223372036854775807n;
const KEY = "bch_token";

export function createTokenIssuer({
  wallet,
  store,
  /** The website wallets read the registry from (https://…). A function for a live setting. */
  siteUrl,
  /** The registry's own name and description (shown by some wallets and explorers). */
  registryName = "Token registry",
  registryDescription = "What wallets show for this shop's own tokens.",
  now = () => Date.now(),
} = {}) {
  if (!wallet || !store) throw new Error("createTokenIssuer needs the hot wallet and a store with getMeta/putMeta.");
  const iso = (ms = now()) => new Date(ms).toISOString();
  const state = async () => (await store.getMeta(KEY)) ?? null;
  const put = async (patch) => store.putMeta(KEY, { ...((await state()) ?? {}), ...patch });
  const site = () => String((typeof siteUrl === "function" ? siteUrl() : siteUrl) ?? "").replace(/\/$/, "");
  // Where the registry is served, without "https://" (as it's published on chain).
  const host = () => (/^https:\/\/[^/]+/.test(site()) ? site().replace(/^https:\/\//, "") : null);
  const offline = () => new BchError("Couldn't reach the Bitcoin Cash network. Please try again in a moment.", { status: 502 });

  // Outputs only the token's own transactions spend: its identity output, and an authbase waiting to mint from.
  let guarded = new Set();
  const refreshGuard = async () => {
    const t = await state();
    guarded = new Set([...(t?.identity ?? []), ...(t?.pending ? [`${t.pending.txid}:0`] : [])]);
  };
  wallet.guard(() => guarded);
  const ready = refreshGuard();

  /** The registry file (its exact bytes are hashed and published): every snapshot of the token's identity so far. */
  function registryJson(t, snapshots) {
    const web = site() || undefined;
    const registry = {
      $schema: "https://cashtokens.org/bcmr-v2.schema.json",
      version: { major: 1, minor: snapshots.length - 1, patch: 0 },
      latestRevision: snapshots.at(-1).at,
      registryIdentity: { name: registryName, description: registryDescription, ...(web ? { uris: { web } } : {}) },
      identities: {
        [t.category]: Object.fromEntries(
          snapshots.map((x) => [
            x.at,
            {
              name: x.name,
              ...(x.description ? { description: x.description } : {}),
              token: { category: t.category, symbol: t.symbol, decimals: t.decimals },
              uris: { ...(x.icon ? { icon: x.icon } : {}), ...(x.web || web ? { web: x.web || web } : {}) },
            },
          ]),
        ),
      },
    };
    return JSON.stringify(registry, null, 2);
  }

  function checkInfo(input, creating) {
    const errors = {};
    const clean = (v, max) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
    const name = clean(input.name, 40);
    const description = clean(input.description, 400);
    const web = clean(input.web, 200);
    const icon = clean(input.icon, 300);
    if (!name) errors.name = "A name, e.g. Shop Rewards.";
    if (web && !/^https:\/\/\S+$/.test(web)) errors.web = "A web address starting with https://";
    if (icon && !/^(https:\/\/|ipfs:\/\/)\S+$/.test(icon)) errors.icon = "The icon's address, starting with https:// (or ipfs://): a square PNG or SVG, ideally 512px.";
    const out = { name, description, web: web || null, icon: icon || null };
    if (creating) {
      const symbol = clean(input.symbol, 12).toUpperCase();
      const decimals = Number(input.decimals ?? 0);
      const supply = Number(input.supply);
      if (!/^[A-Z0-9]{2,12}$/.test(symbol)) errors.symbol = "2 to 12 letters or numbers, e.g. SHOP.";
      if (!(Number.isInteger(decimals) && decimals >= 0 && decimals <= 8)) errors.decimals = "From 0 to 8 (usually 0: whole tokens).";
      let base = 0n;
      if (!(Number.isSafeInteger(supply) && supply >= 1)) errors.supply = "A whole number of tokens, e.g. 1000000.";
      else if (!errors.decimals) {
        base = BigInt(supply) * 10n ** BigInt(decimals);
        if (base > MAX_FT) errors.supply = "That's more than a token can have; try fewer.";
      }
      Object.assign(out, { symbol, decimals, supply: base.toString() });
    }
    if (Object.keys(errors).length) throw new BchError("Please check the token's details.", { errors });
    return out;
  }

  /**
   * Mints the token into the hot wallet, with what wallets show for it. Two small transactions: the authbase
   * (an output at index 0 to mint from), then the genesis. Returns status(): use `token.category` for your
   * coupons and rewards settings.
   */
  async function create(input = {}) {
    await ready;
    if ((await state())?.category) throw new BchError("The token is already minted.", { status: 409 });
    const w = wallet.must();
    if (!host()) throw new BchError("The website's address (https://…) is needed first: wallets read the token's details from it.", { status: 409 });
    const info = checkInfo(input, true);
    return wallet.exclusive(async () => {
      if ((await state())?.category) throw new BchError("The token is already minted.", { status: 409 });
      const self = hexToBin(w.lockingBytecode);
      // 1. The authbase: an output at index 0, made fresh (so it's certainly the shop's), kept until it's minted from.
      let base = (await state())?.pending ?? null;
      let change = null;
      if (!base) {
        const coins = await wallet.coins().catch(() => {
          throw offline();
        });
        let built;
        try {
          built = buildFromWallet({ wallet: w, utxos: coins, outputs: [{ lockingBytecode: self, valueSatoshis: BigInt(AUTHBASE_SATS) }] });
        } catch (e) {
          throw new BchError(`${e.message} Send the hot wallet about 0.0001 BCH (minting uses about 0.00003).`, { status: 409 });
        }
        const signed = signWalletPayment(built, w.privateKey);
        const failed = await wallet.broadcastOnce(signed.hex);
        if (failed) throw new BchError(`The network didn't take it (${failed.message}). Nothing changed; please try again.`, { status: 502 });
        wallet.markSpent(wallet.spendsOf(built));
        base = { txid: signed.txid, genesis: null };
        if (built.transaction.outputs[1]) change = { txid: signed.txid, vout: 1, sats: Number(built.transaction.outputs[1].valueSatoshis), token: null };
        await put({ pending: base });
        await refreshGuard();
      }
      // 2. The genesis, planned once and recorded before it's sent.
      if (!base.genesis) {
        const category = base.txid;
        const t = { category, symbol: info.symbol, decimals: info.decimals };
        const snapshot = { at: iso(), name: info.name, description: info.description, icon: info.icon, web: info.web };
        const json = registryJson(t, [snapshot]);
        const uri = `${host()}/bcmr/${category}.json`;
        const others = await wallet.coins().catch(() => []);
        const utxos = [...(change ? [change] : []), ...others.filter((u) => !(change && u.txid === change.txid && u.vout === change.vout))];
        let built;
        try {
          built = buildFromWallet({
            wallet: w,
            utxos,
            spend: [{ txid: base.txid, vout: 0, sats: AUTHBASE_SATS, token: null }],
            outputs: [
              { lockingBytecode: self, valueSatoshis: BigInt(IDENTITY_SATS) },
              { lockingBytecode: self, valueSatoshis: 1000n, token: { category: hexToBin(category), amount: BigInt(info.supply) } },
              bcmrOutput(json, uri),
            ],
          });
        } catch (e) {
          throw new BchError(`${e.message} Send the hot wallet a little more BCH, then try again.`, { status: 409 });
        }
        const signed = signWalletPayment(built, w.privateKey);
        base = { ...base, genesis: { hex: signed.hex, txid: signed.txid, spends: wallet.spendsOf(built), t, snapshot, json, uri, supply: info.supply } };
        await put({ pending: base });
      }
      const g = base.genesis;
      const sent = await wallet.sendRecorded(g);
      if (!sent.ok) {
        await put({ pending: { ...base, genesis: null } });
        throw new BchError(`The network didn't take it (${sent.message}). Please try again in a moment.`, { status: 502 });
      }
      wallet.markSpent(g.spends);
      await put({
        pending: null,
        ...g.t,
        supply: g.supply,
        snapshots: [g.snapshot],
        registry: { json: g.json, uri: g.uri, tx: g.txid, at: g.snapshot.at },
        genesisTxid: g.txid,
        authhead: `${g.txid}:0`,
        identity: [`${g.txid}:0`],
        update: null,
        createdAt: g.snapshot.at,
      });
      await refreshGuard();
      return status();
    });
  }

  /** Publishes new details for wallets to show (name, description, icon, website) as a new snapshot. Symbol and decimals stay as minted. */
  async function update(input = {}) {
    await ready;
    if (!(await state())?.category) throw new BchError("Mint the token first.", { status: 409 });
    const w = wallet.must();
    if (!host()) throw new BchError("The website's address (https://…) is needed first.", { status: 409 });
    const info = checkInfo(input, false);
    return wallet.exclusive(async () => {
      let t = await state();
      if (!t.update) {
        const [txid, vout] = t.authhead.split(":");
        const snapshots = [...t.snapshots, { at: iso(), name: info.name, description: info.description, icon: info.icon, web: info.web }];
        const json = registryJson(t, snapshots);
        const uri = `${host()}/bcmr/${t.category}.json`;
        const coins = await wallet.coins().catch(() => {
          throw offline();
        });
        let built;
        try {
          built = buildFromWallet({
            wallet: w,
            utxos: coins,
            spend: [{ txid, vout: Number(vout), sats: IDENTITY_SATS, token: null }],
            outputs: [{ lockingBytecode: hexToBin(w.lockingBytecode), valueSatoshis: BigInt(IDENTITY_SATS) }, bcmrOutput(json, uri)],
          });
        } catch (e) {
          throw new BchError(`${e.message} Send the hot wallet a little BCH, then try again.`, { status: 409 });
        }
        const signed = signWalletPayment(built, w.privateKey);
        // The new identity output is guarded from the moment it's planned.
        await put({ update: { hex: signed.hex, txid: signed.txid, spends: wallet.spendsOf(built), snapshots, json, uri }, identity: [...t.identity, `${signed.txid}:0`].slice(-8) });
        await refreshGuard();
        t = await state();
      }
      const u = t.update;
      const sent = await wallet.sendRecorded(u);
      if (!sent.ok) {
        await put({ update: null });
        throw new BchError(`The network didn't take it (${sent.message}). Please try again in a moment.`, { status: 502 });
      }
      wallet.markSpent(u.spends);
      await put({ update: null, snapshots: u.snapshots, registry: { json: u.json, uri: u.uri, tx: u.txid, at: u.snapshots.at(-1).at }, authhead: `${u.txid}:0` });
      return status();
    });
  }

  /** The registry wallets fetch, as the exact text whose hash is on chain (null for any other category). */
  async function registry(category) {
    const t = await state();
    return t?.category && t.category === category ? t.registry.json : null;
  }

  /** For your admin screen: the hot wallet, and the token once minted. */
  async function status() {
    const t = await state();
    const w = wallet.info();
    const held = w ? await wallet.balance() : null;
    const last = t?.snapshots?.at(-1) ?? null;
    return {
      registryHost: host(),
      wallet: w ? { address: w.address, tokenAddress: w.tokenAddress, bch: held?.bch ?? null, sats: held?.sats ?? null } : null,
      minting: Boolean(t?.pending),
      token: t?.category
        ? {
            category: t.category,
            name: last.name,
            symbol: t.symbol,
            decimals: t.decimals,
            supply: tokenText(t.supply, t),
            held: held ? tokenText(held.tokens[t.category] ?? "0", t) : null,
            description: last.description ?? "",
            web: last.web ?? "",
            icon: last.icon ?? null,
            registryUrl: `https://${t.registry.uri}`,
            publishedAt: t.registry.at,
            genesisUrl: bchExplorerUrl(t.genesisTxid),
            publishedUrl: bchExplorerUrl(t.registry.tx),
            updates: t.snapshots.length - 1,
            history: t.snapshots.map((x) => ({ at: x.at, name: x.name })),
            updating: Boolean(t.update),
          }
        : null,
    };
  }

  return { create, update, registry, status };
}
