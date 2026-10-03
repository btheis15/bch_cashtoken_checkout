"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BchApi } from "./api";
import { BchIcon, dollars, QrCode } from "./parts";
import type { BchBrand, BchReceiptToken } from "./types";
import { declined, type BchWalletConnect } from "./walletConnect";

type Phase = "paper" | "morph" | "spin" | "throw" | "land" | "inwallet";

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
const paidWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const middle = (s: string) => {
  const body = s.replace(/^bitcoincash:/, "");
  return body.length > 16 ? `${body.slice(0, 8)}…${body.slice(-8)}` : body;
};
const played = (name: string, set = false) => {
  try {
    if (set) sessionStorage.setItem(`bchpay-receipt:${name}`, "1");
    return Boolean(sessionStorage.getItem(`bchpay-receipt:${name}`));
  } catch {
    return set;
  }
};
// Sparks that burst from the coin as it's thrown (colored in bch-pay.css), and the ghost coins streaking behind it.
const SPARKS = Array.from({ length: 14 }, (_, i) => ({ a: i * (360 / 14) + ((i * 29) % 9), d: 46 + ((i * 37) % 30), delay: (i % 3) * 25 }));
const FLIGHT = [0, 45, 90, 135];

/**
 * The receipt as a CashToken, after paying. It shows the receipt as paper. When the CashToken goes to the shopper's
 * wallet, the paper folds into a coin (your logo on it, or the Bitcoin Cash mark), which spins and is thrown into
 * their wallet, then settles into "In your wallet". Paid from a wallet that can't safely be sent tokens, the
 * shopper claims it here first (by connecting a wallet, or pasting an address that holds tokens).
 *
 *   <ReceiptToken api={api} initial={view.receipt} expected={view.receiptPref !== "email"} brand={brand} wc={wc} />
 */
export function ReceiptToken({ api, initial, expected = false, brand, wc = null }: { api: BchApi; initial: BchReceiptToken | null; expected?: boolean; brand: BchBrand; wc?: BchWalletConnect | null }) {
  const money = brand.money ?? dollars;
  const [rt, setRt] = useState(initial);
  const [phase, setPhase] = useState<Phase>(initial?.state === "sent" && played(initial.name) ? "inwallet" : "paper");
  const [open, setOpen] = useState(false);
  const [uri, setUri] = useState<string | null>(null);
  const [paste, setPaste] = useState(false);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flight, setFlight] = useState({ cx: 0, cy: 0, dx: 0, dy: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const wallet = useRef<HTMLSpanElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const phone = useSyncExternalStore(subscribeTouch, () => touch().matches, () => false);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  /** Folds the receipt into a coin and throws it into the wallet. */
  const throwIt = useCallback(() => {
    if (!rt || !stage.current || !paper.current) return;
    played(rt.name, true);
    setOpen(false);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setPhase("inwallet");
    const s = stage.current.getBoundingClientRect();
    const p = paper.current.getBoundingClientRect();
    const cx = p.left - s.left + p.width / 2;
    const cy = p.top - s.top + Math.min(p.height / 2, 220);
    setFlight({ cx, cy, dx: 0, dy: 0 });
    setPhase("morph");
    const at = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
    at(760, () => setPhase("spin"));
    at(1380, () => {
      const w = wallet.current?.getBoundingClientRect();
      const st = stage.current?.getBoundingClientRect();
      if (w && st) setFlight({ cx, cy, dx: w.left - st.left + w.width / 2 - cx, dy: w.top - st.top + w.height / 2 - cy });
      setPhase("throw");
    });
    at(2300, () => setPhase("land"));
    at(3500, () => setPhase("inwallet"));
  }, [rt]);

  // Just paid with a CashToken chosen (it's made a moment later), or being minted: look again until it's there.
  useEffect(() => {
    if (rt ? rt.state !== "sending" : !expected) return;
    let stop = false;
    let tries = 0;
    let t: ReturnType<typeof setTimeout>;
    const look = async () => {
      try {
        const v = await api.status();
        if (stop) return;
        if (v.receipt) setRt(v.receipt);
        if (v.receipt && v.receipt.state !== "sending") return;
      } catch {
        /* again shortly */
      }
      if (!stop && ++tries < (rt ? 40 : 8)) t = setTimeout(look, rt ? 3000 : 2500);
    };
    t = setTimeout(look, 2000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [api, rt, expected]);

  // In the wallet and not yet seen being thrown there (in this tab): a moment to see the receipt, then the throw.
  useEffect(() => {
    if (rt?.state !== "sent" || phase !== "paper" || played(rt.name)) return;
    const t = setTimeout(throwIt, 1100);
    return () => clearTimeout(t);
  }, [rt, phase, throwIt]);

  async function claim(to: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.receipt(to);
      if (!r.receipt) throw new Error("Couldn't send your receipt just now. Please try again.");
      setUri(null);
      setPaste(false);
      setRt(r.receipt);
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

  if (!rt) return null;
  const r = rt.receipt;
  const flying = phase === "morph" || phase === "spin" || phase === "throw" || phase === "land";
  const showPaper = phase !== "inwallet" || open;
  const mark = (size: number) => (brand.logo ? <img src={brand.logo} alt="" /> : <BchIcon size={size} />);

  return (
    <section className={`bchpay bchpay-receipt-token ${flying ? "flying" : ""}`} aria-live="polite">
      <div className="bchpay-receipt-top">
        <p className="bchpay-eyebrow">Your receipt · a CashToken</p>
        {phase === "inwallet" && (
          <button type="button" onClick={() => setOpen((o) => !o)} className="bchpay-link">
            {open ? "Hide receipt" : "View receipt"}
          </button>
        )}
      </div>

      <div ref={stage} className="bchpay-receipt-stage" data-phase={phase} style={{ "--cx": `${flight.cx}px`, "--cy": `${flight.cy}px`, "--dx": `${flight.dx}px`, "--dy": `${flight.dy}px` } as React.CSSProperties}>
        {flying && (
          <span ref={wallet} className="bchpay-receipt-wallet" aria-hidden="true">
            <span className="bchpay-receipt-wallet-ring" />
            <svg viewBox="0 0 48 48" width="34" height="34">
              <rect x="5" y="12" width="38" height="27" rx="6" className="bchpay-glyph-ink" />
              <path d="M11 12l19-6 3 6" fill="none" strokeWidth="3" strokeLinejoin="round" className="bchpay-glyph-ink-line" />
              <rect x="29" y="21" width="14" height="9" rx="3" className="bchpay-glyph-accent" />
              <circle cx="34.5" cy="25.5" r="1.8" className="bchpay-glyph-bg" />
            </svg>
            <span className="bchpay-receipt-plus">+1 {rt.name.replace(/ #.*$/, "")}</span>
          </span>
        )}

        <div className={`bchpay-details bchpay-receipt-fold ${showPaper ? "open" : ""}`}>
          <div>
            <div ref={paper} className="bchpay-receipt-paper">
              <div className="bchpay-receipt-paper-inner">
                <header className="bchpay-receipt-head">
                  <span className="bchpay-receipt-head-mark">{mark(44)}</span>
                  <div className="bchpay-grow">
                    <p className="bchpay-title-sm">{r.shop}</p>
                    <p className="bchpay-text">{paidWhen(r.paidAt)}</p>
                  </div>
                  <span className="bchpay-chip">{rt.name.replace(/ #.*$/, "")}</span>
                </header>
                <p className="bchpay-title">{r.order}</p>
                <dl className="bchpay-receipt-lines">
                  {r.items.map((i) => (
                    <div key={`${i.title}-${i.option}-${i.qty}`}>
                      <dt>
                        {i.qty} × {i.title}
                        {i.option && <span className="bchpay-small">{i.option}</span>}
                        {i.qty > 1 && <span className="bchpay-small">{money(i.unitCents)} each</span>}
                      </dt>
                      <dd>{money(i.cents)}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>Subtotal</dt>
                    <dd>{money(r.subtotalCents)}</dd>
                  </div>
                  {r.discount && (
                    <div className="bchpay-ok-text">
                      <dt>
                        {r.discount.label}
                        {r.discount.tokens && (
                          <span className="bchpay-small">
                            {r.discount.tokens}
                            {r.discount.bch ? ` · ${r.discount.bch} BCH` : ""}
                          </span>
                        )}
                      </dt>
                      <dd>−{money(r.discount.cents)}</dd>
                    </div>
                  )}
                  {r.shipping && (
                    <div>
                      <dt>
                        Shipping<span className="bchpay-small">{r.shipping.label}</span>
                      </dt>
                      <dd>{r.shipping.cents ? money(r.shipping.cents) : "Free"}</dd>
                    </div>
                  )}
                  {r.taxCents > 0 && (
                    <div>
                      <dt>Sales tax</dt>
                      <dd>{money(r.taxCents)}</dd>
                    </div>
                  )}
                  {(r.otherCents ?? 0) > 0 && (
                    <div>
                      <dt>Other</dt>
                      <dd>{money(r.otherCents!)}</dd>
                    </div>
                  )}
                  <div className="total">
                    <dt>Total</dt>
                    <dd>{money(r.totalCents)}</dd>
                  </div>
                </dl>
                <dl className="bchpay-receipt-pay">
                  <div>
                    <dt className="bchpay-inline">
                      <BchIcon size={12} /> Paid
                    </dt>
                    <dd>
                      {r.payment.paidBch} BCH
                      {r.payment.usdPerBch ? <span className="bchpay-small">at ${r.payment.usdPerBch.toFixed(2)} per BCH</span> : null}
                    </dd>
                  </div>
                  <div>
                    <dt>How</dt>
                    <dd>{r.payment.method}</dd>
                  </div>
                  {r.payment.paidTo && (
                    <div>
                      <dt>To</dt>
                      <dd className="bchpay-mono" title={r.payment.paidTo}>
                        {middle(r.payment.paidTo)}
                      </dd>
                    </div>
                  )}
                  {r.payment.tx && (
                    <div>
                      <dt>Transaction</dt>
                      <dd>
                        <a href={`https://blockchair.com/bitcoin-cash/transaction/${r.payment.tx}`} target="_blank" rel="noopener noreferrer" className="bchpay-mono bchpay-underline">
                          {middle(r.payment.tx)}
                        </a>
                      </dd>
                    </div>
                  )}
                  {r.reward && (
                    <div>
                      <dt>Earned</dt>
                      <dd>{r.reward}</dd>
                    </div>
                  )}
                </dl>
                {(r.returns || r.website || r.contact) && (
                  <p className="bchpay-small bchpay-center-text bchpay-gap-sm">
                    {r.returns && <span className="bchpay-block">{r.returns}</span>}
                    {[r.website?.replace(/^https?:\/\//, ""), r.contact].filter(Boolean).join(" · ")}
                  </p>
                )}
                {r.note && <p className="bchpay-receipt-note">{r.note}</p>}
                <p className="bchpay-receipt-foot">One of a kind · numbered by your order · yours to keep</p>
              </div>
            </div>
          </div>
        </div>

        {flying &&
          FLIGHT.map((delay, i) => (
            <span key={delay} className={`bchpay-fly-x ${i ? "ghost" : ""}`} style={{ animationDelay: `${delay}ms`, "--ghost": String(0.45 - i * 0.12) } as React.CSSProperties} aria-hidden="true">
              <span className="bchpay-fly-y" style={{ animationDelay: `${delay}ms` }}>
                <span className="bchpay-coin">
                  <span className="bchpay-coin-face">
                    <span className="bchpay-coin-mark">{mark(64)}</span>
                  </span>
                  {i === 0 && SPARKS.map((sp, n) => <span key={n} className="bchpay-spark" style={{ "--a": `${sp.a}deg`, "--d": `${sp.d}px`, animationDelay: `${sp.delay}ms` } as React.CSSProperties} />)}
                </span>
              </span>
            </span>
          ))}
      </div>

      {phase === "inwallet" && rt.state === "sent" ? (
        <div className="bchpay-receipt-landed">
          <span className="bchpay-mini-coin" aria-hidden="true">
            {mark(36)}
          </span>
          <div className="bchpay-grow">
            <p className="bchpay-title-sm">{rt.name} is in your wallet</p>
            <p className="bchpay-text">
              {rt.to ? `${shortAddress(rt.to)} · ` : ""}
              {rt.txUrl && (
                <a href={rt.txUrl} target="_blank" rel="noopener noreferrer" className="bchpay-underline">
                  See it on the blockchain
                </a>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setPhase("paper");
              timers.current.push(setTimeout(throwIt, 1300));
            }}
            className="bchpay-link"
            aria-label="Play the animation again"
          >
            Replay
          </button>
        </div>
      ) : rt.state === "sending" ? (
        <p className="bchpay-watching bchpay-gap">
          <span aria-hidden="true" />
          Minting your receipt{rt.to ? ` for ${shortAddress(rt.to)}` : ""}…
        </p>
      ) : rt.state === "sent" ? (
        <p className="bchpay-watching bchpay-gap">On its way into your wallet…</p>
      ) : rt.state === "expired" ? (
        <p className="bchpay-text bchpay-center-text bchpay-gap">This receipt wasn&apos;t claimed in time. Your order is still here, and so is the receipt above.</p>
      ) : uri ? (
        <div className="bchpay-center bchpay-gap-lg">
          {phone ? (
            <a href={uri} className="bchpay-primary">
              Open my wallet app
            </a>
          ) : (
            <QrCode text={uri} size={208} label="QR code to connect your wallet" logo={brand.logo} listening />
          )}
          <p className="bchpay-text bchpay-gap-sm">Approve the connection in Cashonize, Paytaca or Zapit, and your receipt goes straight to it.</p>
          <button type="button" onClick={() => setUri(null)} className="bchpay-link bchpay-gap-sm">
            Cancel
          </button>
        </div>
      ) : (
        <div className="bchpay-gap-lg">
          <p className="bchpay-text">
            Send it to a wallet that holds CashTokens: Cashonize, Paytaca, Zapit or Electron Cash.
            {rt.claimUntil ? ` Until ${new Date(rt.claimUntil).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}.` : ""}
          </p>
          <div className="bchpay-buttons">
            {wc?.enabled && (
              <button type="button" onClick={claimWithWallet} disabled={busy} className="bchpay-button">
                {busy ? "Sending…" : "Send to my wallet"}
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
                {busy ? "Sending…" : "Send it"}
              </button>
            </form>
          )}
          <p className="bchpay-small bchpay-gap-sm">Not an exchange&apos;s address: exchanges can&apos;t hold CashTokens.</p>
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

/**
 * The choice at checkout: the receipt by email, as a CashToken, or both. Show it when paying with Bitcoin Cash
 * and your server has receipts set up; send the value with the order (start({ receipt })).
 */
export function ReceiptChoice({ value, onChange, tokenName = "CashToken" }: { value: "email" | "token" | "both"; onChange: (v: "email" | "token" | "both") => void; tokenName?: string }) {
  const options = [
    ["email", "Email", "To your inbox"],
    ["token", tokenName, "To your wallet"],
    ["both", "Both", "Inbox and wallet"],
  ] as const;
  return (
    <div className="bchpay bchpay-receipt-choices" role="radiogroup" aria-label="Your receipt">
      {options.map(([v, label, hint]) => (
        <label key={v} className={`bchpay-receipt-choice ${value === v ? "on" : ""}`}>
          <input type="radio" name="bchpay-receipt" className="bchpay-sr" checked={value === v} onChange={() => onChange(v)} />
          <span className={`bchpay-receipt-choice-mark ${v}`} aria-hidden="true" />
          <span className="bchpay-strong">{label}</span>
          <span className="bchpay-small">{hint}</span>
        </label>
      ))}
    </div>
  );
}
