import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";

/**
 * Reads/writes a fixed set of query parameters (filters live in the URL so reloads, links and the back button keep
 * them). Empty values are removed. `replace` avoids a history entry per keystroke.
 */
export function useUrlParams<K extends string>(keys: readonly K[]) {
  const [params, setParams] = useSearchParams();
  const values = useMemo(() => Object.fromEntries(keys.map((k) => [k, params.get(k) ?? ""])) as Record<K, string>, [params, keys]);
  const update = useCallback(
    (patch: Partial<Record<K, string | null | undefined>>, opts: { replace?: boolean } = {}) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch) as [K, string | null | undefined][]) {
            if (v === null || v === undefined || v === "") next.delete(k);
            else next.set(k, v);
          }
          next.delete("cursor");
          return next;
        },
        { replace: opts.replace },
      ),
    [setParams],
  );
  return [values, update] as const;
}
