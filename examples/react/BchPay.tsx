"use client";

/**
 * The Bitcoin Cash payment screen: amount and address (QR code on a computer,
 * "open in wallet" on a phone), copy buttons, the price countdown, live status,
 * part payments, "get a new price", and the CashTokens coupon step.
 *
 * Give it the view from your server (createBchCheckout().view / check) and two
 * functions that call your API. Needs `uqr` (npm i uqr) and bch-pay.css.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { encode } from "uqr";

export type BchView = {
  id: string;
  state: "waiting" | "partial" | "arrived" | "paid" | "checking" | "expired" | "expired_partial";
  address: string | null;
  amountBch: string | null;
  totalBch: string | null;
  paidBch: string | null;
  uri: string | null;
  usdCents: number;
  expiresAt: string | null;
  minutes: number;
  canRenew: boolean;
  txUrl: string | null;
  coupon: { address: string; uri: string; coupons: { label: string; off: string; send: string }[] } | null;
  applied: { label: string; discountCents: number } | null;
};

const WALLETS = [
  { name: "Selene", url: "https://selene.cash" },
  { name: "Paytaca", url: "https://www.paytaca.com" },
  { name: "Cashonize", url: "https://cashonize.com" },
  { name: "Electron Cash", url: "https://electroncash.org" },
];
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const pad = (n: number) => String(n).padStart(2, "0");

// A clock that ticks every second in the browser (null while rendering on a server).
let clock = 0;
const subscribeClock = (onTick: () => void) => {
  clock = Date.now();
  const t = setInterval(() => {
    clock = Date.now();
    onTick();
  }, 1000);
  return () => clearInterval(t);
};

/** The payment link as a QR code, drawn here (nothing is sent to a QR service). */
export function QrCode({ text, size }: { text: string; size: number }) {
  const { d, n } = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 2 });
    let path = "";
    qr.data.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (!row[x]) continue;
        let run = 1;
        while (row[x + run]) run++;
        path += `M${x} ${y}h${run}v1h-${run}z`;
        x += run - 1;
      }
    });
    return { d: path, n: qr.size };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" role="img" aria-label="QR code with the payment address and amount">
      <rect width={n} height={n} fill="#ffffff" />
      <path d={d} fill="#111111" />
    </svg>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const el = document.createElement("textarea");
      el.value = value;
      document.body.append(el);
      el.select();
      document.execCommand("copy");
      el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button type="button" onClick={copy} className="bchpay-copy" aria-label={`Copy the ${label}`}>
      <span aria-live="polite">{copied ? "Copied ✓" : "Copy"}</span>
    </button>
  );
}

function CouponStep({ coupon }: { coupon: NonNullable<BchView["coupon"]> }) {
  const [show, setShow] = useState(false);
  if (!show)
    return (
      <div className="bchpay-coupon">
        <p>
          <strong>Have a coupon token?</strong> Send it before you pay and the discount comes off.
        </p>
        <button type="button" onClick={() => setShow(true)} className="bchpay-button bchpay-secondary">
          Use a coupon
        </button>
      </div>
    );
  return (
    <div className="bchpay-coupon bchpay-grid">
      <div className="bchpay-qr">
        <QrCode text={coupon.uri} size={168} />
        <p className="bchpay-muted">Scan to send your coupon</p>
      </div>
      <div>
        <p>
          <strong>Send your coupon token to this address</strong>
        </p>
        <ul>
          {coupon.coupons.map((c) => (
            <li key={c.label}>
              <strong>{c.label}</strong>: {c.off} <span className="bchpay-muted">· send {c.send}</span>
            </li>
          ))}
        </ul>
        <div className="bchpay-row">
          <code className="bchpay-address">{coupon.address}</code>
          <CopyButton value={coupon.address} label="coupon address" />
        </div>
        <a href={coupon.uri} className="bchpay-button bchpay-secondary">
          Send it from my wallet app
        </a>
        <p className="bchpay-muted">It takes a few seconds: the discount appears above and the amount updates by itself. One coupon per order.</p>
      </div>
    </div>
  );
}

export function BchPay({ initial, load, renew, onPaid, testNote }: { initial: BchView; load: () => Promise<BchView>; renew: () => Promise<BchView>; onPaid?: (v: BchView) => void; testNote?: string }) {
  const [bch, setBch] = useState(initial);
  const now = useSyncExternalStore(subscribeClock, () => clock || null, () => null);
  const [renewing, setRenewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const arriving = useRef(false);
  useEffect(() => {
    arriving.current = bch.state === "arrived";
  }, [bch.state]);

  const settled = bch.state === "paid" || bch.state === "expired_partial";
  useEffect(() => {
    if (bch.state === "paid") {
      onPaid?.(bch);
      return;
    }
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const v = await load();
        if (stop) return;
        setBch(v);
        if (v.state === "paid") return;
      } catch {
        /* checked again shortly */
      }
      if (!stop) t = setTimeout(tick, settled ? 15_000 : document.hidden ? 10_000 : arriving.current ? 1500 : 3000);
    };
    t = setTimeout(tick, 3000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bch.state === "paid", settled]);

  async function newPrice() {
    setRenewing(true);
    setError(null);
    try {
      setBch(await renew());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't get a new price. Please try again.");
    }
    setRenewing(false);
  }

  const left = now !== null && bch.expiresAt ? Math.max(0, Math.floor((Date.parse(bch.expiresAt) - now) / 1000)) : null;
  const open = (bch.state === "waiting" || bch.state === "partial") && left !== 0 && bch.uri && bch.address && bch.amountBch;

  return (
    <div className="bchpay">
      {testNote && <p className="bchpay-note">{testNote}</p>}
      {bch.applied && (
        <p className="bchpay-ok" role="status">
          <strong>Coupon applied: {bch.applied.label}</strong> · {dollars(bch.applied.discountCents)} off. The amount below is your new total.
        </p>
      )}

      {open ? (
        <div className="bchpay-card">
          <div className="bchpay-grid">
            <div className="bchpay-qr">
              <QrCode text={bch.uri!} size={208} />
              <p className="bchpay-muted">Scan with your wallet app</p>
            </div>
            <div>
              {bch.state === "partial" && (
                <p className="bchpay-warn">
                  We&apos;ve received {bch.paidBch} BCH. Please send the remaining <strong>{bch.amountBch} BCH</strong>.
                </p>
              )}
              <p className="bchpay-label">{bch.state === "partial" ? "Send the rest" : "Send exactly"}</p>
              <div className="bchpay-row">
                <p className="bchpay-amount">
                  {bch.amountBch} <small>BCH</small>
                </p>
                <CopyButton value={bch.amountBch!} label="amount" />
              </div>
              <p className="bchpay-muted">
                {dollars(bch.usdCents)} at today&apos;s rate
                {left !== null && ` · price held for ${Math.floor(left / 60)}:${pad(left % 60)}`}
              </p>
              <p className="bchpay-label">To this address</p>
              <div className="bchpay-row">
                <code className="bchpay-address">{bch.address}</code>
                <CopyButton value={bch.address!} label="address" />
              </div>
              <a href={bch.uri!} className="bchpay-button">
                Open in my wallet app
              </a>
            </div>
          </div>
          <div className="bchpay-status" role="status" aria-live="polite">
            <span className="bchpay-dot" /> <strong>Waiting for your payment.</strong> This page updates by itself the moment it arrives.
          </div>
        </div>
      ) : bch.state === "arrived" ? (
        <div className="bchpay-ok" role="status">
          <span className="bchpay-dot" /> <strong>Payment received! Just a moment…</strong>
        </div>
      ) : bch.state === "paid" ? (
        <div className="bchpay-ok" role="status">
          <strong>Paid {bch.paidBch} BCH. Thank you!</strong>{" "}
          {bch.txUrl && (
            <a href={bch.txUrl} target="_blank" rel="noopener noreferrer">
              View the transaction
            </a>
          )}
        </div>
      ) : bch.state === "checking" ? (
        <div className="bchpay-card bchpay-pad" role="status">
          <strong>Payment received: the network is double-checking it.</strong> This usually takes a few minutes; there&apos;s nothing more you need to do.
        </div>
      ) : bch.state === "expired_partial" ? (
        <div className="bchpay-card bchpay-pad" role="status">
          <strong>Part of your payment arrived</strong> ({bch.paidBch} of {bch.totalBch} BCH) before the price hold ended. Please don&apos;t send more: we&apos;ll be in touch to complete your order or send it back.
        </div>
      ) : (
        <div className="bchpay-card bchpay-pad" role="status" aria-live="polite">
          {bch.state === "expired" ? (
            <>
              <strong>The price hold has ended.</strong> Nothing was received, so nothing was charged. Each price is held for {bch.minutes} minutes.
              {bch.canRenew && (
                <button type="button" onClick={newPrice} disabled={renewing} className="bchpay-button">
                  {renewing ? "Getting a new price…" : "Get a new price"}
                </button>
              )}
            </>
          ) : (
            <>
              <strong>Checking for your payment…</strong> The price hold has just ended. If you sent it in time, it will show here in a moment. Please don&apos;t send it again.
            </>
          )}
          {error && (
            <p role="alert" className="bchpay-error">
              {error}
            </p>
          )}
        </div>
      )}

      {open && bch.coupon && <CouponStep coupon={bch.coupon} />}

      <details className="bchpay-help">
        <summary>Which wallet can I use?</summary>
        <p>
          Any Bitcoin Cash wallet, for example{" "}
          {WALLETS.map((w, i) => (
            <span key={w.name}>
              <a href={w.url} target="_blank" rel="noopener noreferrer">
                {w.name}
              </a>
              {i < WALLETS.length - 2 ? ", " : i === WALLETS.length - 2 ? " or " : ""}
            </span>
          ))}
          . Make sure you&apos;re sending Bitcoin Cash (BCH), not Bitcoin (BTC).
        </p>
      </details>
      <details className="bchpay-help">
        <summary>Paying from an exchange?</summary>
        <p>Some exchanges take their fee out of the amount you send, so less than the full amount arrives. Send from your own wallet if you can; if it arrives short, this page shows what&apos;s left to send.</p>
      </details>
      <details className="bchpay-help">
        <summary>Is it safe?</summary>
        <p>Your payment goes straight into the shop&apos;s own wallet: there&apos;s no payment company in between, and the shop never sees your wallet or its keys. Bitcoin Cash payments can&apos;t be reversed, so check the amount before you send.</p>
      </details>
    </div>
  );
}
