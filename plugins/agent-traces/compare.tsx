import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { PHASE_HINTS, PHASE_LABELS } from "./breakdown.js";
import type { rpcContract } from "./server.js";
import { formatDuration } from "./trace.js";
import { OpenInPageButton, PanelLayout, PromptText, ToolButton, useColors } from "./ui.js";
import { errorMessage } from "./util.js";

type Comparison = PluginRpcResult<(typeof rpcContract)["compare"]>;
type TurnSummary = PluginRpcResult<(typeof rpcContract)["trace"]>["turns"][number];

// Differences under half a second are noise.
const NOISE_MS = 500;

function Delta({ a, b }: { a: number; b: number }) {
  const difference = b - a;
  if (Math.abs(difference) < NOISE_MS) return <span className="text-muted-foreground">same</span>;
  return (
    <span className={difference < 0 ? "text-success" : "text-destructive"}>
      {difference < 0 ? "−" : "+"}
      {formatDuration(Math.abs(difference))}
    </span>
  );
}

/** Two turns side by side: where the time moved, and which calls changed. */
export function CompareView({
  threadId,
  a,
  b,
  onBack,
}: {
  threadId: string;
  a: TurnSummary;
  b: TurnSummary;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { phases: colors } = useColors();
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.call("compare", { threadId, a: a.id, b: b.id }).then(
      (data) => {
        if (!cancelled) setComparison(data);
      },
      (cause) => {
        if (!cancelled) setError(errorMessage(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, a.id, b.id]);

  const header = (
    <>
      <div className="flex items-center gap-1.5">
        <ToolButton onClick={onBack}>← All turns</ToolButton>
        <span className="text-xs text-muted-foreground">Comparing two turns</span>
        <span className="ml-auto" />
        <OpenInPageButton />
      </div>
      {[a, b].map((turn, index) => (
        <div key={turn.id} className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="w-4 shrink-0 font-medium text-muted-foreground">
            {index === 0 ? "A" : "B"}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">#{turn.index}</span>
          <PromptText prompt={turn.prompt} sender={turn.sender} />
        </div>
      ))}
    </>
  );
  if (!comparison) {
    return (
      <PanelLayout header={header}>
        <p className={`px-3 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}>
          {error ? `Could not compare the turns: ${error}` : "Comparing…"}
        </p>
      </PanelLayout>
    );
  }
  const most = Math.max(1, ...comparison.phases.flatMap((row) => [row.a, row.b]));
  const phases = comparison.phases.filter((row) => row.a >= NOISE_MS || row.b >= NOISE_MS);
  const commands = comparison.commands.filter(
    (row) => Math.abs(row.b.totalMs - row.a.totalMs) >= NOISE_MS || row.a.count !== row.b.count,
  );
  return (
    <PanelLayout header={header}>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 text-xs">
        <div className="mb-3 flex items-baseline gap-3 border-b border-border pb-3">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Duration
          </span>
          <span className="text-base tabular-nums">
            {formatDuration(comparison.a.durationMs)} → {formatDuration(comparison.b.durationMs)}
          </span>
          <span className="tabular-nums">
            <Delta a={comparison.a.durationMs} b={comparison.b.durationMs} />
          </span>
        </div>
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Time by phase
        </div>
        {phases.map((row) => (
          <div
            key={row.phase}
            className="grid grid-cols-[6.5rem_1fr_4.5rem] items-center gap-2 py-1"
            title={PHASE_HINTS[row.phase]}
          >
            <span>{PHASE_LABELS[row.phase]}</span>
            <span className="flex flex-col gap-0.5">
              {[row.a, row.b].map((value, index) => (
                <span key={index} className="flex items-center gap-1.5">
                  <span className="w-3 text-[10px] text-muted-foreground">
                    {index === 0 ? "A" : "B"}
                  </span>
                  <span
                    className="h-2 rounded-sm"
                    style={{
                      width: `${Math.max(0.5, (70 * value) / most)}%`,
                      background: colors[row.phase],
                      opacity: index === 0 ? 0.55 : 1,
                    }}
                  />
                  <span className="tabular-nums text-muted-foreground">
                    {formatDuration(value)}
                  </span>
                </span>
              ))}
            </span>
            <span className="text-right tabular-nums">
              <Delta a={row.a} b={row.b} />
            </span>
          </div>
        ))}
        <div className="mt-4 mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Calls that changed
        </div>
        {commands.length === 0 ? (
          <p className="text-muted-foreground">The same calls ran for about the same time.</p>
        ) : null}
        {commands.map((row) => (
          <div
            key={row.signature}
            className="grid grid-cols-[minmax(6rem,1fr)_6.5rem_6.5rem_4.5rem] items-center gap-2 py-1 tabular-nums"
          >
            <span className="truncate font-mono text-[11.5px]" title={row.signature}>
              {row.signature}
            </span>
            <span className="text-right text-muted-foreground">
              {row.a.count}× {formatDuration(row.a.totalMs)}
            </span>
            <span className="text-right">
              {row.b.count}× {formatDuration(row.b.totalMs)}
            </span>
            <span className="text-right">
              <Delta a={row.a.totalMs} b={row.b.totalMs} />
            </span>
          </div>
        ))}
      </div>
    </PanelLayout>
  );
}
