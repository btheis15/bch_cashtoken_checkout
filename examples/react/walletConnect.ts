"use client";

import type Client from "@walletconnect/sign-client";
import type { SessionTypes } from "@walletconnect/types";

/**
 * Bitcoin Cash wallets over WalletConnect (the BCH spec, github.com/mainnet-pat/wc2-bch-bcr), as
 * Cashonize, Paytaca and Zapit speak it. The client is loaded only when a shopper connects (or has
 * connected before), so the page doesn't carry it otherwise.
 *
 *   npm i @walletconnect/sign-client @walletconnect/types
 *   const wc = createBchWalletConnect({ projectId, name: "Example Shop", icon: "/icon.png" });
 *
 * A project ID is free at dashboard.reown.com (WalletConnect's dashboard): add your site's domain to it.
 */
export type BchWalletConnectConfig = {
  projectId: string;
  /** Your shop's name and a line about it, as the wallet shows them when asked to connect. */
  name: string;
  description?: string;
  /** A square icon (absolute, or a path on your site). */
  icon?: string;
  /** localStorage key that remembers a connected wallet. */
  storageKey?: string;
};

export type WalletSession = {
  topic: string;
  pairingTopic: string;
  address: string;
  /** The wallet's own name ("Cashonize", "Paytaca"…), from the connection. */
  name: string;
  canCancel: boolean;
};

export type BchWalletConnect = ReturnType<typeof createBchWalletConnect>;

const CHAIN = "bch:bitcoincash";
const NAMESPACES = {
  bch: { chains: [CHAIN], methods: ["bch_getAddresses", "bch_signTransaction", "bch_signMessage"], events: ["addressesChanged"] },
};
// Lets the page withdraw a payment the shopper hasn't approved yet (Cashonize closes its dialog).
const OPTIONAL = { bch: { chains: [CHAIN], methods: ["bch_cancelPendingRequests"], events: [] } };
const CANCEL = "bch_cancelPendingRequests";

export class Cancelled extends Error {}

/** True for "the shopper said no in their wallet" (as opposed to something going wrong). */
export const declined = (e: unknown) => /reject|declin|denied|cancel/i.test(e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e));

export function createBchWalletConnect(config: BchWalletConnectConfig) {
  const remember = config.storageKey ?? "bchpay-wallet";
  let clientP: Promise<Client> | null = null;
  function client() {
    clientP ??= import("@walletconnect/sign-client").then(({ SignClient }) =>
      SignClient.init({
        projectId: config.projectId,
        metadata: {
          name: config.name,
          description: config.description ?? `Pay ${config.name} with Bitcoin Cash.`,
          url: window.location.origin,
          icons: config.icon ? [new URL(config.icon, window.location.origin).href] : [],
        },
      }),
    );
    clientP.catch(() => (clientP = null));
    return clientP;
  }

  const accountAddress = (s: SessionTypes.Struct) => s.namespaces.bch?.accounts?.[0]?.slice(4) ?? "";
  async function describe(c: Client, s: SessionTypes.Struct): Promise<WalletSession> {
    let address = "";
    try {
      const r = (await c.request({ chainId: CHAIN, topic: s.topic, request: { method: "bch_getAddresses", params: {} } })) as string[];
      address = r?.[0] ?? "";
    } catch {
      /* the session's own account says it too */
    }
    return { topic: s.topic, pairingTopic: s.pairingTopic, address: address || accountAddress(s), name: s.peer.metadata?.name || "your wallet", canCancel: Boolean(s.namespaces.bch?.methods?.includes(CANCEL)) };
  }

  const remembered = () => {
    try {
      return localStorage.getItem(remember) === "1";
    } catch {
      return false;
    }
  };
  const setRemembered = (on: boolean) => {
    try {
      if (on) localStorage.setItem(remember, "1");
      else localStorage.removeItem(remember);
    } catch {
      /* private browsing: it just isn't remembered */
    }
  };

  return {
    enabled: Boolean(config.projectId),

    /** The wallet connected on an earlier visit, if its session is still open. */
    async resume(): Promise<WalletSession | null> {
      if (!config.projectId || !remembered()) return null;
      const c = await client();
      const s = c.session.getAll().find((x) => x.namespaces.bch && x.expiry * 1000 > Date.now());
      if (!s) {
        setRemembered(false);
        return null;
      }
      return describe(c, s);
    },

    /** Starts a connection: the wc: link (a QR code, or open in the wallet app on a phone), and the wallet once approved there. */
    async start(): Promise<{ uri: string; connected: Promise<WalletSession> }> {
      const c = await client();
      const { uri, approval } = await c.connect({ requiredNamespaces: NAMESPACES, optionalNamespaces: OPTIONAL });
      if (!uri) throw new Error("Couldn't start a connection.");
      return {
        uri,
        connected: approval().then((s) => {
          setRemembered(true);
          return describe(c, s);
        }),
      };
    },

    /**
     * Opens the connected wallet app on a phone, straight to the waiting request (the WalletConnect
     * convention: a wc: link with a requestId is a request on an existing session, not a new pairing).
     */
    appLink: (w: WalletSession) => `wc:${w.pairingTopic}@2?requestId=1&sessionTopic=${w.topic}`,

    async disconnect(w: WalletSession) {
      setRemembered(false);
      try {
        const c = await client();
        await c.disconnect({ topic: w.topic, reason: { code: 6000, message: "User disconnected." } });
      } catch {
        /* already gone */
      }
    },

    /**
     * Asks the wallet to approve the payment your server built; its signed transaction (hex). The wallet sends
     * it to the network itself once approved. Aborting withdraws the request (if the wallet allows it).
     */
    async sign(w: WalletSession, request: unknown, signal?: AbortSignal): Promise<string> {
      const c = await client();
      const asked = c.request({ chainId: CHAIN, topic: w.topic, request: { method: "bch_signTransaction", params: request } }) as Promise<{ signedTransaction?: string }>;
      const stopped = new Promise<never>((_, reject) => {
        if (signal?.aborted) reject(new Cancelled());
        signal?.addEventListener("abort", () => {
          if (w.canCancel) void c.request({ chainId: CHAIN, topic: w.topic, request: { method: CANCEL, params: {} } }).catch(() => {});
          reject(new Cancelled());
        });
      });
      const r = await Promise.race([asked, stopped]);
      if (!r?.signedTransaction) throw new Error("The wallet didn't approve the payment.");
      return r.signedTransaction;
    },
  };
}
