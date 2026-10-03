import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { BchPay } from "../../examples/react/BchPay";
import { ReceiptChoice } from "../../examples/react/ReceiptToken";
import { createDemoShop, USD_PER_BCH } from "./shop.js";

type Shop = Awaited<ReturnType<typeof createDemoShop>>;

// A few pieces from Om Threads Boutique (omthreadsboutique.vercel.app), as sample products.
const PRODUCTS = [
  { id: "om-namah-shivaya", title: "Om Namah Shivaya Prayer Shawl", note: "Block-printed cotton · Varanasi", cents: 3800, colors: ["#d9861c", "#8e2a18"] },
  { id: "oswal-lohi", title: "Punjabi Oswal Lohi Wool Shawl", note: "Wool-touch lohi · Punjab", cents: 4500, colors: ["#6b4a3a", "#c8b49a"] },
  { id: "banarasi-stole", title: "Saffron Banarasi Silk Stole", note: "Silk blend with zari · on sale", cents: 4800, was: 5800, colors: ["#d18f1c", "#7a3d0c"] },
];
const SHIPPING_CENTS = 600;
const FREE_OVER = 7500;
const TAX = 0.0825; // Lake Villa, Illinois
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

let shopP: Promise<Shop> | null = null;
const getShop = () => (shopP ??= createDemoShop());

export function App() {
  const [shop, setShop] = useState<Shop | null>(null);
  useEffect(() => {
    getShop().then(setShop);
  }, []);
  return (
    <div className="demo">
      <Hero />
      {shop ? <Demo shop={shop} /> : <p className="demo-loading">Setting up the shop: minting its receipt collection on the simulated network…</p>}
      <Why />
      <footer className="demo-footer">
        <p>
          <a href="https://github.com/btheis15/bch_cashtoken_checkout">github.com/btheis15/bch_cashtoken_checkout</a> · MIT · Sample shop:{" "}
          <a href="https://omthreadsboutique.vercel.app">Om Threads Boutique</a>, Lake Villa, Illinois
        </p>
      </footer>
    </div>
  );
}

function Hero() {
  return (
    <header className="demo-hero">
      <p className="demo-eyebrow">bch_cashtoken_checkout · live demo</p>
      <h1>Accept Bitcoin Cash on your own site, straight into your own wallet.</h1>
      <p className="demo-lead">
        No payment company, no account, no fees. Zero-conf with double-spend proofs, CashTokens coupons, rewards and receipts, Connect wallet, and
        sales partners paid in the same transaction. This page runs the kit's real code and payment screen in your browser, against a simulated
        Bitcoin Cash network you control from the right-hand panel.
      </p>
      <ol className="demo-steps">
        <li>Pick some pieces from Om Threads Boutique (a real shop running this code) and press Pay with Bitcoin Cash.</li>
        <li>
          Pay: <b>Connect wallet</b> in the pay sheet (a simulated wallet with 1 BCH and 5 OMT coupon tokens), or press <b>Any wallet pays the QR code</b>.
        </li>
        <li>Watch the right-hand panel: every transaction's outputs, what the shop sees, and the engine's own log.</li>
      </ol>
    </header>
  );
}

function Demo({ shop }: { shop: Shop }) {
  useSyncExternalStore(shop.subscribe, shop.snapshot);
  const [qty, setQty] = useState<Record<string, number>>({ "om-namah-shivaya": 1, "banarasi-stole": 1 });
  const [viaPartner, setViaPartner] = useState(true);
  const [receipt, setReceipt] = useState<"email" | "token" | "both">("both");
  const [order, setOrder] = useState<{ id: string; view: unknown } | null>(null);
  const [n, setN] = useState(1042);
  const [error, setError] = useState("");

  const lines = PRODUCTS.filter((p) => qty[p.id] > 0).map((p) => ({ ...p, qty: qty[p.id] }));
  const subtotal = lines.reduce((s, l) => s + l.cents * l.qty, 0);
  const shipping = subtotal >= FREE_OVER || !subtotal ? 0 : SHIPPING_CENTS;
  const tax = Math.round(subtotal * TAX);

  async function checkout() {
    setError("");
    const id = `OT-${n}`;
    try {
      const view = await shop.bch.start({
        id,
        label: `Om Threads order ${id}`,
        number: n,
        subtotalCents: subtotal,
        shippingCents: shipping,
        taxCents: tax,
        itemCount: lines.reduce((s, l) => s + l.qty, 0),
        shippingLabel: shipping ? "Standard shipping (USPS)" : "Free shipping",
        items: lines.map((l) => ({ title: l.title, option: null, qty: l.qty, unitCents: l.cents })),
        receipt,
        // Through Priya's link (?s=priya): she earns 5% of the items, paid when the shop is paid.
        partner: viaPartner ? { id: shop.partner.id, address: shop.partner.address, ratePercent: 5 } : null,
      });
      setOrder({ id, view });
      setN(n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main className="demo-grid">
      <section className="demo-shop">
        <div className="demo-shop-head">
          <img src={`${import.meta.env.BASE_URL}om-threads.png`} alt="" width={44} height={44} />
          <div>
            <p className="demo-shop-name">Om Threads Boutique</p>
            <p className="demo-muted">Heirloom shawls &amp; stoles from North India · sample shop</p>
          </div>
        </div>
        {order ? (
          <div>
            <PayScreen shop={shop} id={order.id} initial={order.view} />
            <button type="button" className="demo-link" onClick={() => setOrder(null)}>
              ← Start another order
            </button>
          </div>
        ) : (
          <div className="demo-cart">
            {PRODUCTS.map((p) => (
              <div key={p.id} className="demo-product">
                <span className="demo-swatch" style={{ background: `repeating-linear-gradient(135deg, ${p.colors[0]} 0 10px, ${p.colors[1]} 10px 13px)` }} />
                <div className="demo-product-text">
                  <p className="demo-strong">{p.title}</p>
                  <p className="demo-muted">
                    {p.note} · {p.was ? <s>{money(p.was)}</s> : null} {money(p.cents)}
                  </p>
                </div>
                <div className="demo-qty">
                  <button type="button" aria-label="One fewer" onClick={() => setQty({ ...qty, [p.id]: Math.max(0, (qty[p.id] ?? 0) - 1) })}>
                    −
                  </button>
                  <span>{qty[p.id] ?? 0}</span>
                  <button type="button" aria-label="One more" onClick={() => setQty({ ...qty, [p.id]: (qty[p.id] ?? 0) + 1 })}>
                    +
                  </button>
                </div>
              </div>
            ))}
            <dl className="demo-totals">
              <dt>Items</dt>
              <dd>{money(subtotal)}</dd>
              <dt>Shipping</dt>
              <dd>{shipping ? money(shipping) : "Free"}</dd>
              <dt>Sales tax (8.25%)</dt>
              <dd>{money(tax)}</dd>
              <dt className="demo-strong">Total</dt>
              <dd className="demo-strong">{money(subtotal + shipping + tax)}</dd>
            </dl>
            <label className="demo-toggle">
              <input type="checkbox" checked={viaPartner} onChange={(e) => setViaPartner(e.target.checked)} />
              <span>
                Arrived through a sales partner&apos;s link (<code>?s=priya</code>): Priya earns 5% of the items, never shipping or tax.
              </span>
            </label>
            <p className="demo-label">Your receipt</p>
            <ReceiptChoice value={receipt} onChange={setReceipt} tokenName="Om Receipt" />
            {error && <p className="demo-error">{error}</p>}
            <button type="button" className="demo-primary" disabled={!subtotal} onClick={checkout}>
              Pay with Bitcoin Cash · {money(subtotal + shipping + tax)}
            </button>
            <p className="demo-muted demo-small">Simulated price: ${USD_PER_BCH} per BCH (a real shop takes the middle of several exchanges, and only when two agree).</p>
          </div>
        )}
      </section>
      <BehindTheScenes shop={shop} orderId={order?.id ?? null} />
    </main>
  );
}

function PayScreen({ shop, id, initial }: { shop: Shop; id: string; initial: unknown }) {
  const api = useMemo(() => shop.apiFor(id), [shop, id]);
  return (
    <BchPay
      key={id}
      api={api as never}
      initial={initial as never}
      brand={{ name: "Om Threads Boutique", logo: `${import.meta.env.BASE_URL}om-threads.png`, contactUrl: "https://omthreadsboutique.vercel.app/contact", tokenName: "Om Threads" }}
      wc={shop.wc as never}
      autoOpen={false}
      className="demo-pay"
      style={{ "--bchpay-accent": "#b8873a", "--bchpay-accent-light": "#e3bf80", "--bchpay-accent-2": "#a52b57", "--bchpay-ink": "#233142", "--bchpay-font-display": "Georgia, serif" } as React.CSSProperties}
    />
  );
}

function BehindTheScenes({ shop, orderId }: { shop: Shop; orderId: string | null }) {
  const version = useSyncExternalStore(shop.subscribe, shop.snapshot);
  const [busy, setBusy] = useState("");
  const [merchant, setMerchant] = useState<Record<string, unknown> | null>(null);
  // Read again every second too: the engine saves a payment just after it reports on it.
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setBeat((b) => b + 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    let live = true;
    if (!orderId) return void setMerchant(null);
    (async () => {
      const p = await shop.store.getPayment(orderId);
      const c = await shop.bch.commission(orderId);
      if (live) setMerchant({ p, c });
    })();
    return () => {
      live = false;
    };
  }, [shop, orderId, version, beat]);

  const press = (label: string, fn: () => Promise<unknown> | unknown) => async () => {
    setBusy(label);
    try {
      await fn();
    } finally {
      setTimeout(() => setBusy(""), 400);
    }
  };
  const p = merchant?.p as Record<string, any> | undefined;
  const c = merchant?.c as Record<string, any> | null | undefined;
  const can = Boolean(orderId && p && p.status === "awaiting");

  return (
    <aside className="demo-side">
      <section className="demo-card">
        <h2>Simulated Bitcoin Cash network</h2>
        <p className="demo-muted demo-small">Real transactions, built and signed with libauth; only the network is pretend. Start an order first.</p>
        <div className="demo-buttons">
          <button type="button" disabled={!can} onClick={press("pay", () => shop.network.payFromAnyWallet(orderId!))}>
            Any wallet pays the QR code
          </button>
          <button type="button" disabled={!can} onClick={press("coupons", () => shop.network.sendCoupons(orderId!, 3))}>
            Send 3 OMT coupon tokens first
          </button>
          <button type="button" disabled={!can} onClick={press("part", () => shop.network.payFromAnyWallet(orderId!, { part: true }))}>
            Pay only half
          </button>
          <button type="button" disabled={!can} onClick={press("ds", () => shop.network.doubleSpendAttempt(orderId!))}>
            Pay, with a double-spend attempt
          </button>
          <button type="button" disabled={!can} onClick={press("script", () => shop.network.payFromAnyWallet(orderId!, { script: true }))}>
            A multisig wallet pays
          </button>
          <button type="button" onClick={press("block", () => shop.network.mineBlock())}>
            Mine a block
          </button>
        </div>
        {busy && <p className="demo-muted demo-small">Sent to the network…</p>}
      </section>

      <section className="demo-card">
        <h2>What the shop sees</h2>
        {!p ? (
          <p className="demo-muted">No order yet.</p>
        ) : (
          <dl className="demo-facts">
            <dt>Order</dt>
            <dd>
              {p.id} · {p.status === "paid" ? <b className="demo-ok">paid</b> : p.held ? <b className="demo-warn">held: double-spend proof</b> : p.status}
            </dd>
            <dt>Paid to</dt>
            <dd className="demo-mono">{p.address}</dd>
            <dt>Received</dt>
            <dd>
              {(p.receivedSats / 1e8).toString()} BCH{p.confirmations >= 1 ? " · in a block" : p.status === "paid" ? " · zero-conf" : ""}
            </dd>
            {p.discountCents ? (
              <>
                <dt>Coupon</dt>
                <dd>
                  {p.coupon?.label}: −{money(p.discountCents)}
                </dd>
              </>
            ) : null}
            <dt>Total</dt>
            <dd>{money(p.totalCents)}</dd>
            {c ? (
              <>
                <dt>Partner (5%)</dt>
                <dd>
                  {c.state === "unpaid"
                    ? "earned once it's paid"
                    : `−${money(c.cents)} of ${money(c.baseCents)} in items · ${c.how === "split" ? "paid in the shopper's own transaction" : c.state === "sent" ? "sent from the hot wallet" : c.waiting ?? c.state}`}
                </dd>
                {c.state !== "unpaid" && (
                  <>
                    <dt>Shop's share</dt>
                    <dd>
                      <b>{money(c.yourCents)}</b>
                    </dd>
                  </>
                )}
              </>
            ) : null}
            {p.reward ? (
              <>
                <dt>Reward</dt>
                <dd>
                  {p.reward.amount} OMT · {p.reward.state}
                </dd>
              </>
            ) : null}
            {p.receipt ? (
              <>
                <dt>Receipt</dt>
                <dd>Om Receipt NFT · {p.receipt.state}</dd>
              </>
            ) : null}
            {(p.problems ?? []).length ? (
              <>
                <dt>Look</dt>
                <dd className="demo-warn">{p.problems.map((x: { message: string }) => x.message).join(" ")}</dd>
              </>
            ) : null}
          </dl>
        )}
      </section>

      <section className="demo-card">
        <h2>Transactions</h2>
        {shop.feed.txs.length ? (
          <ul className="demo-txs">
            {shop.feed.txs.slice(0, 12).map((t) => (
              <li key={t.txid}>
                <p className="demo-strong">{t.label}</p>
                <p className="demo-muted demo-small demo-mono">
                  {time(t.at)} · {t.txid.slice(0, 16)}…
                </p>
                <ul>
                  {t.outputs.map((o, i) => (
                    <li key={i} className={o.to.startsWith("Sales partner") ? "to-partner" : o.to.startsWith("Shop's wallet") ? "to-shop" : ""}>
                      <span>{o.to}</span>
                      <span className="demo-mono">
                        {o.token ? (o.token.nft ? "NFT receipt" : `${o.token.amount} ${o.token.omt ? "OMT" : "tokens"}`) : `${o.bch} BCH`}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <p className="demo-muted">None yet.</p>
        )}
      </section>

      <section className="demo-card">
        <h2>The engine's log</h2>
        <ul className="demo-log">
          {shop.feed.events.slice(0, 30).map((e, i) => (
            <li key={i} className={e.problem ? "problem" : ""}>
              <span className="demo-muted demo-mono">{time(e.at)}</span> {e.message}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

function Why() {
  const points = [
    ["No processor in the middle", "Your server gets your wallet's xPub (it can list addresses, never spend). Each order gets its own address in your wallet. Nothing on the server can move the takings."],
    ["Zero-conf, done properly", "A payment counts seconds after it reaches the network, once no double-spend proof turns up (the DSProof spec's wait). With a proof, it's held for a block. Script and multisig payments, which proofs can't cover, are flagged."],
    ["Two exchanges must agree", "The price is the middle of Coinbase, Kraken, Bitstamp and CoinGecko, and only when two agree within 1.5%. Held 30 minutes."],
    ["CashTokens that do something", "Your own token as coupons (each worth some BCH off, stacking), rewards sent back to the wallet that paid, and receipts as one-of-a-kind NFTs with BCMR metadata, minted from your server."],
    ["Connect wallet, one transaction", "Over BCH WalletConnect (Cashonize, Paytaca, Zapit): the BCH, the coupon tokens and a sales partner's share, all in one transaction the shopper signs."],
    ["Sales partners, paid at once", "Anyone can sell for you: their share of the items goes to them in the shopper's own transaction, or from the hot wallet the moment you're paid. Capped per partner if you like; addresses checked against the US sanctions list."],
  ];
  return (
    <section className="demo-why">
      <h2>Why it's built this way</h2>
      <div className="demo-why-grid">
        {points.map(([t, d]) => (
          <div key={t}>
            <p className="demo-strong">{t}</p>
            <p className="demo-muted">{d}</p>
          </div>
        ))}
      </div>
      <p className="demo-muted">
        It's plain JavaScript on Node (libauth and @electrum-cash/network), a React payment screen with one stylesheet, and 34 tests against a stand-in
        network that builds real transactions. Fork it, and make the payment screen look like your site.
      </p>
    </section>
  );
}
