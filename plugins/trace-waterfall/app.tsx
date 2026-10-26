import { useState } from "react";
import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { formatSubPath, TRACES_PATH } from "./routes.js";
import { ThreadTrace, type Back, type Target } from "./thread-trace.js";
import { TracesHeader, TracesPage, TracesSidebar, useTracesPageTitle } from "./traces.js";

/** A message action, a command, or a link can open the tab on one turn. */
function parseParams(params: unknown): Omit<Target, "threadId"> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return {};
  const { turnId, spanId, atSeq } = params as Record<string, unknown>;
  return {
    turnId: typeof turnId === "string" && turnId ? turnId : undefined,
    spanId: typeof spanId === "string" && spanId ? spanId : undefined,
    atSeq: typeof atSeq === "number" && Number.isFinite(atSeq) ? atSeq : undefined,
  };
}

/** The tab: one thread's trace at a time, with a way back from the threads it spawned. */
function TracePanel({ threadId, params }: { threadId: string; params: unknown }) {
  const navigate = useBbNavigate();
  const [stack, setStack] = useState<Target[]>(() => [{ threadId, ...parseParams(params) }]);
  const target = stack[stack.length - 1];
  const back: Back | null =
    stack.length > 1
      ? { label: target.fromTitle ?? "Back", onBack: () => setStack(stack.slice(0, -1)) }
      : null;
  return (
    <ThreadTrace
      key={`${stack.length}:${target.threadId}`}
      target={target}
      back={back}
      onOpenThread={(next, screen) =>
        setStack([...stack.slice(0, -1), { ...target, screen }, next])
      }
      onOpenPage={(screen) =>
        navigate.toPluginPanel(TRACES_PATH, { subPath: formatSubPath(target.threadId, screen) })
      }
    />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "traces",
    title: "Traces",
    // Declared in package.json under bb.branding.experimental_icons.
    icon: "trace-waterfall/waterfall",
    path: TRACES_PATH,
    component: TracesPage,
    headerContent: TracesHeader,
    experimental_sidebar: TracesSidebar,
    experimental_usePageTitle: useTracesPageTitle,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "trace",
    title: "Trace",
    icon: "trace-waterfall/waterfall",
    tooltip: "See where this thread's time went",
    layout: "flush",
    component: TracePanel,
  });
  app.slots.messageAction({
    id: "trace-turn",
    title: "Trace this turn",
    icon: "trace-waterfall/waterfall",
    run: ({ message, openPanel }) => {
      openPanel({
        actionId: "trace",
        title: "Trace",
        params: { atSeq: message.experimental_messageSeq },
      });
    },
  });
  app.commands.register({
    id: "open-trace",
    title: "Trace Waterfall: open this thread's trace",
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ openPanel }) => {
      openPanel({ actionId: "trace" });
    },
  });
});
