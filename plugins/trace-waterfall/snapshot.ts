/**
 * A turn's waterfall as one self-contained HTML file, to attach to a pull
 * request or bug report. Static: every subagent is expanded, details sit in
 * hover titles, and it follows the reader's light or dark preference.
 */
import { laneBreakdown, PHASE_LABELS, PHASES, turnStats, type Phase } from "./breakdown.js";
import { FAILED_COLOR, PHASE_COLORS } from "./palette.js";
import { formatDuration, formatTokens, type Span, type Turn } from "./trace.js";

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const percent = (value: number) => `${value.toFixed(3)}%`;

export function turnSnapshot(
  thread: { title: string },
  turn: Turn,
  now: number,
  generatedAt: number,
): string {
  const stats = turnStats(turn, now);
  const start = turn.start;
  const end = turn.end ?? Math.max(now, start);
  const total = Math.max(1, end - start);
  const x = (at: number) => (100 * (Math.min(Math.max(at, start), end) - start)) / total;

  const children = new Map<string | null, Span[]>();
  for (const span of turn.spans) {
    const list = children.get(span.parentId) ?? [];
    list.push(span);
    children.set(span.parentId, list);
  }

  const segments = (lane: string | null) =>
    laneBreakdown(turn, lane, now)
      .segments.map(
        (segment) =>
          `<i class="seg p-${segment.phase}" style="left:${percent(x(segment.start))};width:${percent(x(segment.end) - x(segment.start))}"></i>`,
      )
      .join("");

  const rows: string[] = [];
  const visit = (lane: string | null, depth: number) => {
    for (const span of children.get(lane) ?? []) {
      const spanEnd = span.end ?? end;
      const duration = spanEnd - span.start;
      const isLane = span.kind === "subagent" || span.kind === "thread";
      const bar = isLane
        ? `<i class="lane" style="left:${percent(x(span.start))};width:${percent(x(spanEnd) - x(span.start))}"></i>${span.kind === "subagent" ? segments(span.id) : ""}`
        : `<i class="bar ${span.status === "failed" ? "failed" : `k-${span.kind}`}${span.background ? " bg" : ""}" style="left:${percent(x(span.start))};width:max(2px,${percent(x(spanEnd) - x(span.start))})"></i>`;
      const extra = [
        span.tokens !== null ? `${formatTokens(span.tokens)} tok` : "",
        span.exitCode !== null && span.exitCode !== 0 ? `exit ${span.exitCode}` : "",
      ].filter(Boolean);
      const label = [formatDuration(duration), ...extra].join(" · ");
      const title = [span.name, span.detail, span.error ?? ""].filter(Boolean).join("\n");
      rows.push(
        `<div class="row" title="${escape(title)}"><div class="name" style="padding-left:${depth * 14}px"><b>${escape(span.name)}</b> <span>${escape(span.detail.split("\n")[0])}</span></div><div class="track">${bar}<em style="left:calc(${percent(x(spanEnd))} + 6px)">${escape(label)}</em></div></div>`,
      );
      if (isLane) visit(span.id, depth + 1);
    }
  };
  visit(null, 1);

  const breakdown = PHASES.filter((phase) => stats.phases[phase] > 0)
    .map((phase) => {
      const share = (100 * stats.phases[phase]) / Math.max(1, stats.durationMs);
      return `<span><i class="sw p-${phase}"></i>${PHASE_LABELS[phase]} ${Math.round(share)}% · ${formatDuration(stats.phases[phase])}</span>`;
    })
    .join("");
  const bar = PHASES.map(
    (phase) => `<i class="p-${phase}" style="flex:${stats.phases[phase]}"></i>`,
  ).join("");

  const colors = (mode: "light" | "dark") =>
    [
      ...PHASES.map((phase: Phase) => `.p-${phase}{background:${PHASE_COLORS[mode][phase]}}`),
      `.failed{background:${FAILED_COLOR[mode]}}`,
      `.bar{background:${PHASE_COLORS[mode].tools}}`,
      `.k-waiting{background:${PHASE_COLORS[mode].waiting}}`,
      `.k-startup{background:${PHASE_COLORS[mode].startup}}`,
      `.k-compaction{background:${PHASE_COLORS[mode].compaction}}`,
    ].join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(`Turn #${turn.index} · ${thread.title}`)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#2b2b2b;--muted:#6b6b6b;--line:#e4e4e2;--lane:#f1f1ef}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b1a;--fg:#e8e8e6;--muted:#a3a29d;--line:#33332f;--lane:#2a2a27}}
body{margin:0;padding:28px;background:var(--bg);color:var(--fg);font:13px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
h1{font-size:16px;margin:0 0 4px}p{margin:0 0 14px;color:var(--muted)}
.stats{display:flex;gap:28px;margin:12px 0 10px}.stats div b{display:block;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:500}.stats div span{font-size:17px}
.split{display:flex;height:10px;border-radius:5px;overflow:hidden;margin:6px 0 6px}.legend{display:flex;flex-wrap:wrap;gap:14px;color:var(--muted);font-size:11.5px;margin-bottom:18px}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.row{display:grid;grid-template-columns:minmax(220px,34%) 1fr;height:22px;align-items:center;border-bottom:1px solid transparent}.row:hover{background:var(--lane)}
.name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:10px}.name span{color:var(--muted)}
.track{position:relative;height:100%;border-left:1px solid var(--line)}
.track i{position:absolute;top:6px;height:10px;border-radius:2px}.track .seg{border-radius:0;opacity:.85}.track .lane{top:5px;height:12px;border:1px solid var(--muted);background:var(--lane);opacity:.6;box-sizing:border-box}
.bar.bg{opacity:.4}.track em{position:absolute;top:3px;font-style:normal;font-size:11px;color:var(--muted);white-space:nowrap}
footer{margin-top:18px;color:var(--muted);font-size:11px}
${colors("light")}
@media (prefers-color-scheme:dark){${colors("dark")}}
</style></head><body>
<h1>Turn #${turn.index} · ${escape(thread.title)}</h1>
<p>${escape(turn.prompt || "Continued on its own")}</p>
<div class="stats"><div><b>Duration</b><span>${formatDuration(stats.durationMs)}</span></div><div><b>Tool calls</b><span>${stats.toolCalls}</span></div><div><b>Subagents</b><span>${stats.subagents}</span></div><div><b>Child threads</b><span>${stats.childThreads}</span></div><div><b>Errors</b><span>${stats.errors}</span></div></div>
<div class="split">${bar}</div>
<div class="legend">${breakdown}</div>
<div class="row"><div class="name"><b>Agent</b> <span>main</span></div><div class="track"><i class="lane" style="left:0;width:100%"></i>${segments(null)}</div></div>
${rows.join("\n")}
<footer>Started ${new Date(start).toISOString()} · exported ${new Date(generatedAt).toISOString()} by Trace Waterfall for bb</footer>
</body></html>
`;
}
