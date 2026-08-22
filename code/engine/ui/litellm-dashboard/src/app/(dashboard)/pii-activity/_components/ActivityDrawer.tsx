import React from "react";

import { X } from "lucide-react";

import {
  DIRECTION_STYLES,
  OUTCOME_STYLES,
  SURFACE_LABELS,
  SURFACE_STYLES,
  clockTime,
  duration,
  outcomeSummary,
} from "./activityFormat";

import type { PiiActivityEvent } from "@/components/networking";

const Chip: React.FC<{ className: string; children: React.ReactNode }> = ({ className, children }) => (
  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${className}`}>{children}</span>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
    <span className="break-all font-mono text-xs text-foreground">{children}</span>
  </div>
);

const WITHHELD =
  "This event carries the text, and this key may not read it. Reading a captured value needs the same " +
  "allow_pii_decode grant that reading a token back does.";
const CAPTURE_OFF =
  "Text capture is off. Set LITELLM_PII_ACTIVITY_CAPTURE_TEXT=true to record the before and after alongside " +
  "the counts.";
const NOTHING_CAPTURED = "Nothing was captured for this call.";

const whyNoText = (withheld: boolean, captureEnabled: boolean): string => {
  if (withheld) return WITHHELD;
  return captureEnabled ? NOTHING_CAPTURED : CAPTURE_OFF;
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="flex flex-col gap-2">
    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
    {children}
  </section>
);

interface ActivityDrawerProps {
  event: PiiActivityEvent;
  captureEnabled: boolean;
  onClose: () => void;
}

/**
 * What one call did, in full.
 *
 * When the text is absent the drawer says which of the two reasons applies:
 * nothing was captured, or something was captured and this key may not read it.
 * Rendering an empty panel for both would hide a permission decision.
 */
const ActivityDrawer: React.FC<ActivityDrawerProps> = ({ event, captureEnabled, onClose }) => (
  <aside className="flex h-full w-[30rem] shrink-0 flex-col overflow-y-auto border-l border-border bg-card">
    <header className="sticky top-0 z-10 flex items-start gap-2 border-b border-border bg-card px-4 py-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip className={SURFACE_STYLES[event.surface]}>{SURFACE_LABELS[event.surface] ?? event.surface}</Chip>
          <Chip className={DIRECTION_STYLES[event.direction]}>{event.direction}</Chip>
          <Chip className={OUTCOME_STYLES[event.outcome.kind]}>{event.outcome.kind}</Chip>
        </div>
        <p className="text-sm text-foreground">{outcomeSummary(event)}</p>
      </div>
      <button type="button" onClick={onClose} aria-label="Close" className="ml-auto text-muted-foreground hover:text-foreground">
        <X className="h-4 w-4" />
      </button>
    </header>

    <div className="flex flex-col gap-5 p-4">
      <Section title="Call">
        <div className="grid grid-cols-2 gap-3">
          <Field label="At">{clockTime(event.at)}</Field>
          <Field label="Took">{duration(event.duration_ms)}</Field>
          <Field label="Model">{event.model ?? "—"}</Field>
          <Field label="Key">{event.key_alias ?? "—"}</Field>
          <Field label="User">{event.user_id ?? "—"}</Field>
          <Field label="Guardrail">{event.guardrail_name ?? "—"}</Field>
          <Field label="Session">{event.session_id ?? "—"}</Field>
          <Field label="Request">{event.request_id ?? "—"}</Field>
        </div>
      </Section>

      {event.browser && (
        <Section title="In the browser">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Host">{event.browser.host}</Field>
            <Field label="Trust class">{event.browser.trust_class}</Field>
            <Field label="Action">{event.browser.action}</Field>
          </div>
        </Section>
      )}

      <Section title="Detection">
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(event.entity_counts).length === 0 && (
            <span className="text-xs text-muted-foreground">nothing detected</span>
          )}
          {Object.entries(event.entity_counts).map(([entity, count]) => (
            <span key={entity} className="rounded bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground">
              {entity} × {count}
            </span>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {event.ner_stage_ran ? "The model stage ran" : "Rules stage only"} · {event.token_count} token
          {event.token_count === 1 ? "" : "s"}
          {event.direction === "decode" && ` · ${event.resolved_count} resolved`}
        </p>
      </Section>

      {event.capture ? (
        <>
          <Section title="Before">
            <pre className="whitespace-pre-wrap break-words rounded border border-border bg-muted p-2.5 font-mono text-[11px] leading-5 text-foreground">
              {event.capture.before.join("\n---\n")}
            </pre>
          </Section>
          <Section title="After">
            <pre className="whitespace-pre-wrap break-words rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/50 p-2.5 font-mono text-[11px] leading-5 text-foreground">
              {event.capture.after.join("\n---\n")}
            </pre>
          </Section>
          {event.capture.placements.length > 0 && (
            <Section title="What moved">
              <div className="divide-y divide-border rounded border border-border">
                {event.capture.placements.map((placement, index) => (
                  <div key={`${placement.token}-${index}`} className="flex items-center gap-2 px-2.5 py-1.5">
                    <code className="rounded bg-emerald-100 dark:bg-emerald-950/50 px-1.5 py-0.5 font-mono text-[11px] text-emerald-950 dark:text-emerald-300">
                      {placement.token}
                    </code>
                    <span className="text-muted-foreground/50">&larr;</span>
                    <code className="truncate font-mono text-[11px] text-foreground">{placement.value}</code>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                      {placement.detector} · {placement.score.toFixed(2)} · {placement.action}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      ) : (
        <Section title="Text">
          <p className="rounded border border-dashed border-border bg-muted p-3 text-xs text-muted-foreground">
            {whyNoText(event.capture_withheld, captureEnabled)}
          </p>
        </Section>
      )}
    </div>
  </aside>
);

export default ActivityDrawer;
