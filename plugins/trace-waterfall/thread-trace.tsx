import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { CompareView } from "./compare.js";
import { Overview } from "./overview.js";
import type { Screen } from "./routes.js";
import type { rpcContract } from "./server.js";
import { TRACE_CHANNEL } from "./trace.js";
import { Notice, OpenInPage } from "./ui.js";
import { errorMessage } from "./util.js";
import { TurnView } from "./waterfall.js";

export type { Screen } from "./routes.js";

type Trace = PluginRpcResult<(typeof rpcContract)["trace"]>;
export type TurnSummary = Trace["turns"][number];

/** Where to open a trace: a thread, and optionally one of its turns and spans. */
export interface Target {
  threadId: string;
  turnId?: string;
  spanId?: string;
  /** A chat message's sequence, from "Trace this turn". */
  atSeq?: number;
  /** The thread this was opened from, for the way back. */
  fromTitle?: string;
  /** What this thread's trace showed when another was opened from it. */
  screen?: Screen;
}

export interface Back {
  label: string;
  onBack: () => void;
}

/** The turn a chat message belongs to: the one it prompted, ran in, or came just before. */
function turnAtSeq(turns: readonly TurnSummary[], seq: number): TurnSummary | undefined {
  return (
    turns.find((turn) => turn.requestSeq === seq) ??
    turns.find((turn) => turn.firstSeq <= seq && seq <= turn.lastSeq) ??
    turns.find((turn) => turn.firstSeq > seq)
  );
}

export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  return running ? now : Date.now();
}

/** Calls `refresh` again once the socket reconnects, since missed signals are not replayed. */
export function useCatchUp(refresh: () => void) {
  const connection = useRealtimeConnectionState();
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  const connectedBefore = useRef(false);
  // Only a change of connection runs this, never a new `refresh`.
  useEffect(() => {
    if (connection !== "connected") return;
    if (connectedBefore.current) latest.current();
    connectedBefore.current = true;
  }, [connection]);
}

/**
 * One thread's turns, with the spans of the turn in focus, refetched whenever
 * the server signals a change to it. One call answers both, so a signal costs
 * the server one read.
 */
function useTrace(threadId: string, turnId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const key = `${threadId}:${turnId ?? ""}`;
  const [snapshot, setSnapshot] = useState<{ key: string; data: Trace } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  const refresh = useCallback(() => {
    const request = ++latestRequest.current;
    rpc.call("trace", turnId ? { threadId, turnId } : { threadId }).then(
      (data) => {
        if (request !== latestRequest.current) return;
        setSnapshot({ key, data });
        setError(null);
      },
      (cause) => {
        if (request === latestRequest.current) setError(errorMessage(cause));
      },
    );
  }, [rpc, threadId, turnId, key]);

  useEffect(refresh, [refresh]);
  useRealtime(TRACE_CHANNEL, (payload) => {
    const changed = (payload as { threadId?: unknown } | null)?.threadId;
    if (changed === threadId) refresh();
  });
  useCatchUp(refresh);

  return {
    // The turns stay good while the focus moves; the focused spans do not.
    data: snapshot?.data ?? null,
    focus: snapshot?.key === key ? snapshot.data.focus : null,
    error,
  };
}

/**
 * Thread titles and turn numbers from traces already read, for the page's
 * breadcrumbs, which are drawn outside the trace.
 */
const labels = new Map<string, string | number>();
const labelListeners = new Set<() => void>();
let labelsVersion = 0;

function rememberLabels(trace: Trace) {
  let changed = false;
  const set = (key: string, value: string | number) => {
    if (labels.get(key) === value) return;
    labels.set(key, value);
    changed = true;
  };
  set(trace.threadId, trace.title);
  for (const turn of trace.turns) set(`${trace.threadId}\n${turn.id}`, turn.index);
  if (!changed) return;
  labelsVersion++;
  for (const listener of labelListeners) listener();
}

function subscribeLabels(listener: () => void) {
  labelListeners.add(listener);
  return () => {
    labelListeners.delete(listener);
  };
}

/** A thread's title and its turns' `#`, null until its trace has been read. */
export function useTraceLabels() {
  useSyncExternalStore(subscribeLabels, () => labelsVersion);
  return {
    title: (threadId: string) => {
      const title = labels.get(threadId);
      return typeof title === "string" ? title : null;
    },
    turn: (threadId: string, turnId: string) => {
      const index = labels.get(`${threadId}\n${turnId}`);
      return typeof index === "number" ? index : null;
    },
  };
}

/**
 * One thread's trace: its turns, one turn's waterfall, its calls, or two turns
 * compared. The tab keeps which of those it shows; the Traces page passes
 * `screen` from its URL instead.
 */
export function ThreadTrace({
  target,
  back,
  onOpenThread,
  screen: routeScreen,
  onScreen,
  onOpenPage,
}: {
  target: Target;
  back: Back | null;
  onOpenThread: (target: Target, screen: Screen) => void;
  screen?: Screen;
  onScreen?: (screen: Screen) => void;
  /** Opens what this shows in the Traces page, from the tab. */
  onOpenPage?: (screen: Screen) => void;
}) {
  const { threadId } = target;
  // Coming back from a thread opened here returns to where it was opened.
  const [ownScreen, setOwnScreen] = useState<Screen | null>(
    () =>
      target.screen ??
      (target.turnId ? { kind: "turn", turnId: target.turnId, spanId: target.spanId } : null),
  );
  const screen = routeScreen ?? ownScreen;
  const setScreen = onScreen ?? setOwnScreen;
  const focusId = screen?.kind === "turn" ? screen.turnId : null;
  const trace = useTrace(threadId, focusId);
  const turns = trace.data?.turns ?? [];
  const latest = turns.at(-1);
  // Pick the first view once, then stay put: a turn ending or starting never pulls it away.
  const loaded = trace.data !== null;
  useEffect(() => {
    if (screen !== null || !loaded) return;
    const fromMessage = target.atSeq === undefined ? undefined : turnAtSeq(turns, target.atSeq);
    const automatic =
      fromMessage ?? (latest && (latest.end === null || turns.length === 1) ? latest : undefined);
    setScreen(automatic ? { kind: "turn", turnId: automatic.id } : { kind: "turns" });
  }, [screen, loaded, target.atSeq, turns, latest, setScreen]);
  useEffect(() => {
    if (trace.data) rememberLabels(trace.data);
  }, [trace.data]);
  const now = useNow(latest?.end === null);

  const { error } = trace;
  if (!trace.data || screen === null) {
    return <Notice>{error ? `Could not load the trace: ${error}` : "Reading the thread…"}</Notice>;
  }
  const data = trace.data;
  if (turns.length === 0) {
    return <Notice>No turns yet. The trace fills in as soon as the agent starts working.</Notice>;
  }
  const notice = error ? `Could not refresh: ${error}` : null;
  const openThread = (next: Omit<Target, "fromTitle">) =>
    onOpenThread({ ...next, fromTitle: data.title }, screen);

  return (
    <OpenInPage.Provider value={onOpenPage ? () => onOpenPage(screen) : null}>
      {(() => {
        if (screen.kind === "compare") {
          const a = turns.find((turn) => turn.id === screen.a);
          const b = turns.find((turn) => turn.id === screen.b);
          if (a && b) {
            return (
              <CompareView
                threadId={threadId}
                a={a}
                b={b}
                onBack={() => setScreen({ kind: "turns" })}
              />
            );
          }
        }
        const index =
          screen.kind === "turn" ? turns.findIndex((turn) => turn.id === screen.turnId) : -1;
        if (index < 0) {
          return (
            <Overview
              threadId={threadId}
              title={onScreen ? null : data.title}
              turns={turns}
              now={now}
              notice={notice}
              back={back}
              tab={screen.kind === "commands" ? "commands" : "turns"}
              onTab={(tab) => setScreen({ kind: tab })}
              onOpen={(turnId, spanId) =>
                setScreen(spanId ? { kind: "turn", turnId, spanId } : { kind: "turn", turnId })
              }
              onCompare={(a, b) => setScreen({ kind: "compare", a, b })}
              onOpenThread={openThread}
            />
          );
        }
        const previous = turns[index - 1];
        const next = turns[index + 1];
        const live = latest && latest.end === null && latest.id !== focusId ? latest : null;
        const spanId = screen.kind === "turn" ? screen.spanId : undefined;
        return (
          <TurnView
            threadId={threadId}
            projectId={data.projectId}
            summary={turns[index]}
            focus={trace.focus}
            now={now}
            notice={notice}
            back={back}
            initialSpanId={spanId}
            onBack={turns.length > 1 ? () => setScreen({ kind: "turns" }) : null}
            onPrevious={previous ? () => setScreen({ kind: "turn", turnId: previous.id }) : null}
            onNext={next ? () => setScreen({ kind: "turn", turnId: next.id }) : null}
            liveTurn={
              live
                ? { index: live.index, open: () => setScreen({ kind: "turn", turnId: live.id }) }
                : null
            }
            onOpenThread={openThread}
          />
        );
      })()}
    </OpenInPage.Provider>
  );
}
