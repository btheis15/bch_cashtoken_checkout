import type { BchQuote, BchReward, BchView, BchWalletInfo } from "./types";

/** What the payment screen asks your server. createBchApi() calls the routes in examples/server.mjs. */
export type BchApi = {
  /** The payment as it stands (createBchCheckout().check(id), throttled on your server). */
  status(): Promise<BchView>;
  /** "Get a new price" (renew). */
  renew(): Promise<BchView>;
  /** Connect wallet: what the wallet holds (walletInfo), a quote (walletQuote), the transaction to sign (walletBuild), the signed one (walletSubmit). */
  wallet(address: string): Promise<BchWalletInfo>;
  quote(input: { category: string; amount: string }): Promise<BchQuote>;
  build(input: { address: string; category: string; amount: string }): Promise<{ request: unknown; amountBch: string; feeBch: string }>;
  submit(hex: string): Promise<{ ok: boolean; txid: string }>;
  /** A reward claimed to the shopper's wallet (claimReward). */
  claim(address: string): Promise<{ reward: BchReward | null }>;
};

/** The API for one order, at `${base}/${orderId}` (POST JSON; errors come back as { error }). */
export function createBchApi(orderId: string, base = "/api/orders"): BchApi {
  const at = `${base}/${encodeURIComponent(orderId)}`;
  async function call<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${at}${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" } : { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? "Something went wrong. Please try again.");
    return data;
  }
  return {
    status: () => call(""),
    renew: () => call("/renew", {}),
    wallet: (address) => call("/wallet", { address }),
    quote: (input) => call("/quote", input),
    build: (input) => call("/build", input),
    submit: (hex) => call("/submit", { hex }),
    claim: (address) => call("/claim", { address }),
  };
}
