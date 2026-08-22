import React from "react";

import { BEATS, BEAT_CAPTIONS, BEAT_LABELS, type Beat, type FlowTimings } from "./flowTypes";

const TIMED: Partial<Record<Beat, keyof FlowTimings>> = {
  encode: "encode",
  reply: "provider",
  decode: "decode",
};

const ms = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`);

const CURRENT = "border-gray-900 bg-gray-900 text-white shadow-sm";
const DONE = "border-emerald-200 bg-emerald-50 text-emerald-900";
const AHEAD = "border-gray-200 bg-white text-gray-400 hover:border-gray-300";

const stepStyle = (at: number, current: number): string => {
  if (at === current) return CURRENT;
  return at < current ? DONE : AHEAD;
};

interface FlowStepperProps {
  beat: Beat;
  index: number;
  timings: FlowTimings;
  onSelect: (index: number) => void;
}

/** The beat rail: a map of the pipeline and the way to park on any step of it. */
const FlowStepper: React.FC<FlowStepperProps> = ({ beat, index, timings, onSelect }) => (
  <div className="flex flex-col gap-2">
    <ol className="flex flex-wrap items-stretch gap-1.5">
      {BEATS.map((step, at) => {
        const current = at === index;
        const timing = TIMED[step];
        return (
          <li key={step} className="flex-1">
            <button
              type="button"
              onClick={() => onSelect(at)}
              aria-current={current ? "step" : undefined}
              className={`w-full rounded-md border px-2.5 py-1.5 text-left transition-all duration-300 ${stepStyle(at, index)}`}
            >
              <span className="block text-[10px] font-mono opacity-60">{at + 1}</span>
              <span className="block truncate text-xs font-medium">{BEAT_LABELS[step]}</span>
              {timing && (
                <span className="block font-mono text-[10px] opacity-70">{ms(timings[timing])}</span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
    <p className="min-h-[2.5rem] text-sm leading-relaxed text-gray-600">{BEAT_CAPTIONS[beat]}</p>
  </div>
);

export default FlowStepper;
