/**
 * CashTokens amounts, and the merchant's coupon and rewards settings.
 *
 * Amounts on the chain are whole numbers in a token's smallest unit: with
 * `decimals: 2`, 150 on the chain is 1.5 tokens. A BCH-valued coupon
 * (`kind: "bch"`) says what one whole token takes off, in BCH.
 */
import { BchError, satsFor } from "./bch.js";

const HEX64 = /^[0-9a-f]{64}$/;

/** 10^decimals: how many of the smallest unit make one token. */
export const tokenScale = (t) => 10n ** BigInt(t?.decimals ?? 0);

/** What one whole token of a BCH-valued coupon takes off, in satoshis. */
export const satsPerToken = (c) => BigInt(Math.round(c.value * 1e8));

/** A token amount as wallets show it: "1.5 SHOP", "3 tokens". */
export function tokenText(amount, t = {}) {
  const scale = tokenScale(t);
  const a = BigInt(amount ?? 0);
  const whole = (a / scale).toString();
  const frac = (a % scale).toString().padStart(Number(t.decimals ?? 0), "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} ${t.symbol ?? (a === scale ? "token" : "tokens")}`;
}

/** How many tokens (in their smallest unit) of a BCH-valued coupon cover `cents` at `usdPerBch` (rounded up). */
export function tokensFor(c, cents, usdPerBch) {
  const per = satsPerToken(c);
  return (BigInt(satsFor(cents, usdPerBch)) * tokenScale(c) + per - 1n) / per;
}

/** What a percent or dollar coupon takes off the items (never more than they cost). */
export const couponDiscount = (c, subtotalCents) => Math.min(subtotalCents, c.kind === "percent" ? Math.round((subtotalCents * c.value) / 100) : Math.round(c.value * 100));

const text = (v, max) => String(v ?? "").trim().slice(0, max);

/**
 * Checks and tidies a list of coupons (from your admin screen or config). Throws a BchError with
 * `errors` ({ "0.value": "…" }) when something is off.
 *
 *   { category, label, token: "ft" | "nft", units, kind: "percent" | "amount" | "bch", value, symbol, decimals, active }
 *
 * percent: a whole percentage off the items (1–90) · amount: dollars off the items (1–500) ·
 * bch: each token takes `value` BCH off (0.00001–10), fungible tokens only; any number can be sent.
 */
export function checkCoupons(list) {
  const errors = {};
  const seen = new Set();
  const out = (Array.isArray(list) ? list : []).slice(0, 10).map((c, i) => {
    const category = text(c?.category, 64).toLowerCase();
    const token = c?.token === "nft" ? "nft" : "ft";
    const kind = c?.kind === "amount" || c?.kind === "bch" ? c.kind : "percent";
    const v = Number(c?.value);
    const units = Math.floor(Number(c?.units ?? 1));
    const decimals = Math.floor(Number(c?.decimals ?? 0));
    if (!HEX64.test(category)) errors[`${i}.category`] = "The token's category ID: 64 letters and numbers (0–9 and a–f).";
    else if (seen.has(category)) errors[`${i}.category`] = "This token is already listed.";
    seen.add(category);
    if (kind === "percent" && !(v >= 1 && v <= 90 && Number.isInteger(v))) errors[`${i}.value`] = "A whole percentage from 1 to 90.";
    if (kind === "amount" && !(v >= 1 && v <= 500)) errors[`${i}.value`] = "An amount from $1 to $500.";
    if (kind === "bch" && !(v >= 0.00001 && v <= 10)) errors[`${i}.value`] = "What one token is worth, from 0.00001 to 10 BCH (e.g. 0.01).";
    if (kind === "bch" && token === "nft") errors[`${i}.token`] = "BCH per token works with fungible tokens.";
    if (kind !== "bch" && token === "ft" && !(units >= 1 && units <= 1_000_000)) errors[`${i}.units`] = "How many tokens make one coupon (usually 1).";
    if (!(decimals >= 0 && decimals <= 8)) errors[`${i}.decimals`] = "The token's decimal places, from 0 to 8 (as set when it was minted; usually 0).";
    return {
      category,
      label: text(c?.label, 60) || "Coupon",
      token,
      units: token === "ft" && kind !== "bch" ? units : 1,
      kind,
      value: kind === "percent" ? Math.round(v) : kind === "bch" ? Math.round(v * 1e8) / 1e8 : Math.round(v * 100) / 100,
      symbol: text(c?.symbol, 20) || null,
      decimals: decimals >= 0 && decimals <= 8 ? decimals : 0,
      active: c?.active !== false,
    };
  });
  if (Object.keys(errors).length) throw new BchError("Please check the coupons.", { errors });
  return out;
}

/** The rewards promotion's settings, filled in with these where not given. */
export const DEFAULT_REWARDS = Object.freeze({ enabled: false, category: "", label: "Rewards", symbol: null, decimals: 0, perBch: 0.1, tokens: 1, maxPerOrder: null, endsOn: null, claimDays: 90 });

/**
 * Checks and tidies the rewards promotion: `tokens` of `category` for every `perBch` BCH paid,
 * optionally at most `maxPerOrder` per order and until `endsOn` (YYYY-MM-DD). Off until `enabled`.
 */
export function checkRewards(input = {}) {
  const errors = {};
  const v = { ...DEFAULT_REWARDS, ...input };
  v.enabled = v.enabled === true;
  v.category = text(v.category, 64).toLowerCase();
  if (v.category && !HEX64.test(v.category)) errors.category = "The token's category ID: 64 letters and numbers (0–9 and a–f).";
  if (v.enabled && !v.category) errors.category = "Choose the token to give.";
  v.label = text(v.label, 40) || DEFAULT_REWARDS.label;
  v.symbol = text(v.symbol, 12) || null;
  v.decimals = Math.floor(Number(v.decimals ?? 0));
  if (!(v.decimals >= 0 && v.decimals <= 8)) errors.decimals = "The token's decimal places, from 0 to 8 (usually 0).";
  v.perBch = Math.round(Number(v.perBch) * 1e8) / 1e8;
  if (!(v.perBch >= 0.0001 && v.perBch <= 100)) errors.perBch = "How much BCH earns a reward, from 0.0001 to 100 (e.g. 0.1).";
  v.tokens = Number(v.tokens);
  if (!(v.tokens > 0 && v.tokens <= 1_000_000)) errors.tokens = "How many tokens each step earns (e.g. 1).";
  else if (!errors.decimals && Math.round(v.tokens * 10 ** v.decimals) !== v.tokens * 10 ** v.decimals) errors.tokens = `This token has ${v.decimals} decimal places.`;
  v.maxPerOrder = v.maxPerOrder === null || v.maxPerOrder === undefined || v.maxPerOrder === "" ? null : Number(v.maxPerOrder);
  if (v.maxPerOrder !== null && !(v.maxPerOrder > 0 && v.maxPerOrder <= 1_000_000)) errors.maxPerOrder = "Leave empty for no limit, or a number of tokens.";
  v.endsOn = v.endsOn ? text(v.endsOn, 10) : null;
  if (v.endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(v.endsOn)) errors.endsOn = "A date as YYYY-MM-DD, or empty.";
  v.claimDays = Math.floor(Number(v.claimDays));
  if (!(v.claimDays >= 1 && v.claimDays <= 3650)) errors.claimDays = "How many days a reward can be claimed, from 1 to 3650.";
  if (Object.keys(errors).length) throw new BchError("Please check the rewards settings.", { errors });
  return v;
}
