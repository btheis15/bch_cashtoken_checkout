"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BchApi } from "./api";
import { Address, BchIcon, BchReceipt, CopyButton, dollars, DoneTick, QrCode, RewardGlyph, RollingAmount, WalletGlyph } from "./parts";
import { rewardEstimate, type BchBrand, type BchQuote, type BchView, type BchWalletInfo } from "./types";
import { Cancelled, declined, type BchWalletConnect, type WalletSession } from "./walletConnect";

type Phase = "starting" | "connecting" | "loading" | "review" | "approving" | "sending" | "done";
type Method = "wallet" | "any";

const sats = (bch: string) => Math.round(Number(bch) * 1e8);
const shortAddress = (a: string) => {
  const body = a.replace(/^bitcoincash:/, "");
  return `${body.slice(0, 5)}…${body.slice(-5)}`;
};
/** A token amount (in its smallest unit) as wallets show it. Counts here stay small (never more than cover an order). */
const tokenCount = (base: number, decimals: number) => (decimals ? (base / 10 ** decimals).toFixed(decimals).replace(/\.?0+$/, "") : String(base));
// A phone (its wallet app is on the same device), as opposed to a computer the wallet scans.
const touch = () => window.matchMedia("(pointer: coarse)");
const subscribeTouch = (fn: () => void) => {
  const m = touch();
  m.addEventListener("change", fn);
  return () => m.removeEventListener("change", fn);
};
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The way to pay with Bitcoin Cash, in one sheet that slides up over the page (from the bottom on a phone,
 * a card in the middle on a computer). It brings together what BCH wallets can do:
 * - Connect a wallet (Cashonize, Paytaca, Zapit, over BCH WalletConnect): see what's in it, choose how
 *   many of the shop's tokens to spend, and pay in one tap; one approval in the wallet sends the BCH and
 *   the tokens together in one transaction. Until then, the tokens can change, or it can be cancelled.
 * - Any wallet (Selene, Electron Cash, an exchange…): scan the QR code or open the payment link, with the
 *   tokens sent first if the shopper has some.
 * Both show the same order in Bitcoin Cash, and both end on the same "Paid".
 */
export function PaySheet({
  open,
  onClose,
  api,
  bch,
  brand,
  left,
  wc,
  onPreview,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  api: BchApi;
  bch: BchView;
  brand: BchBrand;
  left: number | null;
  /** The WalletConnect connector (null: "Any wallet" only). */
  wc: BchWalletConnect | null;
  onPreview: (q: BchQuote | null) => void;
  onSent: () => void;
}) {
  const canConnect = Boolean(wc?.enabled && bch.walletPay);
  const money = brand.money ?? dollars;
  const [method, setMethod] = useState<Method>(canConnect ? "wallet" : "any");
  const [phase, setPhase] = useState<Phase>("starting");
  const [uri, setUri] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [wallet, setWallet] = useState<WalletSession | null>(null);
  const [info, setInfo] = useState<BchWalletInfo | null>(null);
  const [amount, setAmount] = useState(0);
  const [quote, setQuote] = useState<BchQuote | null>(null);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [drag, setDrag] = useState(0);
  const dragFrom = useRef<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const phone = useSyncExternalStore(subscribeTouch, () => touch().matches, () => false);
  const offer = info?.tokens[0] ?? null;
  const max = offer ? Number(offer.max) : 0;
  const viaWallet = method === "wallet" && canConnect;

  const load = useCallback(
    async (w: WalletSession) => {
      setPhase("loading");
      setError(null);
      try {
        const i = await api.wallet(w.address);
        setInfo(i);
        // Start with all the tokens that help; the shopper can use fewer.
        setAmount(i.tokens[0] ? Number(i.tokens[0].max) : 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setPhase("review");
    },
    [api],
  );

  // Connecting: the wallet connected before comes back by itself; otherwise a new connection is offered.
  const begin = useCallback(async () => {
    if (!wc) return;
    setError(null);
    setPhase("starting");
    try {
      const known = await wc.resume();
      if (known) {
        setWallet(known);
        return load(known);
      }
      const c = await wc.start();
      setUri(c.uri);
      setPhase("connecting");
      const w = await c.connected;
      setUri(null);
      setWallet(w);
      await load(w);
    } catch (e) {
      setUri(null);
      setPhase("connecting");
      setError(declined(e) ? "The connection was declined in your wallet." : "Couldn't reach a wallet just now. Try again, or choose “Any wallet”.");
    }
  }, [load, wc]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      setClosing(false);
      if (viaWallet && !wallet && phase === "starting") void begin();
    }, 0);
    document.body.style.overflow = "hidden";
    sheet.current?.focus();
    return () => {
      clearTimeout(t);
      document.body.style.overflow = "";
    };
    // When the sheet opens, or the shopper switches to connecting a wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, viaWallet]);

  // What the order does underneath: paid (either way) → "Paid"; the price hold ended → the sheet steps aside.
  const payable = bch.state === "waiting" || bch.state === "partial";
  const landed = bch.state === "arrived" || bch.state === "checking" || bch.state === "paid";
  useEffect(() => {
    if (!open || phase === "done" || phase === "sending") return;
    if (landed) {
      const t = setTimeout(() => {
        setPhase("done");
        setTimeout(close, 2400);
      }, 0);
      return () => clearTimeout(t);
    }
    if (!payable && phase !== "approving") {
      const t = setTimeout(close, 0);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, payable, landed, phase]);

  // The price for the tokens chosen, asked a moment after the stepper or slider stops.
  useEffect(() => {
    if (!open || !viaWallet || phase !== "review" || !info) return;
    let live = true;
    const t = setTimeout(async () => {
      try {
        const q = await api.quote({ category: offer?.category ?? "", amount: String(amount) });
        if (!live) return;
        setQuote(q);
        onPreview(q);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, viaWallet, phase, info, amount, offer?.category, api, onPreview, bch.amountBch]);

  // Closing plays the slide-out, then the sheet is gone: nothing stays over the page, even if it stays mounted.
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  function close() {
    if (closeTimer.current) return;
    if (phase === "approving") abort.current?.abort();
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined;
      setClosing(false);
      onClose();
    }, 260);
  }

  function choose(m: Method) {
    if (phase === "approving" || phase === "sending") return;
    setMethod(m);
    setError(null);
    onPreview(m === "wallet" ? quote : null);
  }

  async function changeWallet() {
    if (wallet && wc) await wc.disconnect(wallet);
    setWallet(null);
    setInfo(null);
    setQuote(null);
    onPreview(null);
    void begin();
  }

  async function pay() {
    if (!wallet || !wc) return;
    setError(null);
    setPhase("approving");
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const built = await api.build({ address: wallet.address, category: offer?.category ?? "", amount: String(amount) });
      if (ctl.signal.aborted) throw new Cancelled();
      const hex = await wc.sign(wallet, built.request, ctl.signal);
      // Approved: the wallet has sent it. Handing it to the server too makes the page update at once.
      setPhase("sending");
      await api.submit(hex).catch(() => {});
      setPhase("done");
      onSent();
      setTimeout(close, 2400);
    } catch (e) {
      setPhase("review");
      if (e instanceof Cancelled) setError(null);
      else setError(declined(e) ? "You declined it in your wallet. Nothing was sent." : e instanceof Error ? e.message : String(e));
    } finally {
      abort.current = null;
    }
  }

  // Dragging the top of the sheet down closes it (as on a phone).
  const dragStart = (e: React.PointerEvent) => {
    if (phase === "approving" || phase === "sending") return;
    dragFrom.current = e.clientY;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const dragMove = (e: React.PointerEvent) => {
    if (dragFrom.current !== null) setDrag(Math.max(0, e.clientY - dragFrom.current));
  };
  const dragEnd = () => {
    if (dragFrom.current === null) return;
    dragFrom.current = null;
    if (drag > 110) close();
    setDrag(0);
  };

  if (!open && !closing) return null;

  const asked = (viaWallet ? quote?.amountBch : null) ?? bch.amountBch ?? "0";
  const breakdown = (viaWallet ? quote?.breakdown : null) ?? bch.breakdown ?? null;
  const usd = breakdown?.total.cents ?? bch.usdCents;
  const short = info ? sats(info.bch) < sats(asked) + 2000 : false;
  const off = quote?.breakdown?.lines.find((l) => l.kind === "tokens");
  const spending = viaWallet && quote?.tokens && amount > 0 ? quote.tokens.text : null;
  const name = wallet?.name ?? "your wallet";
  const busy = phase === "approving" || phase === "sending";
  // The rewards promotion: what this payment earns back in the shop's tokens.
  const earns = bch.rewardOffer ? rewardEstimate(bch.rewardOffer, asked) : null;
  const held = left !== null && left > 0 ? `${Math.floor(left / 60)}:${pad(left % 60)}` : null;

  /** Connecting a wallet (once; remembered), then the tokens, then waiting for the shopper's approval. */
  function walletPane() {
    if (phase === "starting" || phase === "connecting") {
      return (
        <section className="bchpay-step bchpay-pane">
          {phase === "starting" ? (
            <div className="bchpay-skeleton" style={{ height: "12rem" }} aria-label="Getting ready" />
          ) : uri ? (
            phone && !showQr ? (
              <div className="bchpay-center">
                <WalletGlyph />
                <p className="bchpay-title">Connect your wallet</p>
                <p className="bchpay-text">Cashonize, Paytaca or Zapit opens and asks to connect. Approve it, then come back here to pay.</p>
                <a href={uri} className="bchpay-primary bchpay-gap-lg">
                  Open my wallet app
                </a>
                <div className="bchpay-links">
                  <a href={`https://cashonize.com/?uri=${encodeURIComponent(uri)}`} target="_blank" rel="noopener noreferrer" className="bchpay-link">
                    Cashonize on the web
                  </a>
                  <button type="button" onClick={() => setShowQr(true)} className="bchpay-link">
                    Wallet on another device
                  </button>
                </div>
              </div>
            ) : (
              <div className="bchpay-center">
                <QrCode text={uri} size={236} label="QR code to connect your wallet" logo={brand.logo} listening />
                <p className="bchpay-title">Scan with your wallet to connect</p>
                <p className="bchpay-text">In Cashonize, Paytaca or Zapit. Nothing is paid yet: you&apos;ll see the total first.</p>
                <div className="bchpay-links">
                  <CopyButton value={uri} label="connection link" />
                  {phone && (
                    <button type="button" onClick={() => setShowQr(false)} className="bchpay-link">
                      Back
                    </button>
                  )}
                </div>
              </div>
            )
          ) : (
            <div className="bchpay-center">
              <button type="button" onClick={begin} className="bchpay-primary">
                Try again
              </button>
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

    if (phase === "approving" || phase === "sending") {
      return (
        <section className="bchpay-step bchpay-pane bchpay-center" aria-live="polite">
          <div className="bchpay-approve-mark" aria-hidden="true">
            <span />
            <span />
            <WalletGlyph />
          </div>
          <p className="bchpay-title">{phase === "sending" ? "Sending…" : `Approve it in ${name}`}</p>
          <p className="bchpay-text">
            {asked} BCH{spending ? ` and ${spending}` : ""} to {brand.name}
          </p>
          {phone && phase === "approving" && wallet && wc && (
            <a href={wc.appLink(wallet)} className="bchpay-primary bchpay-gap-lg">
              Open {name}
            </a>
          )}
          {phase === "approving" && (
            <button type="button" onClick={() => abort.current?.abort()} className="bchpay-link bchpay-gap">
              Cancel payment
            </button>
          )}
          <p className="bchpay-small bchpay-gap">Nothing is sent until you approve it.</p>
        </section>
      );
    }

    return (
      <section className="bchpay-step">
        <div className="bchpay-row">
          <span className="bchpay-row-label">Pay with</span>
          <div className="bchpay-grow">
            <p className="bchpay-strong">
              {name} {wallet?.address && <span className="bchpay-small">{shortAddress(wallet.address)}</span>}
            </p>
            <p className="bchpay-text">{info ? `${info.bch} BCH available${offer ? ` · ${offer.haveText}` : ""}` : "Reading your wallet…"}</p>
          </div>
          <button type="button" onClick={changeWallet} className="bchpay-link">
            Change
          </button>
        </div>

        {phase === "loading" && <div className="bchpay-skeleton bchpay-skeleton-row" />}

        {offer && phase === "review" && (
          <div className="bchpay-row stack">
            <div className="bchpay-token-row">
              <div className="bchpay-grow">
                <p className="bchpay-strong">{offer.label} tokens</p>
                <p className="bchpay-ok-text">{offer.value} BCH off each</p>
              </div>
              {max > 0 && (
                <div className="bchpay-stepper">
                  <button type="button" onClick={() => setAmount((a) => Math.max(0, a - 1))} disabled={amount <= 0} aria-label="One fewer">
                    −
                  </button>
                  <span>
                    <RollingAmount value={tokenCount(amount, offer.decimals)} />
                  </span>
                  <button type="button" onClick={() => setAmount((a) => Math.min(max, a + 1))} disabled={amount >= max} aria-label="One more">
                    +
                  </button>
                </div>
              )}
            </div>
            {max > 1 && (
              <input
                type="range"
                className="bchpay-range"
                min={0}
                max={max}
                step={1}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                aria-label={`How many ${offer.symbol ?? "tokens"} to use`}
                style={{ "--fill": `${(amount / max) * 100}%` } as React.CSSProperties}
              />
            )}
            <p className="bchpay-text bchpay-gap-sm" aria-live="polite">
              {max === 0 ? (
                "None in this wallet."
              ) : off && amount > 0 ? (
                <span className="bchpay-ok-text">
                  Saves {off.bch} BCH ({money(off.cents)}) · using {tokenCount(amount, offer.decimals)} of {offer.haveText}
                </span>
              ) : (
                `Keeping all ${offer.haveText} for another time`
              )}
            </p>
          </div>
        )}
      </section>
    );
  }

  return (
    <div className={`bchpay bchpay-sheet-wrap ${closing ? "closing" : ""}`} role="presentation" onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="bchpay-sheet-backdrop" onClick={close} aria-hidden="true" />
      <div
        ref={sheet}
        className="bchpay-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Pay ${brand.name} with Bitcoin Cash`}
        tabIndex={-1}
        style={drag ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
      >
        <div className="bchpay-sheet-grab" onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd}>
          <span aria-hidden="true" />
        </div>

        <header className="bchpay-sheet-head">
          {brand.logo ? <img src={brand.logo} alt="" className="bchpay-sheet-logo" /> : <BchIcon size={48} />}
          <div className="bchpay-grow">
            <p className="bchpay-title-sm">{brand.name}</p>
            <p className="bchpay-text bchpay-inline">
              <BchIcon size={14} /> Pay with Bitcoin Cash
            </p>
          </div>
          <button type="button" onClick={close} className="bchpay-sheet-x" aria-label="Close">
            ✕
          </button>
        </header>

        {phase === "done" ? (
          <section className="bchpay-step bchpay-pane bchpay-center" aria-live="polite">
            <div className="bchpay-done-mark" aria-hidden="true">
              <DoneTick />
            </div>
            <p className="bchpay-title-lg">Paid</p>
            <p className="bchpay-text">
              {asked} BCH{spending ? ` and ${spending}` : ""}. Thank you!
            </p>
            {earns && (
              <p className="bchpay-reward bchpay-gap">
                <RewardGlyph />
                <span>
                  {earns} {viaWallet ? "on their way to your wallet" : "to claim on your order page"}
                </span>
              </p>
            )}
          </section>
        ) : (
          <>
            {/* The two ways, side by side: connect a wallet (one tap, with tokens), or any wallet (scan or open). */}
            {canConnect && (
              <div className="bchpay-methods" role="tablist" aria-label="How to pay">
                <span className="bchpay-methods-pill" style={{ transform: method === "wallet" ? "translateX(0)" : "translateX(100%)" }} aria-hidden="true" />
                <button type="button" role="tab" aria-selected={method === "wallet"} onClick={() => choose("wallet")} disabled={busy}>
                  Connect wallet
                  <span>One tap · use your tokens</span>
                </button>
                <button type="button" role="tab" aria-selected={method === "any"} onClick={() => choose("any")} disabled={busy}>
                  Any wallet
                  <span>Scan or open a link</span>
                </button>
              </div>
            )}

            {viaWallet ? walletPane() : <AnyWalletPane bch={bch} brand={brand} phone={phone} showQr={showQr} setShowQr={setShowQr} />}

            {/* The order, folded away until asked for; the total; and (connected) the one button. */}
            {(!viaWallet || phase === "review") && (
              <>
                {breakdown && (
                  <div className="bchpay-row stack">
                    <button type="button" onClick={() => setDetails((d) => !d)} className="bchpay-fold" aria-expanded={details}>
                      <span>Order details</span>
                      <span className={`bchpay-chevron ${details ? "open" : ""}`}>⌄</span>
                    </button>
                    <div className={`bchpay-details ${details ? "open" : ""}`}>
                      <div>
                        <BchReceipt breakdown={breakdown} paid={bch.state === "partial" ? bch.paidBch : null} left={bch.state === "partial" ? bch.amountBch : null} money={money} flat />
                      </div>
                    </div>
                  </div>
                )}
                <div className="bchpay-total">
                  <div className="bchpay-total-row">
                    <span className="bchpay-eyebrow">{bch.state === "partial" ? "Left to pay" : `Pay ${brand.name}`}</span>
                    <span className="bchpay-right">
                      <span className="bchpay-total-amount">
                        <RollingAmount value={asked} /> <span className="bchpay-unit">BCH</span>
                      </span>
                      <span className="bchpay-text">
                        {money(usd)}
                        {spending ? ` · plus ${spending}` : ""}
                      </span>
                    </span>
                  </div>
                  {earns && (
                    <p key={earns} className="bchpay-reward bchpay-gap">
                      <RewardGlyph />
                      <span>
                        You&apos;ll earn <b>{earns}</b> back{viaWallet ? ", straight to this wallet" : ": claim them after paying"}
                      </span>
                    </p>
                  )}
                  {viaWallet ? (
                    <>
                      {short && <p className="bchpay-warn bchpay-gap">This wallet has {info?.bch} BCH, a little less than this needs with the network fee. Add some, or choose “Any wallet”.</p>}
                      {error && (
                        <p role="alert" className="bchpay-alert bchpay-gap">
                          {error}
                        </p>
                      )}
                      <button type="button" onClick={pay} disabled={phase !== "review" || !quote || short} className="bchpay-primary bchpay-gap-lg">
                        Pay with <BchIcon size={22} /> {asked} BCH
                      </button>
                      <p className="bchpay-small bchpay-center-text bchpay-gap-sm">
                        You approve it once in {name}, which sends it.{held ? ` Price held ${held}.` : ""}
                      </p>
                    </>
                  ) : (
                    <p className="bchpay-watching bchpay-gap" role="status">
                      <span aria-hidden="true" />
                      Watching for your payment{held ? ` · price held ${held}` : ""}
                    </p>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Any wallet: tokens first if the shopper has some, then the payment by QR code or link (or its payment link to copy: the address with the amount in it). */
function AnyWalletPane({ bch, brand, phone, showQr, setShowQr }: { bch: BchView; brand: BchBrand; phone: boolean; showQr: boolean; setShowQr: (v: boolean) => void }) {
  const [tokens, setTokens] = useState(false);
  const qr = !phone || showQr;
  const tokenName = brand.tokenName ?? brand.name;
  return (
    <section className="bchpay-step bchpay-pane-top">
      {bch.state === "partial" && (
        <p className="bchpay-warn bchpay-gap-b">
          We&apos;ve received {bch.paidBch} BCH. Please send the remaining <strong>{bch.amountBch} BCH</strong>.
        </p>
      )}

      {bch.coupon && (
        <div className="bchpay-tokens-first">
          <button type="button" onClick={() => setTokens((t) => !t)} className="bchpay-fold" aria-expanded={tokens}>
            <span>
              <span className="bchpay-strong bchpay-block">{bch.coupon.stack ? `Have ${tokenName} tokens?` : `Have a ${tokenName} coupon?`}</span>
              <span className="bchpay-text bchpay-block">Send {bch.coupon.stack ? "them" : "it"} first: the amount below updates by itself.</span>
            </span>
            <span className={`bchpay-chevron ${tokens ? "open" : ""}`}>⌄</span>
          </button>
          <div className={`bchpay-details ${tokens ? "open" : ""}`}>
            <div>
              <div className="bchpay-center bchpay-gap">
                {!phone && <QrCode text={bch.coupon.uri} size={164} label="QR code to send your tokens" logo={brand.logo} />}
                <ul className="bchpay-list">
                  {bch.coupon.coupons.map((c) => (
                    <li key={c.label}>
                      <b>{c.label}</b>: {c.off} <span className="bchpay-muted-text">· send {c.send}</span>
                    </li>
                  ))}
                </ul>
                <a href={bch.coupon.uri} className="bchpay-outline">
                  Send {bch.coupon.stack ? "tokens" : "the coupon"} from my wallet app
                </a>
                <div className="bchpay-copy-row">
                  <Address value={bch.coupon.address} />
                  <CopyButton value={bch.coupon.address} label="token address" />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="bchpay-center">
        {qr ? (
          <QrCode text={bch.uri!} size={phone ? 220 : 232} label="QR code with the payment address and amount" logo={brand.logo} listening />
        ) : (
          <a href={bch.uri!} className="bchpay-primary">
            Open in my wallet app <BchIcon size={22} />
          </a>
        )}
        <p className="bchpay-text bchpay-gap-sm">{qr ? "Scan with Selene, Paytaca, Electron Cash or any Bitcoin Cash wallet." : "Selene, Paytaca, Electron Cash or any Bitcoin Cash wallet opens with everything filled in."}</p>
        {phone && (
          <button type="button" onClick={() => setShowQr(!showQr)} className="bchpay-link bchpay-gap-sm">
            {showQr ? "Open in my wallet app instead" : "Show the QR code (wallet on another device)"}
          </button>
        )}
      </div>

      <div className="bchpay-send-box">
        <div className="bchpay-copy-row">
          <div className="bchpay-grow">
            <p className="bchpay-eyebrow">{bch.state === "partial" ? "Send the rest" : "Send exactly"}</p>
            <p className="bchpay-title">
              {bch.amountBch} <span className="bchpay-unit">BCH</span>
            </p>
            <p className="bchpay-eyebrow bchpay-gap-sm">To</p>
            <Address value={bch.address!} />
          </div>
        </div>
        <div className="bchpay-copy-row bchpay-divided">
          <p className="bchpay-text">One link with the address and amount: paste it in any wallet.</p>
          <CopyButton value={bch.uri!} label="payment link" />
        </div>
      </div>
    </section>
  );
}
