/**
 * US sanctions screening for addresses you pay (sales partners' commissions, docs/commissions.md). The Treasury's
 * OFAC list of Specially Designated Nationals (SDN) includes digital currency addresses ("Digital Currency Address -
 * BCH …"), and a US business must not pay one. The list is downloaded at most once a day (kept through your store,
 * so a failed download keeps the last one), and every Bitcoin Cash address on it is compared by what it pays to (its
 * locking bytecode), so CashAddr and legacy (1…, 3…) forms match.
 *
 *   const sanctions = createSanctions({ getMeta: () => saved, setMeta: (v) => (saved = v) });
 *   await sanctions.refresh();             // daily, e.g. from your background job
 *   createBchCheckout({ commissions: { wallet, isBlocked: sanctions.isBlocked } });
 *
 * It only knows the addresses OFAC has published: also ask your partners to certify they aren't on the list or in an
 * embargoed country.
 */
import { base58AddressToLockingBytecode, binToHex, cashAddressToLockingBytecode } from "@bitauth/libauth";

// The SDN list as CSV: the sanctions list service, and its older address (kept as a fallback).
export const SDN_URLS = ["https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV", "https://www.treasury.gov/ofac/downloads/sdn.csv"];
const DAY = 86_400_000;

/** What an address pays to, as hex, or null (CashAddr with or without its prefix, or legacy Base58). */
export function lockingOf(address) {
  const text = String(address ?? "").trim();
  if (!text) return null;
  const cash = cashAddressToLockingBytecode(text.includes(":") ? text.toLowerCase() : `bitcoincash:${text.toLowerCase()}`);
  if (typeof cash !== "string") return binToHex(cash.bytecode);
  const legacy = base58AddressToLockingBytecode(text);
  return typeof legacy === "string" ? null : binToHex(legacy.bytecode);
}

/** The BCH addresses in the SDN list's text (its remarks: "Digital Currency Address - BCH <address>;"). */
export function bchAddressesIn(text) {
  const found = new Set();
  for (const m of String(text).matchAll(/Digital Currency Address - BCH\s+([A-Za-z0-9:]+)/g)) {
    const lb = lockingOf(m[1]);
    if (lb) found.add(lb);
  }
  return [...found];
}

/** getMeta/setMeta keep the downloaded list ({ at, addresses, source }) wherever you like (a file, your database). */
export function createSanctions({ getMeta = () => null, setMeta = () => {}, fetchImpl = fetch, now = Date.now, log = () => {} } = {}) {
  let blocked = new Set(getMeta()?.addresses ?? []);
  let refreshing = null;

  /** Downloads the list again if it's a day old (or `force`). A failed download keeps the last list. */
  function refresh({ force = false } = {}) {
    const saved = getMeta();
    if (!force && saved?.at && now() - Date.parse(saved.at) < DAY) return Promise.resolve(false);
    refreshing ??= (async () => {
      for (const url of SDN_URLS) {
        try {
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          // A real list is large; anything tiny is an error page, not a list.
          if (text.length < 10_000) throw new Error("not the list");
          const addresses = bchAddressesIn(text);
          blocked = new Set(addresses);
          setMeta({ at: new Date(now()).toISOString(), addresses, source: url });
          return true;
        } catch (e) {
          log(`[sanctions] ${url}: ${e.message}`);
        }
      }
      return false;
    })().finally(() => (refreshing = null));
    return refreshing;
  }

  return {
    refresh,
    /** True if the address is on the US sanctions list. */
    isBlocked: (address) => {
      const lb = lockingOf(address);
      return Boolean(lb && blocked.has(lb));
    },
    status: () => ({ checkedAt: getMeta()?.at ?? null, addresses: blocked.size }),
  };
}
