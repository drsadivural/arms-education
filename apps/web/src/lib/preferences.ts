import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { Me } from "@arms/contracts";
import { api } from "./api";
import { useTheme, type ThemePreference } from "./theme";

export const meQueryKey = ["me"] as const;

export function useMe() {
  return useQuery({ queryKey: meQueryKey, queryFn: () => api.get<{ data: Me; checked_at: string }>("/me") });
}

/** Saves theme/notification preferences to the server (PATCH /me/preferences with If-Match). */
export function useSavePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { theme: ThemePreference; notifications_enabled: boolean }) => {
      const me = await qc.ensureQueryData({ queryKey: meQueryKey, queryFn: () => api.get<{ data: Me; checked_at: string }>("/me") });
      return api.patch("/me/preferences", input, { ifMatch: me.data.preferences.row_version });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: meQueryKey }),
  });
}

/** Applies the server-side theme once after sign-in so the preference follows the user across devices. */
export function ThemeSync() {
  const me = useMe();
  const { setPreference } = useTheme();
  const applied = useRef(false);
  useEffect(() => {
    if (!applied.current && me.data) {
      applied.current = true;
      if (me.data.data.preferences.row_version > 0) setPreference(me.data.data.preferences.theme);
    }
  }, [me.data, setPreference]);
  return null;
}
