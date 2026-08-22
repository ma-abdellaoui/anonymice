import React, { useState } from "react";

import { Download, Trash2 } from "lucide-react";

import {
  piiExportSubjectCall,
  piiRevokeSubjectCall,
  type PiiExportedValue,
  type PiiScopeType,
} from "@/components/networking";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";

interface SubjectToolsProps {
  accessToken: string | null;
  scope: PiiScopeType;
  run: (label: string, action: () => Promise<void>) => Promise<void>;
  busy: string | null;
}

const SubjectTools: React.FC<SubjectToolsProps> = ({ accessToken, scope, run, busy }) => {
  const [subjectId, setSubjectId] = useState("");
  const [exported, setExported] = useState<PiiExportedValue[] | null>(null);

  const onExport = () =>
    run("export", async () => {
      const response = await piiExportSubjectCall(accessToken!, subjectId, scope);
      setExported(response.values);
    });

  const onErase = () =>
    run("erase", async () => {
      await piiRevokeSubjectCall(accessToken!, subjectId, scope);
      setExported([]);
    });

  const disabled = !accessToken || busy !== null || subjectId.trim() === "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subject</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Export and erasure both work off the{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">subject_id</code> recorded at encode time,
          which defaults to the request&apos;s end user. Values encoded without one are not reachable this way.
        </p>
        <div className="flex flex-wrap gap-2">
          <Input
            value={subjectId}
            onChange={(event) => setSubjectId(event.target.value)}
            placeholder="subject_id"
            className="max-w-md font-mono text-sm"
          />
          <Button onClick={onExport} disabled={disabled}>
            {busy === "export" ? <UiLoadingSpinner className="mr-2 h-4 w-4" /> : <Download className="mr-2 h-4 w-4" />}
            Export
          </Button>
          <Button variant="secondary" onClick={onErase} disabled={disabled}>
            {busy === "erase" ? <UiLoadingSpinner className="mr-2 h-4 w-4" /> : <Trash2 className="mr-2 h-4 w-4" />}
            Erase
          </Button>
        </div>

        {exported !== null &&
          (exported.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing held for this subject in the {scope} scope.</p>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-amber-600 dark:text-amber-300">This is real PII and the read has been audited.</p>
              {exported.map((entry) => (
                <div key={entry.token} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                    {entry.token}
                  </code>
                  <span className="text-foreground">{entry.value}</span>
                </div>
              ))}
            </div>
          ))}
      </CardContent>
    </Card>
  );
};

export default SubjectTools;
