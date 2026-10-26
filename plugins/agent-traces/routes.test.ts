import { describe, expect, it } from "vitest";
import { formatSubPath, parseSubPath, type Screen } from "./routes.js";

describe("Traces page URLs", () => {
  it("round-trips every view of a thread", () => {
    const screens: Screen[] = [
      { kind: "turns" },
      { kind: "commands" },
      { kind: "turn", turnId: "turn_1" },
      { kind: "turn", turnId: "turn 1", spanId: "thread:thr_b/item:42" },
      { kind: "compare", a: "turn_1", b: "turn_4" },
    ];
    for (const screen of screens) {
      expect(parseSubPath(formatSubPath("thr_a", screen))).toEqual({ threadId: "thr_a", screen });
    }
    expect(formatSubPath("thr_a")).toBe("thr_a");
    expect(formatSubPath(null)).toBe("");
  });

  it("reads a span id whose slash arrived decoded", () => {
    expect(parseSubPath("thr_a/turns/turn_1/thread:thr_b/item:42")).toEqual({
      threadId: "thr_a",
      screen: { kind: "turn", turnId: "turn_1", spanId: "thread:thr_b/item:42" },
    });
  });

  it("falls back to the nearest page it can show", () => {
    expect(parseSubPath("")).toEqual({ threadId: null });
    expect(parseSubPath("not a thread!")).toEqual({ threadId: null });
    expect(parseSubPath("thr_a/turns")).toEqual({ threadId: "thr_a", screen: { kind: "turns" } });
    expect(parseSubPath("thr_a/compare/turn_1")).toEqual({
      threadId: "thr_a",
      screen: { kind: "turns" },
    });
    expect(parseSubPath("thr_a/turns/%E0%A4%A")).toEqual({
      threadId: "thr_a",
      screen: { kind: "turns" },
    });
  });
});
