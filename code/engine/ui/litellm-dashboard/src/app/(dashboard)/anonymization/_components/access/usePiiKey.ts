"use client";

import { useCallback, useEffect, useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";

import { keyCreateCall, piiPermissionsCall } from "@/components/networking";

const STORAGE_KEY = "anonymice:pii-decode-key";
export const KEY_ALIAS = "anonymice-pii-console";
export const KEY_DURATION = "24h";

const read = (): string | null => {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const write = (key: string): void => {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    // The key still works for this render; it just will not survive a reload.
  }
};

export interface PiiAccess {
  /** The credential PII calls should use. Falls back to the session token. */
  key: string | null;
  canDecode: boolean;
  /** True once the console tried to grant itself decode and could not. */
  needsGrant: boolean;
  granting: boolean;
  grant: () => Promise<void>;
  error: string | null;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A credential that may read PII back.
 *
 * Decode is not implied by being able to administer the proxy: it hands back
 * the values the whole system exists to withhold, so it is its own grant. The
 * console therefore mints itself a key carrying that one permission and
 * nothing else, expiring in a day, held only for this browser tab. It does so
 * on load, because a console whose whole purpose is showing the round trip is
 * useless without it, and every decode it then performs is recorded in the
 * activity log.
 */
export const usePiiKey = (accessToken: string | null, userId: string | null): PiiAccess => {
  const [granted, setGranted] = useState<string | null>(null);

  useEffect(() => {
    const stored = read();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading a browser store on mount cannot happen during render without breaking prerendering
    if (stored) setGranted(stored);
  }, []);

  const active = granted ?? accessToken;

  const permissions = useQuery({
    queryKey: ["pii-permissions", active],
    queryFn: () => piiPermissionsCall(active as string),
    enabled: active !== null,
    retry: false,
  });

  const canDecode = permissions.data?.can_decode === true || permissions.data?.can_decode_any === true;

  const mint = useMutation({
    mutationFn: async (): Promise<string> => {
      const created = await keyCreateCall(accessToken ?? "", userId ?? "", {
        key_alias: `${KEY_ALIAS}-${Date.now()}`,
        duration: KEY_DURATION,
        permissions: { allow_pii_decode: true },
      });
      const key = (created as { key?: string } | null)?.key;
      if (!key) throw new Error("The proxy returned no key");
      return key;
    },
    onSuccess: (key: string) => {
      write(key);
      setGranted(key);
    },
    retry: false,
  });

  const { mutate, mutateAsync, status } = mint;

  useEffect(() => {
    if (accessToken === null) return;
    if (!permissions.isSuccess || canDecode) return;
    if (status !== "idle") return;
    mutate();
  }, [accessToken, permissions.isSuccess, canDecode, status, mutate]);

  const grant = useCallback(async (): Promise<void> => {
    try {
      await mutateAsync();
    } catch {
      // The failure is already reported through `error`.
    }
  }, [mutateAsync]);

  return {
    key: active,
    canDecode,
    needsGrant: permissions.isSuccess && !canDecode && (status === "error" || status === "success"),
    granting: status === "pending",
    grant,
    error: mint.error === null ? null : message(mint.error),
  };
};
