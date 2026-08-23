"use client";

import { useCallback, useEffect, useState } from "react";

import { useQuery } from "@tanstack/react-query";

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
  /** True once we know the session cannot decode and no granted key is held. */
  needsGrant: boolean;
  granting: boolean;
  grant: () => Promise<void>;
  error: string | null;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A credential that may read PII back, obtained deliberately.
 *
 * Decode is not implied by being able to administer the proxy: it hands back
 * the values the whole system exists to withhold, so it is a grant somebody
 * turns on. The console therefore mints itself a short-lived key with that one
 * permission, on a click, rather than the rule being relaxed for admins.
 */
export const usePiiKey = (accessToken: string | null, userId: string | null): PiiAccess => {
  const [granted, setGranted] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const grant = useCallback(async () => {
    if (!accessToken) return;
    setGranting(true);
    setError(null);
    try {
      const created = await keyCreateCall(accessToken, userId ?? "", {
        key_alias: `${KEY_ALIAS}-${Date.now()}`,
        duration: KEY_DURATION,
        permissions: { allow_pii_decode: true },
      });
      const key = (created as { key?: string }).key;
      if (!key) throw new Error("The proxy returned no key");
      write(key);
      setGranted(key);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setGranting(false);
    }
  }, [accessToken, userId]);

  return {
    key: active,
    canDecode,
    needsGrant: permissions.isSuccess && !canDecode,
    granting,
    grant,
    error,
  };
};
