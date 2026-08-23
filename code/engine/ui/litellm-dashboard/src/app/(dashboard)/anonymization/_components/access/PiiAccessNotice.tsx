import React from "react";

import { KeyRound, ShieldAlert } from "lucide-react";

import { KEY_DURATION, type PiiAccess } from "./usePiiKey";

import { Button } from "@/components/ui/button";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";

interface PiiAccessNoticeProps {
  access: PiiAccess;
}

/**
 * Says why decode is refused, and offers the one deliberate step that fixes it.
 *
 * The refusal is the design working: administering the proxy does not imply
 * permission to read PII back out of the vault. So the console asks for that
 * permission in its own right rather than the rule being widened for it.
 */
const PiiAccessNotice: React.FC<PiiAccessNoticeProps> = ({ access }) => {
  if (!access.needsGrant) return null;

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/50">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
          This session cannot decode
        </p>
        <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
          Decode returns real values, so it needs the <code className="font-mono">allow_pii_decode</code> grant rather
          than being implied by administering the proxy. Detect and encode work without it. Granting mints a key that
          carries only that permission and expires in {KEY_DURATION}; it is held for this browser tab.
        </p>
        {access.error && <p className="mt-1 text-xs text-rose-700 dark:text-rose-300">{access.error}</p>}
      </div>
      <Button onClick={() => void access.grant()} disabled={access.granting}>
        {access.granting ? (
          <UiLoadingSpinner className="mr-2 h-4 w-4" />
        ) : (
          <KeyRound className="mr-2 h-4 w-4" />
        )}
        Grant decode for this session
      </Button>
    </div>
  );
};

export default PiiAccessNotice;
