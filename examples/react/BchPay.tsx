"use client";

/**
 * The Bitcoin Cash payment screen. Give it the view from your server, an API (createBchApi), your
 * brand and, for Connect wallet, a WalletConnect connector:
 *
 *   <BchPay api={createBchApi(order.id)} initial={view} brand={{ name: "Example Shop", logo: "/logo.png" }}
 *           wc={createBchWalletConnect({ projectId, name: "Example Shop", icon: "/logo.png" })} onPaid={…} />
 *
 * It shows the amount and how long the price is held, a "Pay now" button that opens the pay sheet
 * (PaySheet.tsx: connect a wallet, or any wallet by QR code or link), the order in BCH line by line,
 * and the payment's status, which updates by itself. When the payment arrives it bursts into "Payment
 * received!", then shows what was paid and any reward (BchRewardCard.tsx).
 *
 * Needs `uqr` (npm i uqr), bch-pay.css, and for Connect wallet @walletconnect/sign-client.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BchApi } from "./api";
import { BchRewardCard } from "./BchRewardCard";
import { BchIcon, BchReceipt, dollars, DoneTick, RewardGlyph, RollingAmount } from "./parts";
import { PaySheet } from "./PaySheet";
import { BCH_WALLETS, type BchBrand, type BchQuote, type BchView } from "./types";
import type { BchWalletConnect } from "./walletConnect";

// The burst when the payment lands: threads in the theme's colors fly out from the tick (colored in bch-pay.css).
const BURST = Array.from({ length: 22 }, (_, i) => ({
  angle: i * (360 / 22) + ((i * 37) % 11) - 5,
  dist: 74 + ((i * 53) % 46),
  spin: ((i * 71) % 300) - 150,
  delay: (i % 4) * 18,
}));

function PaymentLanded() {
  return (
    <div className="bchpay-landed" role="status" aria-live="polite">
      <div className="bchpay-landed-mark" aria-hidden="true">
        <span className="bchpay-landed-wave" />
        <span className="bchpay-landed-wave" style={{ animationDelay: "0.25s" }} />
        {BURST.map((b, i) => (
          <span key={i} className="bchpay-thread" style={{ "--a": `${b.angle}deg`, "--d": `${b.dist}px`, "--s": `${b.spin}deg`, animationDelay: `${180 + b.delay}ms` } as React.CSSProperties} />
        ))}
        <DoneTick className="bchpay-landed-tick" />
      </div>
      <p className="bchpay-landed-text bchpay-title">Payment received!</p>
      <p className="bchpay-landed-text bchpay-text" style={{ animationDelay: "0.55s" }}>
        Thank you. Just a moment while we finish your order<span className="bchpay-dots" />
      </p>
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

// A clock that ticks every second once the page is in the browser (null while rendering on a server).
let clock = 0;
const subscribeClock = (onTick: () => void) => {
  clock = Date.now();
  const t = setInterval(() => {
    clock = Date.now();
    onTick();
  }, 1000);
  return () => clearInterval(t);
};
const clockNow = () => clock || null;
const noClock = () => null;

export function BchPay({
  api,
  initial,
  brand,
  wc = null,
  test = false,
  autoOpen = true,
  onPaid,
  className = "",
  style,
}: {
  api: BchApi;
  initial: BchView;
  brand: BchBrand;
  /** createBchWalletConnect(…): offers "Connect wallet" (one transaction with the BCH and the shop's tokens). */
  wc?: BchWalletConnect | null;
  /** A test order: a note that it's a small real payment (BCH has no test network). */
  test?: boolean;
  /** The pay sheet slides up by itself when the shopper arrives (once per order in this browser tab). */
  autoOpen?: boolean;
  /** Called once when the payment counts (e.g. empty the cart, show your thank-you page). */
  onPaid?: (view: BchView) => void;
  /** Theme it here (style={{ "--bchpay-accent": "#b8873a" }}) or with a .bchpay rule in your stylesheet. */
  className?: string;
  style?: React.CSSProperties;
}) {
  const [bch, setBch] = useState(initial);
  const now = useSyncExternalStore(subscribeClock, clockNow, noClock);
  const [renewing, setRenewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const money = brand.money ?? dollars;
  // What the token choice in the sheet makes of the order (shown in the receipt as the slider moves).
  const [preview, setPreview] = useState<BchQuote | null>(null);
  const [sheet, setSheet] = useState(false);
  const canConnect = Boolean(wc?.enabled && bch.walletPay);
  // A rewards promotion was shown while paying: after paying, the reward card waits for what was earned.
  const offered = useRef(Boolean(initial.rewardOffer));
  if (bch.rewardOffer) offered.current = true;

  const seen = `bchpay-sheet:${initial.id}`;
  useEffect(() => {
    if (!autoOpen || initial.state !== "waiting") return;
    const remembered = (set?: boolean) => {
      try {
        if (set) sessionStorage.setItem(seen, "1");
        return Boolean(sessionStorage.getItem(seen));
      } catch {
        return false; // private browsing: it opens every time
      }
    };
    if (remembered()) return;
    const t = setTimeout(() => {
      remembered(true);
      setSheet(true);
    }, 450);
    return () => clearTimeout(t);
  }, [autoOpen, initial.state, seen]);

  const paidOnce = useRef(false);
  useEffect(() => {
    if (bch.state === "paid" && !paidOnce.current) {
      paidOnce.current = true;
      onPaid?.(bch);
    }
  }, [bch, onPaid]);

  /** Look at the payment now (back from the wallet app, or just paid from the wallet). */
  const checkNowRef = useRef(checkNow);
  useEffect(() => {
    checkNowRef.current = checkNow;
  });
  async function checkNow() {
    try {
      setBch(await api.status());
    } catch {
      /* the regular check follows */
    }
  }
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible") void checkNowRef.current();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, []);

  // The payment's status, every few seconds until it's paid (faster while it's arriving, slower in the background).
  const arriving = useRef(false);
  const stateRef = useRef(bch.state);
  useEffect(() => {
    arriving.current = bch.state === "arrived";
    stateRef.current = bch.state;
  }, [bch.state]);
  const finished = bch.state === "paid";
  useEffect(() => {
    if (finished) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const look = async () => {
      try {
        const v = await api.status();
        if (stop) return;
        setBch(v);
        if (v.state === "paid") return;
      } catch {
        /* checked again shortly */
      }
      if (!stop) t = setTimeout(look, stateRef.current === "expired_partial" ? 15_000 : document.hidden ? 10_000 : arriving.current ? 1500 : 3000);
    };
    t = setTimeout(look, 3000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [api, finished]);

  async function renew() {
    setRenewing(true);
    setError(null);
    try {
      setBch(await api.renew());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach checkout. Check your connection and try again.");
    }
    setRenewing(false);
  }

  const left = now !== null && bch.expiresAt ? Math.max(0, Math.floor((Date.parse(bch.expiresAt) - now) / 1000)) : null;
  const timeUp = left === 0;
  const open = (bch.state === "waiting" || bch.state === "partial") && !timeUp && bch.uri && bch.address && bch.amountBch;
  const lowTime = left !== null && left <= 120;
  const held = left === null ? 1 : Math.min(1, left / (bch.minutes * 60));
  const receipt = preview?.breakdown ?? bch.breakdown;
  const contact = brand.contactUrl ? (
    <a href={brand.contactUrl} className="bchpay-underline">
      Contact us
    </a>
  ) : null;

  return (
    <div className={`bchpay bchpay-screen ${className}`} style={style}>
      {test && <p className="bchpay-note">Test order: send just {money(bch.usdCents)} of real Bitcoin Cash. BCH has no test network, so this is a real (tiny) payment, and it goes to the shop&apos;s own wallet.</p>}

      {bch.applied && bch.state !== "paid" && (
        <p key={bch.applied.label} className="bchpay-rise bchpay-applied" style={{ animationDelay: "0s" }} role="status">
          <b>
            {bch.applied.bch ? "Tokens applied" : "Coupon applied"}: {bch.applied.label}
          </b>{" "}
          · {bch.applied.bch ? `${bch.applied.bch} BCH (${money(bch.applied.discountCents)})` : money(bch.applied.discountCents)} off. The amount below is your new total.
        </p>
      )}

      {open ? (
        <div className="bchpay-card">
          {/* How long the price is held: a bar that runs down, changing color in the last two minutes. */}
          <div className="bchpay-hold-track" aria-hidden="true">
            <div className={`bchpay-hold ${lowTime ? "low" : ""}`} style={{ width: `${held * 100}%` }} />
          </div>
          <div className="bchpay-card-body">
            <div className="bchpay-card-top">
              <div className="bchpay-grow">
                <p className="bchpay-rise bchpay-eyebrow bchpay-inline" style={{ animationDelay: "0.1s" }}>
                  <BchIcon size={14} /> {bch.state === "partial" ? "Left to pay" : "Pay with Bitcoin Cash"}
                </p>
                <p className="bchpay-amount">
                  <RollingAmount value={bch.amountBch!} /> <span className="bchpay-unit bchpay-unit-in">BCH</span>
                </p>
                <p className="bchpay-rise bchpay-text" style={{ animationDelay: "0.35s" }}>
                  {bch.state === "partial" ? `Order total ${money(bch.usdCents)}` : `${money(preview?.breakdown?.total.cents ?? bch.breakdown?.total.cents ?? bch.usdCents)} at today's rate`}
                  {left !== null && (
                    <>
                      {" "}
                      · <span className={`bchpay-nums ${lowTime ? "bchpay-bad-text" : ""}`}>held {Math.floor(left / 60)}:{pad(left % 60)}</span>
                    </>
                  )}
                </p>
              </div>
              {brand.logo ? <img src={brand.logo} alt="" className="bchpay-pop-in bchpay-card-logo" /> : <BchIcon size={64} className="bchpay-pop-in" />}
            </div>
            {bch.state === "partial" && (
              <p className="bchpay-rise bchpay-warn bchpay-gap">
                We&apos;ve received {bch.paidBch} BCH. Please send the remaining <strong>{bch.amountBch} BCH</strong> to complete your order.
              </p>
            )}
            <button type="button" onClick={() => setSheet(true)} className="bchpay-connect">
              <span className="bchpay-connect-glow" aria-hidden="true" />
              <span className="bchpay-connect-inner">
                <span>
                  <span className="bchpay-block bchpay-title-sm">Pay now</span>
                  <span className="bchpay-block bchpay-connect-sub">{canConnect ? "Connect your wallet, or scan with any wallet" : "Scan or open in any Bitcoin Cash wallet"}</span>
                </span>
                <BchIcon size={30} />
              </span>
            </button>
            {bch.rewardOffer && (
              <p className="bchpay-reward bchpay-gap">
                <RewardGlyph />
                <span>
                  Earn {bch.rewardOffer.tokens} {bch.rewardOffer.symbol ?? bch.rewardOffer.label} back for every {bch.rewardOffer.perBch} BCH
                </span>
              </p>
            )}
            <p className="bchpay-small bchpay-center-text bchpay-gap">
              {bch.coupon?.stack ? `Use your ${brand.tokenName ?? brand.name} tokens in the next step. ` : ""}Nothing is sent until you approve it in your wallet.
            </p>
          </div>

          {receipt && <BchReceipt breakdown={receipt} paid={bch.state === "partial" ? bch.paidBch : null} left={bch.state === "partial" ? bch.amountBch : null} money={money} />}

          <div className="bchpay-status" role="status" aria-live="polite">
            <span className="bchpay-ping" aria-hidden="true">
              <span />
              <span />
            </span>
            <p>
              <b>Watching the network for your payment.</b> <span className="bchpay-muted-text">This page updates by itself the moment it arrives, usually within seconds.</span>
            </p>
          </div>
        </div>
      ) : bch.state === "arrived" ? (
        <PaymentLanded />
      ) : bch.state === "paid" ? (
        <div className="bchpay-paid" role="status">
          <DoneTick className="bchpay-paid-tick" />
          <div>
            <p className="bchpay-title-sm">Paid {bch.paidBch} BCH</p>
            <p className="bchpay-text">
              {bch.applied ? `${bch.applied.label}: ${money(bch.applied.discountCents)} off. ` : ""}
              {bch.txUrl && (
                <a href={bch.txUrl} target="_blank" rel="noopener noreferrer" className="bchpay-underline">
                  See it on the blockchain
                </a>
              )}
            </p>
          </div>
        </div>
      ) : bch.state === "checking" ? (
        <div className="bchpay-box" role="status">
          <p className="bchpay-strong">Payment received: the network is double-checking it</p>
          <p className="bchpay-text">This usually takes a few minutes. There&apos;s nothing more you need to do: this page updates by itself.</p>
        </div>
      ) : bch.state === "expired_partial" ? (
        <div className="bchpay-box" role="status">
          <p className="bchpay-strong">Part of your payment arrived</p>
          <p className="bchpay-text">
            We received {bch.paidBch} of {bch.totalBch} BCH before the price hold ended. Please don&apos;t send any more: we&apos;ll be in touch to either complete your order or send it back. {contact}
          </p>
        </div>
      ) : (
        <div className="bchpay-box" role="status" aria-live="polite">
          {bch.state === "expired" ? (
            <>
              <p className="bchpay-strong">The price hold has ended</p>
              <p className="bchpay-text">Nothing was received, so nothing was charged. Bitcoin Cash prices move, so each one is held for {bch.minutes} minutes.</p>
              {bch.canRenew && (
                <button type="button" onClick={renew} disabled={renewing} className="bchpay-primary bchpay-gap-lg">
                  {renewing ? "Getting a new price…" : "Get a new price"}
                </button>
              )}
            </>
          ) : (
            <>
              <p className="bchpay-strong">Checking for your payment…</p>
              <p className="bchpay-text">The price hold has just ended. If you sent the payment in time, it will show here in a moment. Please don&apos;t send it again.</p>
            </>
          )}
          {error && (
            <p role="alert" className="bchpay-alert bchpay-gap">
              {error}
            </p>
          )}
        </div>
      )}

      {(bch.reward || (bch.state === "paid" && offered.current)) && <BchRewardCard api={api} initial={bch.reward ?? null} brand={brand} wc={wc} />}

      {/* Kept while it's up, so it can show "Paid" when the payment lands. */}
      {(open || sheet) && <PaySheet open={sheet} onClose={() => setSheet(false)} api={api} bch={bch} brand={brand} left={left} wc={wc} onPreview={setPreview} onSent={checkNow} />}

      {bch.state !== "paid" && (
        <div className="bchpay-help">
          <details>
            <summary>Which wallet can I use?</summary>
            <p>
              Any Bitcoin Cash wallet, for example{" "}
              {BCH_WALLETS.map((w, i) => (
                <span key={w.name}>
                  <a href={w.url} target="_blank" rel="noopener noreferrer" className="bchpay-underline">
                    {w.name}
                  </a>
                  {i < BCH_WALLETS.length - 2 ? ", " : i === BCH_WALLETS.length - 2 ? " or " : ""}
                </span>
              ))}
              . Make sure you&apos;re sending Bitcoin Cash (BCH), not Bitcoin (BTC).
            </p>
          </details>
          <details>
            <summary>Paying from an exchange?</summary>
            <p>Some exchanges take their fee out of the amount you send, so less than the full amount arrives. Send from your own wallet if you can, or check the exchange will deliver the exact amount shown. If it arrives short, this page shows what&apos;s left to send.</p>
          </details>
          <details>
            <summary>Is it safe?</summary>
            <p>
              Your payment goes straight into our own wallet: there&apos;s no payment company in between, and we never see your wallet or its keys. Bitcoin Cash payments can&apos;t be reversed, so check the amount before you send.{contact ? <> Questions? {contact}.</> : null}
            </p>
          </details>
        </div>
      )}
    </div>
  );
}
