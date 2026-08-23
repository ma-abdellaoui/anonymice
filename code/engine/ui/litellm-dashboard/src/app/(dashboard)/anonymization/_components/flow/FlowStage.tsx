import React from "react";

import { ArrowLeft, ArrowRight, Cloud, ShieldCheck } from "lucide-react";

import MorphText from "./MorphText";
import TokenText from "./TokenText";
import VaultPanel from "./VaultPanel";
import { BEAT_SIDE, type Beat, type FlowRun } from "./flowTypes";

const BEAT_ORDER: Record<Beat, number> = { typed: 0, detect: 1, encode: 2, cross: 3, reply: 4, decode: 5 };

const reached = (beat: Beat, target: Beat) => BEAT_ORDER[beat] >= BEAT_ORDER[target];

interface PanelProps {
  title: string;
  hint?: string;
  active: boolean;
  filled: boolean;
  children: React.ReactNode;
}

const Panel: React.FC<PanelProps> = ({ title, hint, active, filled, children }) => (
  <div
    className={`rounded-lg border bg-card transition-all duration-500 ${
      active ? "border-foreground/25 shadow-md" : "border-border"
    } ${filled ? "opacity-100" : "opacity-45"}`}
  >
    <div className="flex items-baseline gap-2 border-b border-border px-3 py-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
      {hint && <span className="ml-auto font-mono text-[10px] text-muted-foreground">{hint}</span>}
    </div>
    <div className="min-h-[3.5rem] px-3 py-2.5">{children}</div>
  </div>
);

const Waiting: React.FC<{ label: string }> = ({ label }) => (
  <p className="font-mono text-[13px] leading-7 text-muted-foreground/50">{label}</p>
);

interface PacketProps {
  beat: Beat;
  label: string;
}

/** The pill that carries text across the line, so the crossing is a thing you watch happen. */
const Packet: React.FC<PacketProps> = ({ beat, label }) => {
  const outbound = beat === "cross";
  return (
    <div
      key={beat}
      className="anm-packet pointer-events-none absolute top-1/2 z-20 max-w-[38%] truncate rounded-full border border-foreground/15 bg-card px-3 py-1.5 font-mono text-[11px] shadow-lg"
      style={{
        left: outbound ? "12%" : "62%",
        ["--anm-travel" as string]: outbound ? "170%" : "-170%",
      }}
    >
      <span className="mr-1.5 inline-flex items-center align-middle text-muted-foreground">
        {outbound ? <ArrowRight className="h-3 w-3" /> : <ArrowLeft className="h-3 w-3" />}
      </span>
      {label}
    </div>
  );
};

interface FlowStageProps {
  run: FlowRun;
  beat: Beat;
}

/**
 * One canvas split by the trust boundary.
 *
 * Left of the line is ours and right of it is the provider's, and nothing on
 * the right ever renders a value. That is not a presentational choice: the
 * right-hand panels are fed from the encoded strings, so the picture cannot
 * disagree with what actually crossed.
 */
const FlowStage: React.FC<FlowStageProps> = ({ run, beat }) => {
  const crossing = BEAT_SIDE[beat] === "crossing";
  const entityCount = run.vault.length;

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-b from-muted/60 to-card">
      <div
        className={`pointer-events-none absolute inset-y-0 left-1/2 z-10 w-px -translate-x-1/2 bg-[repeating-linear-gradient(to_bottom,var(--color-muted-foreground)_0_6px,transparent_6px_12px)] ${
          crossing || beat === "reply" ? "anm-boundary-live" : "opacity-40"
        }`}
      />
      <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full border border-border bg-card px-3 py-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground shadow-sm">
        trust boundary
      </div>

      {(beat === "cross" || beat === "reply") && (
        <Packet beat={beat} label={beat === "cross" ? run.encodedPrompt : run.providerReply} />
      )}

      <div className="grid grid-cols-2 gap-6 px-5 pb-5 pt-14">
        <section aria-label="Your boundary" className="flex flex-col gap-3">
          <header className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" />
            your boundary
          </header>

          <Panel
            title="Your prompt"
            hint={beat === "detect" ? `${entityCount} span${entityCount === 1 ? "" : "s"}` : undefined}
            active={["typed", "detect", "encode"].includes(beat)}
            filled
          >
            <MorphText
              segments={run.promptSegments}
              show={reached(beat, "encode") ? "token" : "value"}
              outlined={reached(beat, "detect")}
              stagger={beat === "detect"}
            />
          </Panel>

          <VaultPanel entries={run.vault} revealed={reached(beat, "encode")} resolving={beat === "decode"} />

          <Panel title="What you get back" active={beat === "decode"} filled={beat === "decode"}>
            {beat === "decode" ? (
              <MorphText segments={run.replySegments} show="value" />
            ) : (
              <Waiting label="waiting for the answer" />
            )}
          </Panel>
        </section>

        <section aria-label="The provider" className="flex flex-col gap-3">
          <header className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-foreground">
            <Cloud className="h-3.5 w-3.5 text-muted-foreground" />
            the provider
            <span className="ml-1 font-mono text-[10px] normal-case tracking-normal text-muted-foreground">{run.model}</span>
          </header>

          <Panel title="What the provider receives" active={beat === "cross"} filled={reached(beat, "cross")}>
            {reached(beat, "cross") ? (
              <TokenText text={run.encodedPrompt} />
            ) : (
              <Waiting label="nothing has crossed yet" />
            )}
          </Panel>

          <Panel title="What the provider replies" active={beat === "reply"} filled={reached(beat, "reply")}>
            {reached(beat, "reply") ? (
              <TokenText text={run.providerReply} />
            ) : (
              <Waiting label="still thinking" />
            )}
          </Panel>

          <div className="mt-auto flex items-baseline gap-2 rounded-lg border border-border bg-card px-3 py-2.5">
            <span className="font-mono text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-300">0</span>
            <span className="text-xs text-muted-foreground">
              real values crossed the line, out of {entityCount} detected
            </span>
          </div>
        </section>
      </div>
    </div>
  );
};

export default FlowStage;
