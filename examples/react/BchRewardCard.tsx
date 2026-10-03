"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { BchApi } from "./api";
import { BchIcon, QrCode, RewardGlyph } from "./parts";
import type { BchBrand, BchReward } from "./types";
import { declined, type BchWalletConnect } from "./walletConnect";

const touch = () => window.matchMedia("(pointer: coarse)");
const subscribeTouch = (fn: () => void) => {
  const m = touch();
  m.addEventListener("change", fn);
  return () => m.removeEventListener("change", fn);
};
const shortAddress = (a: string) => {
  const body = a.replace(/^bitcoincash:/, "");
  return `${body.slice(0, 6)}…${body.slice(-6)}`;
};

/**
 * The reward after paying (the shop's tokens, cash back): on its way, sent, or to claim. Paid from a
 * connected wallet, they're sent straight back; paid from any other wallet (maybe an exchange), the shopper
 * claims them here, by connecting a wallet or pasting an address that holds tokens.
 */
export function BchRewardCard({ api, initial, brand, wc = null }: { api: BchApi; initial: BchReward | null; brand: BchBrand; wc?: BchWalletConnect | null }) {
  const [reward, setReward] = useState(initial);
  const [uri, setUri] = useState<string | null>(null);
  const [paste, setPaste] = useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phone = useSyncExternalStore(subscribeTouch, () => touch().matches, () => false);

  // Just paid: the reward is worked out a moment later; and one on its way turns to "sent".
  useEffect(() => {
    if (reward && reward.state !== "sending") return;
    let tries = 0;
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const look = async () => {
      try {
        const v = await api.status();
        if (stop) return;
        if (v.reward) setReward(v.reward);
        if (v.reward && v.reward.state !== "sending") return;
      } catch {
        /* again shortly */
      }
      if (!stop && ++tries < (reward ? 40 : 6)) t = setTimeout(look, reward ? 4000 : 3000);
    };
    t = setTimeout(look, 2000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [api, reward]);

  async function claim(to: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.claim(to);
      if (!r.reward) throw new Error("Couldn't claim it just now. Please try again.");
      setReward(r.reward);
      setUri(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function claimWithWallet() {
    if (!wc) return;
    setError(null);
    setBusy(true);
    try {
      const known = await wc.resume();
      if (known) return void (await claim(known.address));
      const c = await wc.start();
      setUri(c.uri);
      setBusy(false);
      const w = await c.connected;
      await claim(w.address);
    } catch (e) {
      setUri(null);
      setBusy(false);
      setError(declined(e) ? "The connection was declined in your wallet." : "Couldn't reach a wallet just now. Try again, or paste an address.");
    }
  }

  if (!reward) return null;

  return (
    <section className="bchpay-reward-card" aria-live="polite">
      <div className="bchpay-reward-head">
        <span className="bchpay-reward-coin">{brand.logo ? <img src={brand.logo} alt="" /> : <BchIcon size={40} />}</span>
        <div className="bchpay-grow">
          <p className="bchpay-eyebrow bchpay-inline">
            <RewardGlyph size={14} /> Your reward
          </p>
          <p className="bchpay-title">You earned {reward.text}</p>
          <p className="bchpay-text">{reward.rule}</p>
        </div>
      </div>

      {reward.state === "sent" ? (
        <p className="bchpay-gap">
          Sent to your wallet{reward.to ? ` (${shortAddress(reward.to)})` : ""}.{" "}
          {reward.txUrl && (
            <a href={reward.txUrl} target="_blank" rel="noopener noreferrer" className="bchpay-underline">
              See it on the blockchain
            </a>
          )}
          {reward.txUrl ? ". " : " "}
          Bring them to your next order: they take Bitcoin Cash off.
        </p>
      ) : reward.state === "sending" ? (
        <p className="bchpay-gap bchpay-inline">
          <span className="bchpay-watching">
            <span aria-hidden="true" />
          </span>
          On their way to your wallet{reward.to ? ` (${shortAddress(reward.to)})` : ""}…
        </p>
      ) : reward.state === "expired" ? (
        <p className="bchpay-gap bchpay-text">This reward wasn&apos;t claimed in time.</p>
      ) : uri ? (
        <div className="bchpay-center bchpay-gap-lg">
          {phone ? (
            <a href={uri} className="bchpay-primary">
              Open my wallet app
            </a>
          ) : (
            <QrCode text={uri} size={208} label="QR code to connect your wallet" logo={brand.logo} listening />
          )}
          <p className="bchpay-text bchpay-gap-sm">Approve the connection in Cashonize, Paytaca or Zapit, and your reward goes straight to it.</p>
          <button type="button" onClick={() => setUri(null)} className="bchpay-link bchpay-gap-sm">
            Cancel
          </button>
        </div>
      ) : (
        <div className="bchpay-gap-lg">
          <p className="bchpay-text">
            Claim them to a wallet that holds tokens: Cashonize, Paytaca, Zapit or Electron Cash.
            {reward.claimUntil ? ` Until ${new Date(reward.claimUntil).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}.` : ""}
          </p>
          <div className="bchpay-buttons">
            {wc?.enabled && (
              <button type="button" onClick={claimWithWallet} disabled={busy} className="bchpay-button">
                {busy ? "Claiming…" : "Claim with my wallet"}
              </button>
            )}
            <button type="button" onClick={() => setPaste((v) => !v)} className="bchpay-button secondary">
              Paste an address
            </button>
          </div>
          {paste && (
            <form
              className="bchpay-claim-form"
              onSubmit={(e) => {
                e.preventDefault();
                void claim(address.trim());
              }}
            >
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="bitcoincash:z… or bitcoincash:q…" spellCheck={false} autoComplete="off" aria-label="Your wallet's address" />
              <button type="submit" disabled={busy || !address.trim()} className="bchpay-button">
                {busy ? "Claiming…" : "Claim"}
              </button>
            </form>
          )}
          <p className="bchpay-small bchpay-gap-sm">Not an exchange&apos;s address: exchanges can&apos;t hold the shop&apos;s tokens.</p>
        </div>
      )}
      {error && (
        <p role="alert" className="bchpay-alert bchpay-gap">
          {error}
        </p>
      )}
    </section>
  );
}
