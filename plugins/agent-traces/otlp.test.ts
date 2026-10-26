import { describe, expect, it } from "vitest";
import { hexId, parseHeaders, toOtlp } from "./otlp.js";
import type { Span, Turn } from "./trace.js";

const T0 = 1_800_000_000_000;

function span(overrides: Partial<Span>): Span {
  return {
    id: "s",
    parentId: null,
    kind: "command",
    name: "pnpm",
    detail: "pnpm test",
    start: T0 + 1_000,
    end: T0 + 2_000,
    status: "completed",
    background: false,
    tokens: null,
    exitCode: 0,
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
  index: 3,
  prompt: "Fix the flaky test",
  sender: null,
  start: T0,
  end: T0 + 10_000,
  status: "completed",
  spans: [
    span({
      id: "d1",
      kind: "subagent",
      name: "Trace the race",
      tokens: 1234,
      start: T0 + 3_000,
      end: T0 + 8_000,
    }),
    span({
      id: "c1",
      parentId: "d1",
      status: "failed",
      exitCode: 1,
      error: "1 test failed",
      start: T0 + 4_000,
      end: T0 + 5_000,
    }),
  ],
  activity: [],
  requestSeq: 1,
  firstSeq: 1,
  lastSeq: 9,
};

describe("toOtlp", () => {
  const payload = toOtlp(
    { id: "thr_a", title: "Demo", projectId: "proj_1", providerId: "claude-code" },
    [turn],
    T0,
    "0.1.0",
  );
  const spans = payload.resourceSpans[0].scopeSpans[0].spans;
  const byName = (name: string) => spans.find((candidate) => candidate.name === name)!;

  it("makes one trace per turn with stable ids", () => {
    const root = byName("turn #3");
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(spans.map((candidate) => candidate.traceId)).size).toBe(1);
    expect(
      toOtlp({ id: "thr_a", title: "Demo", projectId: null, providerId: null }, [turn], T0, "0.1.0")
        .resourceSpans[0].scopeSpans[0].spans[0].spanId,
    ).toBe(root.spanId);
    expect(root.startTimeUnixNano).toBe(`${T0}000000`);
  });

  it("nests calls under their subagent and keeps failures", () => {
    const subagent = byName("invoke_agent Trace the race");
    const command = byName("execute_tool pnpm");
    expect(subagent.parentSpanId).toBe(byName("turn #3").spanId);
    expect(command.parentSpanId).toBe(subagent.spanId);
    expect(command.status).toEqual({ code: 2, message: "1 test failed" });
    expect(command.attributes).toEqual(
      expect.arrayContaining([
        { key: "process.command_line", value: { stringValue: "pnpm test" } },
        { key: "process.exit.code", value: { intValue: "1" } },
        { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } },
      ]),
    );
    // The main agent's model time between calls is inferred.
    expect(spans.some((candidate) => candidate.name === "chat model")).toBe(true);
  });

  it("describes the thread on the resource", () => {
    expect(payload.resourceSpans[0].resource.attributes).toEqual(
      expect.arrayContaining([
        { key: "service.name", value: { stringValue: "bb" } },
        { key: "bb.thread.id", value: { stringValue: "thr_a" } },
      ]),
    );
  });
});

describe("ids and headers", () => {
  it("never makes an all-zero id", () => {
    for (let index = 0; index < 200; index++) expect(hexId(`x${index}`, 8)).not.toMatch(/^0+$/);
  });

  it("parses OTEL-style header pairs", () => {
    expect(parseHeaders("Authorization=Bearer abc, x-team = core,bad,x-encoded=a%20b")).toEqual({
      Authorization: "Bearer abc",
      "x-team": "core",
      "x-encoded": "a b",
    });
  });
});
