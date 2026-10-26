/**
 * Turns as OpenTelemetry traces, in the OTLP/JSON encoding any OTLP/HTTP
 * collector accepts (Jaeger, Honeycomb, Grafana Tempo, Langfuse, …). One
 * trace per turn, with ids derived from the thread and turn so exporting the
 * same turn twice updates rather than duplicates it.
 */
import { isToolCall, laneBreakdown } from "./breakdown.js";
import type { Span, Turn } from "./trace.js";
import type { ThreadInfo } from "./util.js";

type AnyValue = { stringValue: string } | { intValue: string } | { boolValue: boolean };
interface Attribute {
  key: string;
  value: AnyValue;
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status: { code: number; message?: string };
}
export interface OtlpTraces {
  resourceSpans: Array<{
    resource: { attributes: Attribute[] };
    scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtlpSpan[] }>;
  }>;
}

const SPAN_KIND_INTERNAL = 1;
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;
const MAX_ATTRIBUTE = 1_000;

function hash32(input: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2c1b3c6d) >>> 0;
  return (hash ^ (hash >>> 12)) >>> 0;
}

/** A stable, never-all-zero hex id: 16 bytes for traces, 8 for spans. */
export function hexId(input: string, bytes: 8 | 16): string {
  let id = "";
  for (let word = 0; word < bytes / 4; word++) {
    id += hash32(input, word * 0x9e3779b9)
      .toString(16)
      .padStart(8, "0");
  }
  return /^0+$/.test(id) ? `${id.slice(0, -1)}1` : id;
}

function nanos(ms: number): string {
  return `${Math.round(ms)}000000`;
}

function attributes(
  values: Record<string, string | number | boolean | null | undefined>,
): Attribute[] {
  return Object.entries(values).flatMap(([key, value]): Attribute[] => {
    if (value === null || value === undefined || value === "") return [];
    if (typeof value === "boolean") return [{ key, value: { boolValue: value } }];
    if (typeof value === "number") return [{ key, value: { intValue: String(Math.round(value)) } }];
    return [{ key, value: { stringValue: value.slice(0, MAX_ATTRIBUTE) } }];
  });
}

function spanName(span: Span): string {
  switch (span.kind) {
    case "subagent":
    case "thread":
      return `invoke_agent ${span.name}`;
    case "waiting":
      return `wait ${span.name}`;
    case "startup":
    case "compaction":
    case "error":
      return span.name;
    default:
      return `execute_tool ${span.name}`;
  }
}

function spanAttributes(span: Span, now: number): Attribute[] {
  const isTool = isToolCall(span);
  const isAgent = span.kind === "subagent" || span.kind === "thread";
  return attributes({
    "gen_ai.operation.name": isTool ? "execute_tool" : isAgent ? "invoke_agent" : undefined,
    "gen_ai.tool.name": isTool ? span.name : undefined,
    "gen_ai.agent.name": isAgent ? span.name : undefined,
    "process.command_line": span.kind === "command" ? span.detail : undefined,
    "process.exit.code": span.exitCode ?? undefined,
    "bb.span.kind": span.kind,
    "bb.span.detail": span.kind === "command" ? undefined : span.detail,
    "bb.span.background": span.background || undefined,
    "bb.span.running": span.end === null && now > span.start ? true : undefined,
    "bb.subagent.tokens": span.tokens ?? undefined,
    "bb.child_thread.id": span.kind === "thread" ? span.id.replace(/^thread:/, "") : undefined,
  });
}

/** One trace per turn, in a single OTLP/JSON request. */
export function toOtlp(
  thread: Pick<ThreadInfo, "id" | "title" | "projectId" | "providerId">,
  turns: readonly Turn[],
  now: number,
  version: string,
): OtlpTraces {
  const spans: OtlpSpan[] = [];
  for (const turn of turns) {
    const traceId = hexId(`${thread.id}/${turn.id}`, 16);
    const spanId = (key: string) => hexId(`${thread.id}/${turn.id}/${key}`, 8);
    const rootId = spanId("turn");
    const turnEnd = turn.end ?? Math.max(now, turn.start);
    spans.push({
      traceId,
      spanId: rootId,
      name: `turn #${turn.index}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanos(turn.start),
      endTimeUnixNano: nanos(turnEnd),
      attributes: attributes({
        "gen_ai.operation.name": "invoke_agent",
        "bb.turn.id": turn.id,
        "bb.turn.index": turn.index,
        "bb.turn.prompt": turn.prompt,
        "bb.turn.sender": turn.sender,
        "bb.turn.status": turn.status,
      }),
      status:
        turn.status === "failed"
          ? { code: STATUS_ERROR, message: "turn failed" }
          : { code: STATUS_UNSET },
    });
    // The model's own stretches of the main agent, inferred from what surrounds them.
    for (const segment of laneBreakdown(turn, null, now).segments) {
      if (segment.phase !== "thinking" && segment.phase !== "writing" && segment.phase !== "model")
        continue;
      spans.push({
        traceId,
        spanId: spanId(`phase:${segment.start}`),
        parentSpanId: rootId,
        name: `chat ${segment.phase}`,
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: nanos(segment.start),
        endTimeUnixNano: nanos(segment.end),
        attributes: attributes({
          "gen_ai.operation.name": "chat",
          "bb.phase": segment.phase,
          "bb.inferred": true,
        }),
        status: { code: STATUS_UNSET },
      });
    }
    for (const span of turn.spans) {
      spans.push({
        traceId,
        spanId: spanId(span.id),
        parentSpanId: span.parentId ? spanId(span.parentId) : rootId,
        name: spanName(span),
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: nanos(span.start),
        endTimeUnixNano: nanos(span.end ?? Math.max(now, span.start)),
        attributes: spanAttributes(span, now),
        status:
          span.status === "failed"
            ? { code: STATUS_ERROR, message: span.error ?? "failed" }
            : { code: STATUS_UNSET },
      });
    }
  }
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attributes({
            "service.name": "bb",
            "bb.thread.id": thread.id,
            "bb.thread.title": thread.title,
            "bb.project.id": thread.projectId,
            "bb.provider.id": thread.providerId,
          }),
        },
        scopeSpans: [{ scope: { name: "bb-plugin-trace-waterfall", version }, spans }],
      },
    ],
  };
}

/** Parses `OTEL_EXPORTER_OTLP_HEADERS`-style `key=value,key2=value2` text. */
export function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(/[,\n]/)) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key) continue;
    try {
      headers[key] = decodeURIComponent(value);
    } catch {
      headers[key] = value;
    }
  }
  return headers;
}
