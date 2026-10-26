import { useState } from "react";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { emptyTotals, PHASES } from "./breakdown.js";
import { CommandsView } from "./commands.js";
import type { rpcContract } from "./server.js";
import type { Back, Target } from "./thread-trace.js";
import { formatDuration } from "./trace.js";
import {
  BreakdownBar,
  OpenInPageButton,
  PanelLayout,
  PromptText,
  Stats,
  StatusDot,
  Tabs,
  ToolButton,
  useColors,
} from "./ui.js";
import { plural } from "./util.js";

type TurnSummary = PluginRpcResult<(typeof rpcContract)["trace"]>["turns"][number];
type Sort = "newest" | "longest";
export type OverviewTab = "turns" | "commands";

function durationOf(turn: Pick<TurnSummary, "start" | "end">, now: number): number {
  return (turn.end ?? Math.max(now, turn.start)) - turn.start;
}

export function BackLink({ back }: { back: Back | null }) {
  if (!back) return null;
  return (
    <button
      type="button"
      onClick={back.onBack}
      className="-mb-1 flex min-w-0 items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
    >
      ← <span className="truncate">Back to {back.label}</span>
    </button>
  );
}

/** Every turn of the thread, to spot the slow ones before opening one. */
export function Overview({
  threadId,
  title,
  turns,
  now,
  notice,
  back,
  tab,
  onTab,
  onOpen,
  onCompare,
  onOpenThread,
}: {
  threadId: string;
  /** Null where the page header already names the thread. */
  title: string | null;
  turns: TurnSummary[];
  now: number;
  notice: string | null;
  back: Back | null;
  tab: OverviewTab;
  onTab: (tab: OverviewTab) => void;
  onOpen: (turnId: string, spanId?: string) => void;
  onCompare: (a: string, b: string) => void;
  onOpenThread: (target: Omit<Target, "fromTitle">) => void;
}) {
  const { phases: colors } = useColors();
  const [sort, setSort] = useState<Sort>("newest");
  const [comparing, setComparing] = useState<string[] | null>(null);
  const totals = turns.reduce(
    (sum, turn) => ({
      duration: sum.duration + durationOf(turn, now),
      tools: sum.tools + turn.toolCalls,
      subagents: sum.subagents + turn.subagents,
      childThreads: sum.childThreads + turn.childThreads,
      errors: sum.errors + turn.errors,
    }),
    { duration: 0, tools: 0, subagents: 0, childThreads: 0, errors: 0 },
  );
  const phases = emptyTotals();
  for (const turn of turns) for (const phase of PHASES) phases[phase] += turn.phases[phase];
  const longest = Math.max(1, ...turns.map((turn) => durationOf(turn, now)));
  const ordered =
    sort === "newest"
      ? [...turns].reverse()
      : [...turns].sort((a, b) => durationOf(b, now) - durationOf(a, now));

  const pick = (turnId: string) => {
    if (!comparing) return onOpen(turnId);
    const picked = comparing.includes(turnId)
      ? comparing.filter((id) => id !== turnId)
      : [...comparing, turnId];
    if (picked.length < 2) return setComparing(picked);
    const [a, b] = picked
      .map((id) => turns.find((turn) => turn.id === id)!)
      .sort((x, y) => x.index - y.index);
    setComparing(null);
    onCompare(a.id, b.id);
  };

  const header = (
    <>
      <BackLink back={back} />
      {notice ? <p className="text-xs text-destructive">{notice}</p> : null}
      <div className="flex min-w-0 items-center gap-2">
        {title ? (
          <span className="truncate font-medium" title={title}>
            {title}
          </span>
        ) : null}
        <span className="ml-auto" />
        <Tabs
          value={tab}
          onChange={onTab}
          options={[
            { value: "turns", label: "Turns" },
            { value: "commands", label: "Commands" },
          ]}
        />
        <OpenInPageButton />
      </div>
      <Stats
        items={[
          { label: "Active time", value: formatDuration(totals.duration) },
          { label: "Turns", value: String(turns.length) },
          { label: "Tool calls", value: String(totals.tools) },
          { label: "Subagents", value: String(totals.subagents) },
          ...(totals.childThreads > 0
            ? [
                {
                  label: "Threads",
                  value: String(totals.childThreads),
                  hint: "Threads this one spawned",
                },
              ]
            : []),
          { label: "Errors", value: String(totals.errors), alert: totals.errors > 0 },
        ]}
      />
      <BreakdownBar phases={phases} total={totals.duration} />
    </>
  );

  if (tab === "commands") {
    return (
      <PanelLayout header={header}>
        <CommandsView threadId={threadId} onOpen={onOpen} onOpenThread={onOpenThread} />
      </PanelLayout>
    );
  }

  return (
    <PanelLayout
      header={
        <>
          {header}
          <div className="flex items-center gap-1.5">
            <span className="mr-auto text-xs text-muted-foreground">
              {comparing
                ? `Pick ${2 - comparing.length} turn${comparing.length === 1 ? "" : "s"} to compare.`
                : "Pick a turn to see its waterfall."}
            </span>
            <ToolButton
              pressed={comparing !== null}
              onClick={() => setComparing(comparing ? null : [])}
              title="Compare two turns, such as before and after a change"
            >
              Compare
            </ToolButton>
            <ToolButton pressed={sort === "newest"} onClick={() => setSort("newest")}>
              Newest
            </ToolButton>
            <ToolButton pressed={sort === "longest"} onClick={() => setSort("longest")}>
              Longest
            </ToolButton>
          </div>
        </>
      }
    >
      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {ordered.map((turn) => {
          const duration = durationOf(turn, now);
          const picked = comparing?.includes(turn.id) ?? false;
          return (
            <li key={turn.id}>
              <button
                type="button"
                onClick={() => pick(turn.id)}
                title={turn.prompt || undefined}
                aria-pressed={comparing ? picked : undefined}
                className={`grid w-full grid-cols-[minmax(7rem,40%)_1fr] items-center gap-2 rounded-md px-1.5 py-1 text-left ${
                  picked ? "bg-accent" : "hover:bg-muted"
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {comparing ? (
                    <span
                      className={`inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border text-[10px] ${
                        picked
                          ? "border-foreground/40 bg-foreground text-background"
                          : "border-border"
                      }`}
                    >
                      {picked ? "✓" : ""}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    #{turn.index}
                  </span>
                  <StatusDot status={turn.status} />
                  <PromptText prompt={turn.prompt} sender={turn.sender} />
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="flex h-2.5 shrink-0 overflow-hidden rounded-sm"
                    style={{ width: `${Math.max(2, (60 * duration) / longest)}%` }}
                  >
                    {PHASES.map((phase) =>
                      turn.phases[phase] > 0 ? (
                        <span
                          key={phase}
                          style={{ flex: turn.phases[phase], background: colors[phase] }}
                        />
                      ) : null,
                    )}
                  </span>
                  <span className="truncate text-xs tabular-nums text-muted-foreground">
                    {formatDuration(duration)} · {plural(turn.toolCalls, "tool")}
                    {turn.subagents > 0 ? ` · ${plural(turn.subagents, "subagent")}` : ""}
                    {turn.childThreads > 0 ? ` · ${plural(turn.childThreads, "thread")}` : ""}
                    {turn.errors > 0 ? ` · ${turn.errors} failed` : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="shrink-0 px-3 py-2 text-[11px] text-muted-foreground">
        Bars show each turn's time by phase, scaled to the longest turn.
      </p>
    </PanelLayout>
  );
}
