/**
 * The storage the checkout needs, kept in memory: fine for trying it out and
 * for tests. In production use your database (docs/integration.md has a SQL
 * schema); the methods below are the whole interface.
 *
 * Payments are plain JSON objects, one per order. Addresses record which of
 * the wallet's receiving addresses (xpub/0/<index>) each order was given:
 *   reserved  an order is showing it
 *   used      something was paid to it: never handed out again
 *   free      its order closed with nothing paid: can be handed out again
 *             once releasedAt is old enough (null: straight away)
 *
 * Meta holds a few named JSON values: the shop token's state (src/token.js),
 * including the registry file whose hash is on chain. Keep it safe.
 *
 * Every method may be async. The claim methods must be atomic: two checkouts
 * at once must never get the same address.
 *
 * `initial` and `onChange` let a wrapper keep it in a file (src/file-store.js).
 */
export function createMemoryStore({ initial = null, onChange = () => {} } = {}) {
  const payments = new Map(initial?.payments ?? []);
  const addresses = new Map(initial?.addresses ?? []); // `${wallet}:${index}` → { wallet, index, address, scripthash, state, orderId, reservedAt, releasedAt }
  const meta = new Map(initial?.meta ?? []);
  const changed = () => onChange({ payments: [...payments], addresses: [...addresses], meta: [...meta] });
  const key = (wallet, index) => `${wallet}:${index}`;
  const clone = (v) => (v === null || v === undefined ? null : structuredClone(v));

  return {
    async getPayment(id) {
      return clone(payments.get(id));
    },
    async putPayment(payment) {
      payments.set(payment.id, clone(payment));
      changed();
    },
    /** Payments worth looking at in the background: not paid yet, or recently closed or paid. */
    async listPayments({ since }) {
      return [...payments.values()].filter((p) => p.createdAt >= since).map(clone);
    },

    /** The lowest-numbered free address released before `reuseBefore` (or never shown), claimed for the order. */
    async claimFreeAddress(wallet, orderId, reuseBefore, at) {
      const free = [...addresses.values()].filter((a) => a.wallet === wallet && a.state === "free" && (a.releasedAt === null || a.releasedAt < reuseBefore)).sort((a, b) => a.index - b.index)[0];
      if (!free) return null;
      const previous = { orderId: free.orderId, releasedAt: free.releasedAt };
      Object.assign(free, { state: "reserved", orderId, reservedAt: at, releasedAt: null });
      changed();
      return { ...clone(free), previous };
    },
    /** The next new address for the wallet, claimed for the order. */
    async claimNewAddress(wallet, orderId, at, derive) {
      const used = [...addresses.values()].filter((a) => a.wallet === wallet).map((a) => a.index);
      const index = used.length ? Math.max(...used) + 1 : 0;
      const a = derive(index);
      addresses.set(key(wallet, index), { wallet, index, address: a.address, scripthash: a.scripthash, state: "reserved", orderId, reservedAt: at, releasedAt: null });
      changed();
      return clone(addresses.get(key(wallet, index)));
    },
    async setAddress(wallet, index, patch) {
      const a = addresses.get(key(wallet, index));
      if (a) Object.assign(a, patch);
      changed();
    },
    /** The order's address goes back to the pool (releasedAt: when; null for "straight away"), unless it was paid to. */
    async releaseAddress(orderId, releasedAt) {
      for (const a of addresses.values()) if (a.orderId === orderId && a.state === "reserved") Object.assign(a, { state: "free", releasedAt });
      changed();
    },
    async markAddressUsed(orderId) {
      for (const a of addresses.values()) if (a.orderId === orderId) a.state = "used";
      changed();
    },
    /** The order an address (by its Electrum scripthash) was last given to. */
    async orderForScripthash(scripthash) {
      const list = [...addresses.values()].filter((a) => a.scripthash === scripthash && a.orderId).sort((a, b) => (b.reservedAt ?? "").localeCompare(a.reservedAt ?? ""));
      return list[0]?.orderId ?? null;
    },
    /** How many addresses were handed out after the last one that was paid (a wallet only looks about 20 ahead). */
    async unusedAhead(wallet) {
      const all = [...addresses.values()].filter((a) => a.wallet === wallet);
      const lastUsed = Math.max(-1, ...all.filter((a) => a.state === "used").map((a) => a.index));
      return all.filter((a) => a.index > lastUsed && a.state !== "used").length;
    },

    /** A named JSON value (null if unset). */
    async getMeta(name) {
      return clone(meta.get(name));
    },
    async putMeta(name, value) {
      meta.set(name, clone(value));
      changed();
    },

    // For tests and debugging.
    _addresses: () => [...addresses.values()].map(clone),
  };
}
