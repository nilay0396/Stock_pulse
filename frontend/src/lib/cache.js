/**
 * Ultra-light in-memory SWR-style cache with sessionStorage persistence.
 *
 * Every call to `useCached(key, fetcher)`:
 *  - Returns the cached payload synchronously on re-mount (no loading flash).
 *  - Fires `fetcher()` in the background.
 *  - Re-renders with the fresh payload when it lands.
 *
 * Cache is persisted to sessionStorage so even a full page reload is instant —
 * the tab-scoped cache survives until the user closes the tab. We intentionally
 * do NOT use localStorage so stale data doesn't outlive the session.
 */
import { useEffect, useRef, useState } from "react";

const SS_KEY = "mp_cache_v1";
const MAX_BYTES = 900 * 1024;   // keep sessionStorage footprint under ~900 KB

// Hydrate from sessionStorage on module load (tab-scoped).
function hydrate() {
  try {
    const raw = typeof window !== "undefined" ? sessionStorage.getItem(SS_KEY) : null;
    if (!raw) return new Map();
    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}
const store = hydrate();       // key -> { data, ts }
const inflight = new Map();    // key -> Promise (dedupe concurrent requests)

let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const obj = Object.fromEntries(store);
      const s = JSON.stringify(obj);
      if (s.length > MAX_BYTES) {
        // Evict oldest entries until under budget.
        const entries = [...store.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
        while (JSON.stringify(Object.fromEntries(store)).length > MAX_BYTES && entries.length) {
          const [k] = entries.shift();
          store.delete(k);
        }
      }
      sessionStorage.setItem(SS_KEY, JSON.stringify(Object.fromEntries(store)));
    } catch (err) { console.debug("[cache] sessionStorage persist failed", err); }
  }, 150);
}

export function peek(key) {
  const v = store.get(key);
  return v ? v.data : undefined;
}

export function invalidate(key) {
  store.delete(key);
  schedulePersist();
}

export function invalidateAll() {
  store.clear();
  schedulePersist();
}

export function set(key, data) {
  store.set(key, { data, ts: Date.now() });
  schedulePersist();
}

/**
 * @param {string} key     Unique cache key (e.g. "/ideas?limit=8").
 * @param {() => Promise<any>} fetcher Async fn returning fresh data.
 * @param {{ enabled?: boolean }} [opts]
 */
export function useCached(key, fetcher, opts = {}) {
  const enabled = opts.enabled !== false;
  const cached = enabled ? peek(key) : undefined;
  const [data, setData] = useState(cached);
  // "loading" is only true on the very first fetch when no cache exists.
  const [loading, setLoading] = useState(enabled && cached === undefined);
  const [error, setError] = useState(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const run = async () => {
      try {
        let promise = inflight.get(key);
        if (!promise) {
          promise = fetcherRef.current();
          inflight.set(key, promise);
        }
        const fresh = await promise;
        if (cancelled) return;
        set(key, fresh);
        setData(fresh);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        inflight.delete(key);
        if (!cancelled) setLoading(false);
      }
    };
    run();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  const refetch = async () => {
    setLoading(true);
    try {
      const fresh = await fetcherRef.current();
      set(key, fresh);
      setData(fresh);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  return { data, loading, error, refetch, setData };
}
