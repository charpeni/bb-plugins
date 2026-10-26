import { describe, expect, it } from "vitest";
import { turnReport } from "./report.js";
import { turnSnapshot } from "./snapshot.js";
import type { Span, Turn } from "./trace.js";

const T0 = 1_800_000_000_000;

function span(overrides: Partial<Span>): Span {
  return {
    id: "s",
    parentId: null,
    kind: "command",
    name: "pnpm",
    detail: "pnpm test",
    start: T0,
    end: T0 + 1_000,
    status: "completed",
    background: false,
    tokens: null,
    exitCode: null,
    error: null,
    launchedBy: null,
    seq: 1,
    endSeq: 2,
    chatSeq: null,
    ...overrides,
  };
}

const turn: Turn = {
  id: "t1",
  index: 2,
  prompt: "Fix <the> flaky test",
  sender: null,
  start: T0,
  end: T0 + 120_000,
  status: "completed",
  spans: [
    span({
      id: "a",
      detail: "pnpm test",
      start: T0 + 5_000,
      end: T0 + 65_000,
      status: "failed",
      exitCode: 1,
      error: "2 failed",
    }),
    span({
      id: "d",
      kind: "subagent",
      name: "Review history",
      start: T0 + 70_000,
      end: T0 + 100_000,
      tokens: 2_500,
    }),
    span({
      id: "b",
      parentId: "d",
      detail: "git log --oneline",
      start: T0 + 71_000,
      end: T0 + 72_000,
    }),
  ],
  activity: [{ id: "r", lane: null, kind: "thinking", start: T0, end: T0 + 5_000 }],
  requestSeq: 1,
  firstSeq: 1,
  lastSeq: 5,
};

describe("turnReport", () => {
  it("leads with the phases, slowest calls, and failures", () => {
    const report = turnReport(turn, T0);
    expect(report).toContain("Turn #2 · 2m 00s · completed");
    expect(report).toContain("tools 50% (1m 00s)");
    expect(report).toContain("subagents 25% (30s)");
    expect(report).toContain("thinking 4% (5.0s)");
    expect(report).toMatch(/1m 00s {2}pnpm test/);
    expect(report).toContain("1.0s  git log --oneline  (in Review history)");
    expect(report).toContain("pnpm test — exit 1, 2 failed");
  });

  it("leaves calls that waited on the user out of the slowest", () => {
    const asking: Turn = {
      ...turn,
      spans: [
        span({
          id: "q",
          kind: "tool",
          name: "AskUserQuestion",
          detail: "",
          start: T0,
          end: T0 + 30_000,
        }),
        span({
          id: "w",
          kind: "waiting",
          name: "Question",
          detail: "Ship it?",
          start: T0 + 1_000,
          end: T0 + 29_000,
        }),
        span({ id: "t", detail: "pnpm test", start: T0 + 30_000, end: T0 + 35_000 }),
      ],
    };
    const report = turnReport(asking, T0);
    expect(report).toContain("waiting on you");
    expect(report.split("Slowest:")[1]).not.toContain("AskUserQuestion");
    expect(report.split("Slowest:")[1]).toContain("pnpm test");
  });
});

describe("turnSnapshot", () => {
  it("renders a standalone, escaped page", () => {
    const html = turnSnapshot({ title: "Demo & co" }, turn, T0, T0);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Turn #2 · Demo &amp; co");
    expect(html).toContain("Fix &lt;the&gt; flaky test");
    expect(html).toContain("Review history");
    expect(html).not.toContain("<script");
  });
});
