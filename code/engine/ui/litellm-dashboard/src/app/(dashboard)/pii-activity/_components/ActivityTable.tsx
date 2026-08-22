import React from "react";

import {
  DIRECTION_STYLES,
  OUTCOME_STYLES,
  SURFACE_LABELS,
  SURFACE_STYLES,
  clockTime,
  duration,
  outcomeSummary,
  totalEntities,
} from "./activityFormat";

import type { PiiActivityEvent } from "@/components/networking";

const Chip: React.FC<{ className: string; children: React.ReactNode }> = ({ className, children }) => (
  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${className}`}>{children}</span>
);

interface ActivityTableProps {
  events: PiiActivityEvent[];
  selectedId: string | null;
  onSelect: (event: PiiActivityEvent) => void;
}

const ActivityTable: React.FC<ActivityTableProps> = ({ events, selectedId, onSelect }) => (
  <table className="w-full border-collapse text-sm">
    <thead className="sticky top-0 z-10 bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500">
      <tr>
        <th className="px-3 py-2 font-medium">Time</th>
        <th className="px-3 py-2 font-medium">Where</th>
        <th className="px-3 py-2 font-medium">What</th>
        <th className="px-3 py-2 font-medium">Entities</th>
        <th className="px-3 py-2 font-medium">Outcome</th>
        <th className="px-3 py-2 text-right font-medium">Took</th>
      </tr>
    </thead>
    <tbody className="divide-y divide-gray-100">
      {events.map((event) => (
        <tr
          key={event.id}
          onClick={() => onSelect(event)}
          className={`cursor-pointer transition-colors ${
            selectedId === event.id ? "bg-gray-100" : "hover:bg-gray-50"
          }`}
        >
          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-gray-500">{clockTime(event.at)}</td>
          <td className="px-3 py-2">
            <div className="flex flex-col gap-0.5">
              <Chip className={SURFACE_STYLES[event.surface]}>{SURFACE_LABELS[event.surface] ?? event.surface}</Chip>
              <span className="font-mono text-[10px] text-gray-400">
                {event.browser?.host ?? event.model ?? event.key_alias ?? "—"}
              </span>
            </div>
          </td>
          <td className="px-3 py-2">
            <Chip className={DIRECTION_STYLES[event.direction]}>{event.direction}</Chip>
          </td>
          <td className="px-3 py-2">
            <div className="flex flex-wrap gap-1">
              {totalEntities(event) === 0 && <span className="text-xs text-gray-300">none</span>}
              {Object.entries(event.entity_counts).map(([entity, count]) => (
                <span key={entity} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600">
                  {entity}
                  {count > 1 ? ` ×${count}` : ""}
                </span>
              ))}
            </div>
          </td>
          <td className="px-3 py-2">
            <div className="flex items-center gap-2">
              <Chip className={OUTCOME_STYLES[event.outcome.kind]}>{event.outcome.kind}</Chip>
              <span className="truncate text-xs text-gray-500">{outcomeSummary(event)}</span>
            </div>
          </td>
          <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-gray-500">
            {duration(event.duration_ms)}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

export default ActivityTable;
