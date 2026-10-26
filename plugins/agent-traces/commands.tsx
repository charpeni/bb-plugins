import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import type { Target } from "./thread-trace.js";
import { formatDuration } from "./trace.js";
import { Tabs, useColors } from "./ui.js";
import { errorMessage, plural } from "./util.js";

type Commands = PluginRpcResult<(typeof rpcContract)["commands"]>;
type Scope = Commands["scope"];

const PROJECT_THREADS = 20;

/**
 * Calls grouped by what they ran, most total time first: where a thread, or a
 * project's recent threads, keep spending time. A row opens its slowest run.
 */
export function CommandsView({
  threadId,
  onOpen,
  onOpenThread,
}: {
  threadId: string;
  onOpen: (turnId: string, spanId?: string) => void;
  onOpenThread: (target: Omit<Target, "fromTitle">) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { phases: colors } = useColors();
  const [scope, setScope] = useState<Scope>("thread");
  const [result, setResult] = useState<{ scope: Scope; data: Commands } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    rpc
      .call(
        "commands",
        scope === "project" ? { threadId, scope, threads: PROJECT_THREADS } : { threadId, scope },
      )
      .then(
        (data) => {
          if (!cancelled) setResult({ scope, data });
        },
        (cause) => {
          if (!cancelled) setError(errorMessage(cause));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, scope]);

  const data = result?.scope === scope ? result.data : null;
  const most = Math.max(1, ...(data?.rows ?? []).map((row) => row.totalMs));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 pb-2">
        <Tabs
          value={scope}
          onChange={setScope}
          options={[
            { value: "thread", label: "This thread" },
            { value: "project", label: `Project · last ${PROJECT_THREADS} threads` },
          ]}
        />
        <span className="truncate text-[11px] text-muted-foreground">
          {data
            ? `${plural(data.rows.length, "kind")} of call${scope === "project" ? ` in ${plural(data.threads, "thread")}` : ""}`
            : ""}
        </span>
      </div>
      {error ? (
        <p className="px-3 text-xs text-destructive">Could not load the calls: {error}</p>
      ) : null}
      {!data && !error ? (
        <p className="px-3 text-xs text-muted-foreground">
          {scope === "project" ? "Reading the project's recent threads…" : "Reading the thread…"}
        </p>
      ) : null}
      {data ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
          <div className="grid grid-cols-[minmax(8rem,1fr)_5.5rem_3rem_4.5rem_4.5rem_3rem] gap-x-2 px-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <span>Call</span>
            <span className="text-right">Total</span>
            <span className="text-right">Runs</span>
            <span className="text-right">Average</span>
            <span className="text-right">Slowest</span>
            <span className="text-right">Fails</span>
          </div>
          {data.rows.map((row) => (
            <button
              key={row.signature}
              type="button"
              title={`Open the slowest run (${formatDuration(row.slowest.durationMs)}, turn #${row.slowest.turnIndex})`}
              onClick={() =>
                row.slowest.threadId === threadId
                  ? onOpen(row.slowest.turnId, row.slowest.spanId)
                  : onOpenThread({
                      threadId: row.slowest.threadId,
                      turnId: row.slowest.turnId,
                      spanId: row.slowest.spanId,
                    })
              }
              className="grid w-full grid-cols-[minmax(8rem,1fr)_5.5rem_3rem_4.5rem_4.5rem_3rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left text-xs tabular-nums hover:bg-muted"
            >
              <span className="min-w-0">
                <span className="block truncate font-mono text-[11.5px] text-foreground">
                  {row.signature}
                </span>
                <span
                  className="mt-0.5 block h-1 rounded-sm"
                  style={{
                    width: `${Math.max(1, (100 * row.totalMs) / most)}%`,
                    background: colors.tools,
                  }}
                />
              </span>
              <span className="text-right">{formatDuration(row.totalMs)}</span>
              <span className="text-right text-muted-foreground">
                {row.count}
                {scope === "project" && row.threads > 1 ? (
                  <span title={`In ${plural(row.threads, "thread")}`}> · {row.threads}t</span>
                ) : null}
              </span>
              <span className="text-right text-muted-foreground">{formatDuration(row.avgMs)}</span>
              <span className="text-right text-muted-foreground">{formatDuration(row.maxMs)}</span>
              <span
                className={`text-right ${row.failures > 0 ? "text-destructive" : "text-muted-foreground"}`}
              >
                {row.failures}
              </span>
            </button>
          ))}
          {data.rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No calls recorded yet.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
