"use client";

import React, { useEffect, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { CheckCircle2, ExternalLink, LogIn, LogOut } from "lucide-react";

import {
  chatgptLoginPollCall,
  chatgptLoginStartCall,
  chatgptLoginStatusCall,
  chatgptSignOutCall,
  type ChatgptLoginStart,
  type ChatgptLoginStatus,
} from "@/components/networking";
import { Button } from "@/components/ui/button";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";
import { toast } from "@/lib/toast";

/** The device code is valid for fifteen minutes; stop asking after that. */
const DEADLINE_MS = 15 * 60 * 1000;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface ChatgptSignInProps {
  accessToken: string | null;
}

/**
 * Sign in to a ChatGPT subscription without leaving the browser.
 *
 * The device-code flow needs a person to open a page and type a code, so the
 * waiting happens here rather than inside a blocked request on the proxy. The
 * code is displayed rather than linked through, because a device code that
 * arrives already filled in is exactly the shape of the phishing this flow is
 * otherwise vulnerable to.
 */
const ChatgptSignIn: React.FC<ChatgptSignInProps> = ({ accessToken }) => {
  const [pending, setPending] = useState<ChatgptLoginStart | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);

  const query = useQuery<ChatgptLoginStatus>({
    queryKey: ["chatgpt-login", accessToken],
    queryFn: () => chatgptLoginStatusCall(accessToken as string),
    enabled: accessToken !== null,
    retry: false,
  });
  const status = query.data ?? null;

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  const waitForApproval = async (started: ChatgptLoginStart) => {
    const deadline = Date.now() + DEADLINE_MS;
    while (Date.now() < deadline && !cancelled.current) {
      await new Promise((resolve) => setTimeout(resolve, started.interval_seconds * 1000));
      const poll = await chatgptLoginPollCall(accessToken!, started.device_auth_id, started.user_code);
      if (poll.status === "complete") return true;
    }
    return false;
  };

  const onSignIn = async () => {
    if (!accessToken) return;
    setBusy(true);
    try {
      const started = await chatgptLoginStartCall(accessToken);
      setPending(started);
      const approved = await waitForApproval(started);
      if (approved) {
        toast.success("Signed in to ChatGPT");
        await query.refetch();
      } else {
        toast.error("The code expired before it was approved. Start again.");
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(null);
      setBusy(false);
    }
  };

  const onSignOut = async () => {
    if (!accessToken) return;
    setBusy(true);
    try {
      await chatgptSignOutCall(accessToken);
      await query.refetch();
      toast.success("Signed out of ChatGPT");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (status === null) return null;

  return (
    <div className="mb-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            ChatGPT subscription
            {status.signed_in && <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {status.signed_in
              ? `Signed in${status.account_id ? ` as ${status.account_id}` : ""}. Models prefixed chatgpt/ use this instead of an API key.`
              : "Sign in once and the chatgpt/ models work without an API key. The credential stays on the proxy."}
          </p>
        </div>

        {status.signed_in ? (
          <Button variant="secondary" onClick={onSignOut} disabled={busy}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        ) : (
          <Button onClick={onSignIn} disabled={busy || !accessToken}>
            {busy ? <UiLoadingSpinner className="mr-2 h-4 w-4" /> : <LogIn className="mr-2 h-4 w-4" />}
            {busy ? "Waiting for approval" : "Sign in with ChatGPT"}
          </Button>
        )}
      </div>

      {pending && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded border border-border bg-muted p-3">
          <ol className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
            <li>
              1. Open{" "}
              <a
                href={pending.verification_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-foreground underline"
              >
                {pending.verification_url}
                <ExternalLink className="h-3 w-3" />
              </a>
            </li>
            <li>2. Enter the code below, then approve</li>
          </ol>
          <code className="rounded bg-card px-3 py-1.5 font-mono text-lg font-semibold tracking-widest text-foreground ring-1 ring-border">
            {pending.user_code}
          </code>
        </div>
      )}

      {pending && (
        <p className="mt-2 text-xs text-muted-foreground">
          Device codes are a common phishing target. Only enter this one because you just asked for it.
        </p>
      )}
    </div>
  );
};

export default ChatgptSignIn;
