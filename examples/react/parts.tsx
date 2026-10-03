"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { encode } from "uqr";
import type { BchBreakdown } from "./types";

export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const QUIET = 4;
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The payment link as a QR code, drawn here (nothing is sent to a QR service): softly rounded squares,
 * the corner markers in your colors, and your logo (or the Bitcoin Cash mark) in the middle. Error
 * correction "H" leaves room for it. It ripples out from the middle as it appears, a ring draws round the
 * logo, a sheen passes over it, and while `listening` soft rings pulse out behind it.
 * Colors: --bchpay-qr-bg, --bchpay-qr-dots, --bchpay-qr-marker, --bchpay-qr-eye, --bchpay-qr-ring (bch-pay.css).
 */
export function QrCode({ text, size, label, logo, listening = false }: { text: string; size: number; label: string; logo?: string; listening?: boolean }) {
  const { dots, markers, full, c, logoR } = useMemo(() => {
    const { size: n, data, types } = encode(text, { ecc: "H", border: 0 });
    const U = 10;
    const at = (i: number) => (i + QUIET) * U;
    const mid = n / 2;
    const logoR = n * 0.12;
    let dots = "";
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!data[y][x] || types[y][x] === 2 || Math.hypot(x + 0.5 - mid, y + 0.5 - mid) < logoR + 0.9) continue;
        const px = r2(at(x) + U * 0.025);
        const py = r2(at(y) + U * 0.025);
        dots += `M${px} ${py}m${U * 0.22} 0h${r2(U * 0.51)}a${U * 0.22} ${U * 0.22} 0 0 1 ${U * 0.22} ${U * 0.22}v${r2(U * 0.51)}a${U * 0.22} ${U * 0.22} 0 0 1 -${U * 0.22} ${U * 0.22}h-${r2(U * 0.51)}a${U * 0.22} ${U * 0.22} 0 0 1 -${U * 0.22} -${U * 0.22}v-${r2(U * 0.51)}a${U * 0.22} ${U * 0.22} 0 0 1 ${U * 0.22} -${U * 0.22}z`;
      }
    }
    const markers = [
      [0, 0],
      [n - 7, 0],
      [0, n - 7],
    ].map(([mx, my]) => ({ x: at(mx), y: at(my) }));
    return { dots, markers, full: (n + QUIET * 2) * U, c: at(0) + mid * U, logoR: logoR * U };
  }, [text]);
  const U = 10;
  const logoPct = `${((logoR * 2) / full) * 100}%`;
  return (
    <div className={`bchpay-qr ${listening ? "listening" : ""}`} style={{ width: size }}>
      <span className="bchpay-sonar" aria-hidden="true" />
      <span className="bchpay-sonar" aria-hidden="true" />
      <div className="bchpay-qr-box">
        <svg viewBox={`0 0 ${full} ${full}`} className="bchpay-qr-code" role="img" aria-label={label}>
          <rect width={full} height={full} rx={3 * U} className="bchpay-qr-bg" />
          <path d={dots} className="bchpay-qr-dots" />
          {markers.map(({ x, y }) => (
            <g key={`${x}-${y}`}>
              <rect x={x + U / 2} y={y + U / 2} width={6 * U} height={6 * U} rx={2 * U} fill="none" strokeWidth={U} className="bchpay-qr-marker" />
              <rect x={x + 2 * U} y={y + 2 * U} width={3 * U} height={3 * U} rx={U} className="bchpay-qr-eye" />
            </g>
          ))}
          <circle cx={c} cy={c} r={logoR + 0.6 * U} className="bchpay-qr-bg" />
          <circle className="bchpay-qr-ring" cx={c} cy={c} r={logoR + 0.6 * U} fill="none" strokeWidth={U * 0.35} pathLength={1} />
        </svg>
        <span className="bchpay-qr-logo" style={{ width: logoPct, height: logoPct }}>
          {logo ? <img src={logo} alt="" /> : <BchIcon size={64} className="bchpay-fill" />}
        </span>
      </div>
    </div>
  );
}

/** Copy: "Copied" rolls up into place, the button turns green and the tick draws itself. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
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
    setCopied((n) => n + 1);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(0), 1800);
  }
  return (
    <button type="button" onClick={copy} className={`bchpay-copy ${copied ? "done" : ""}`} aria-label={copied ? "Copied" : `Copy the ${label}`}>
      <span className="face idle">Copy</span>
      {/* Keyed by the count, so a second tap plays it again. */}
      <span key={copied} className="face ok" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14">
          <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Copied
      </span>
      <span className="bchpay-sr" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

/** The amount, its digits rolling up into place one after another (again whenever it changes). */
export function RollingAmount({ value }: { value: string }) {
  return (
    <span key={value} className="bchpay-roll" aria-label={`${value} BCH`}>
      {[...value].map((ch, i) => (
        <span key={i} aria-hidden="true" style={{ animationDelay: `${120 + i * 38}ms` }}>
          {ch}
        </span>
      ))}
    </span>
  );
}

/** A cash address with its start and end picked out, the parts people check against their wallet. */
export function Address({ value }: { value: string }) {
  const [prefix, body] = value.includes(":") ? [value.slice(0, value.indexOf(":") + 1), value.slice(value.indexOf(":") + 1)] : ["", value];
  const head = body.slice(0, 6);
  const tail = body.length > 12 ? body.slice(-6) : "";
  const middle = body.slice(head.length, body.length - tail.length);
  return (
    <p className="bchpay-address">
      <span className="bchpay-muted-text">{prefix}</span>
      <b>{head}</b>
      {middle}
      <b>{tail}</b>
    </p>
  );
}

/** The order in BCH, line by line, at the price being held: what the tokens took off, and the total. */
export function BchReceipt({ breakdown, paid, left, flat = false, money = dollars }: { breakdown: BchBreakdown; paid: string | null; left: string | null; flat?: boolean; money?: (cents: number) => string }) {
  const minus = (l: { kind: string }) => l.kind === "tokens" || l.kind === "coupon";
  const name = (l: BchBreakdown["lines"][number]) => (l.kind === "items" ? "Items" : l.kind === "shipping" ? "Shipping" : l.kind === "tax" ? "Sales tax" : l.label);
  return (
    <div className={flat ? "" : "bchpay-receipt"}>
      {!flat && (
        <p className="bchpay-rise bchpay-eyebrow" style={{ animationDelay: "0.6s" }}>
          Your order in Bitcoin Cash
        </p>
      )}
      <dl className="bchpay-lines">
        {breakdown.lines.map((l, i) => (
          <div key={l.kind} className={`bchpay-line ${l.kind === "tokens" ? "tokens" : ""}`} style={{ animationDelay: `${0.7 + i * 0.07}s` }}>
            <dt>
              {name(l)}
              {l.kind === "tokens" ? (
                <span className="bchpay-chip">
                  {l.tokens} × {l.each}
                </span>
              ) : (l.kind === "items" || l.kind === "shipping") && l.label !== name(l) ? (
                <span className="bchpay-muted-text"> · {l.label}</span>
              ) : null}
            </dt>
            <dd>
              <span className="bchpay-nowrap">
                {minus(l) ? "−" : ""}
                {l.kind === "shipping" && !l.cents ? "Free" : `${l.bch} BCH`}
              </span>
              <span className="bchpay-small">
                {minus(l) ? "−" : ""}
                {money(l.cents)}
              </span>
            </dd>
          </div>
        ))}
        <div className="bchpay-line total" style={{ animationDelay: `${0.7 + breakdown.lines.length * 0.07}s` }}>
          <dt>Total</dt>
          <dd>
            <span className="bchpay-nowrap bchpay-display">{breakdown.total.bch} BCH</span>
            <span className="bchpay-small">{money(breakdown.total.cents)}</span>
          </dd>
        </div>
        {paid && left && (
          <>
            <div className="bchpay-line">
              <dt>Received so far</dt>
              <dd className="bchpay-nowrap">−{paid} BCH</dd>
            </div>
            <div className="bchpay-line total">
              <dt>Left to send</dt>
              <dd className="bchpay-nowrap bchpay-display">{left} BCH</dd>
            </div>
          </>
        )}
      </dl>
      <p className="bchpay-small bchpay-gap">
        At ${breakdown.usdPerBch.toFixed(2)} per BCH{breakdown.sources.length ? ` (the middle of ${breakdown.sources.join(", ")})` : ""}, held while the timer runs.
      </p>
    </div>
  );
}

/**
 * The Bitcoin Cash mark, as the BCH community uses it: the green disc (#0AC18E) and the white ₿ leaning to
 * the left. Not Bitcoin's (BTC) orange mark, whose ₿ leans right.
 */
export function BchIcon({ size = 18, className = "", label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg viewBox="0 0 788 788" width={size} height={size} className={`bchpay-icon ${className}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <circle cx="394" cy="394" r="394" fill="#0AC18E" />
      <path
        fill="#FFFFFF"
        d="M516.9 261.7c-19.8-44.9-65.3-54.5-121-45.2L378 147.1l-42.2 10.9 17.6 69.2c-11.1 2.8-22.5 5.2-33.8 8.4L302 166.8l-42.2 10.9 17.9 69.4c-9.1 2.6-85.2 22.1-85.2 22.1l11.6 45.2s31-8.7 30.7-8c17.2-4.5 25.3 4.1 29.1 12.2l49.2 190.2c.6 5.5-.4 14.9-12.2 18.1.7.4-30.7 7.9-30.7 7.9l4.6 52.7s75.4-19.3 85.3-21.8l18.1 70.2 42.2-10.9-18.1-70.7c11.6-2.7 22.9-5.5 33.9-8.4l18 70.3 42.2-10.9-18.1-70.1c65-15.8 110.9-56.8 101.5-119.5-6-37.8-47.3-68.8-81.6-72.3 21-18.6 31.7-45.9 18.6-81.6zm-20.3 165.5c8.4 62.1-77.9 69.7-106.4 77.2l-24.8-92.9c28.6-7.5 117-39 131.2 15.7zm-52-126.5c8.9 55.2-64.9 61.6-88.7 67.7l-22.6-84.3c23.9-5.9 93.2-34.5 111.3 16.6z"
      />
    </svg>
  );
}

/** The rewards mark: a coin with a spark (colors from --bchpay-accent and --bchpay-accent-2). */
export function RewardGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="bchpay-icon">
      <circle cx="11" cy="13" r="8" className="bchpay-glyph-coin" strokeWidth="1.8" />
      <circle cx="11" cy="13" r="4.5" className="bchpay-glyph-coin" strokeWidth="1.4" />
      <path d="M19 2.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" className="bchpay-glyph-spark" />
    </svg>
  );
}

/** A wallet with the Bitcoin Cash mark: "connect your wallet", "approve it in your wallet". */
export function WalletGlyph() {
  return (
    <span className="bchpay-wallet-glyph">
      <svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true">
        <rect x="5" y="12" width="38" height="27" rx="6" className="bchpay-glyph-ink" />
        <path d="M11 12l19-6 3 6" fill="none" strokeWidth="3" strokeLinejoin="round" className="bchpay-glyph-ink-line" />
        <rect x="29" y="21" width="14" height="9" rx="3" className="bchpay-glyph-accent" />
        <circle cx="34.5" cy="25.5" r="1.8" className="bchpay-glyph-bg" />
      </svg>
      <span className="bchpay-wallet-glyph-badge">
        <BchIcon size={22} />
      </span>
    </span>
  );
}

/** The "Paid" tick: a green disc, a ring, and the tick drawing itself. */
export function DoneTick({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className}>
      <circle cx="32" cy="32" r="30" className="bchpay-tick-disc" />
      <circle cx="32" cy="32" r="27" fill="none" strokeWidth="1.5" className="bchpay-tick-ring" />
      <path d="M19 33.5l8.5 8.5L45.5 23" fill="none" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" pathLength={1} className="bchpay-tick-path" />
    </svg>
  );
}
