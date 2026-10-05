import { describe, expect, it } from "vitest";
import {
  addDays,
  buildBlocks,
  buildTimesheet,
  DAY_MS,
  dayBoundaries,
  formatDuration,
  formatHours,
  groupBlocks,
  HOUR_MS,
  MINUTE_MS,
  startOfWeek,
  type TurnInterval,
} from "./activity";

// vitest.config.ts pins TZ to America/Toronto.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute).getTime();
const from = at(5, 0);
const to = addDays(from, 1);
const options = { from, to, mergeGapMs: 30 * MINUTE_MS, now: at(6, 12) };

function turn(start: number, end: number | null, threadId = "thr_a"): TurnInterval {
  return { threadId, start, end };
}

describe("buildBlocks", () => {
  it("shows a thread that goes on and off for an hour as one block", () => {
    const blocks = buildBlocks(
      [
        turn(at(5, 9, 2), at(5, 9, 10)),
        turn(at(5, 9, 25), at(5, 9, 31)),
        turn(at(5, 9, 50), at(5, 9, 58)),
      ],
      options,
    );

    expect(blocks).toEqual([
      {
        threadId: "thr_a",
        start: at(5, 9),
        end: at(5, 10),
        activeMs: 22 * MINUTE_MS,
        turnCount: 3,
        ongoing: false,
      },
    ]);
  });

  it("keeps a morning session and a later session as separate blocks", () => {
    const blocks = buildBlocks(
      [turn(at(5, 9, 0), at(5, 9, 30)), turn(at(5, 12, 30), at(5, 13, 10))],
      options,
    );

    expect(blocks.map((block) => [block.start, block.end])).toEqual([
      [at(5, 9), at(5, 9, 30)],
      [at(5, 12, 30), at(5, 13, 15)],
    ]);
  });

  it("widens short turns to a quarter hour", () => {
    const [block] = buildBlocks([turn(at(5, 14, 7), at(5, 14, 9))], options);
    expect([block!.start, block!.end]).toEqual([at(5, 14), at(5, 14, 15)]);
  });

  it("merges blocks that touch once rounded out to quarter hours", () => {
    const blocks = buildBlocks([turn(at(5, 9, 0), at(5, 9, 20)), turn(at(5, 9, 40), at(5, 10))], {
      ...options,
      mergeGapMs: 15 * MINUTE_MS,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ start: at(5, 9), end: at(5, 10), turnCount: 2 });
  });

  it("extends a running turn to now", () => {
    const [block] = buildBlocks([turn(at(5, 16, 5), null)], { ...options, now: at(5, 16, 50) });
    expect(block).toMatchObject({ start: at(5, 16), end: at(5, 17), ongoing: true });
    expect(block!.activeMs).toBe(45 * MINUTE_MS);
  });

  it("counts overlapping turns of one thread once", () => {
    const [block] = buildBlocks(
      [turn(at(5, 10, 0), at(5, 11, 0)), turn(at(5, 10, 15), at(5, 10, 45))],
      options,
    );
    expect(block!.activeMs).toBe(HOUR_MS);
    expect(block!.turnCount).toBe(2);
  });

  it("clips turns to the requested range", () => {
    const blocks = buildBlocks(
      [turn(at(4, 23, 30), at(5, 0, 40)), turn(at(4, 20), at(5, 0)), turn(at(5, 23, 50), at(6, 1))],
      options,
    );
    expect(blocks.map((block) => [block.start, block.end])).toEqual([
      [at(5, 0), at(5, 0, 45)],
      [at(5, 23, 45), to],
    ]);
  });

  it("keeps threads apart even when they overlap", () => {
    const blocks = buildBlocks(
      [turn(at(5, 9), at(5, 10), "thr_a"), turn(at(5, 9, 30), at(5, 11), "thr_b")],
      options,
    );
    expect(blocks.map((block) => block.threadId)).toEqual(["thr_a", "thr_b"]);
  });
});

describe("groupBlocks", () => {
  it("merges parallel threads of a project into one entry", () => {
    const projectOf = (threadId: string) => (threadId === "thr_c" ? "proj_api" : "proj_web");
    const blocks = buildBlocks(
      [
        turn(at(5, 9), at(5, 10), "thr_a"),
        turn(at(5, 9, 30), at(5, 11), "thr_b"),
        turn(at(5, 11, 20), at(5, 11, 45), "thr_a"),
        turn(at(5, 9), at(5, 9, 30), "thr_c"),
        turn(at(5, 15), at(5, 16), "thr_b"),
      ],
      options,
    );

    const groups = groupBlocks(blocks, projectOf, 30 * MINUTE_MS);

    expect(groups.map((group) => [group.key, group.start, group.end])).toEqual([
      ["proj_api", at(5, 9), at(5, 9, 30)],
      ["proj_web", at(5, 9), at(5, 11, 45)],
      ["proj_web", at(5, 15), at(5, 16)],
    ]);
    expect(groups[1]!.threads).toEqual([
      { threadId: "thr_a", ms: 1.5 * HOUR_MS },
      { threadId: "thr_b", ms: 1.5 * HOUR_MS },
    ]);
    expect(groups[1]!.activeMs).toBe(2 * HOUR_MS + 55 * MINUTE_MS);
  });

  it("leaves thread blocks unchanged when grouped by thread", () => {
    const blocks = buildBlocks(
      [turn(at(5, 9), at(5, 9, 30)), turn(at(5, 12), at(5, 12, 30))],
      options,
    );
    const groups = groupBlocks(blocks, (threadId) => threadId, 0);
    expect(groups.map((group) => [group.start, group.end])).toEqual(
      blocks.map((block) => [block.start, block.end]),
    );
  });
});

describe("weeks and time sheets", () => {
  it("starts weeks on Monday at local midnight", () => {
    expect(startOfWeek(at(5, 15))).toBe(at(5, 0));
    expect(startOfWeek(at(11, 23, 59))).toBe(at(5, 0));
    expect(startOfWeek(at(4, 12))).toBe(new Date(2026, 8, 28).getTime());
  });

  it("keeps day boundaries on local midnight across a DST change", () => {
    // Toronto leaves daylight time on Sunday, November 1, 2026.
    const days = dayBoundaries(new Date(2026, 9, 26).getTime(), 7);
    expect(days.map((t) => new Date(t).getHours())).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(days[7]! - days[0]!).toBe(7 * DAY_MS + HOUR_MS);
  });

  it("splits blocks across midnight in the time sheet", () => {
    const blocks = buildBlocks([turn(at(5, 23), at(6, 1, 30))], {
      ...options,
      to: addDays(from, 7),
    });
    const [row] = buildTimesheet(blocks, dayBoundaries(from, 7));
    expect(row!.dayMs.slice(0, 3)).toEqual([HOUR_MS, 1.5 * HOUR_MS, 0]);
    expect(row!.totalMs).toBe(2.5 * HOUR_MS);
  });

  it("formats durations and decimal hours", () => {
    expect(formatDuration(0)).toBe("");
    expect(formatDuration(45 * MINUTE_MS)).toBe("45m");
    expect(formatDuration(2 * HOUR_MS)).toBe("2h");
    expect(formatDuration(135 * MINUTE_MS)).toBe("2h 15m");
    expect(formatHours(0)).toBe("");
    expect(formatHours(75 * MINUTE_MS)).toBe("1.25");
    expect(formatHours(3 * HOUR_MS)).toBe("3");
  });
});
