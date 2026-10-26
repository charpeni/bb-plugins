/**
 * Turns a thread's raw bb events into a trace: one entry per top-level turn,
 * each holding the commands, tool calls, subagents, waits, and errors that
 * happened inside it, plus when its agents were visibly thinking or writing.
 *
 * Subagents run as turns of their own whose `turn/started` points at the
 * delegating tool call, so their work folds back into the turn that spawned
 * them. Shared by the server (which folds events incrementally) and the app.
 */
import { oneLine, record, text, type Json } from "./util.js";

export const TRACE_CHANNEL = "agent-traces.changed";

/** The only event types the trace reads, so the server can filter history. */
export const TRACE_EVENT_TYPES = [
  "client/turn/requested",
  "turn/started",
  "turn/input/accepted",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
  "system/interaction/lifecycle",
  "provider/error",
  "system/error",
  "system/thread/interrupted",
] as const;

export const SPAN_KINDS = [
  "command",
  "tool",
  "read",
  "edit",
  "search",
  "web",
  "subagent",
  "background",
  "thread",
  "waiting",
  "compaction",
  "startup",
  "error",
] as const;
export const STATUSES = ["running", "completed", "failed", "interrupted"] as const;
export const ACTIVITY_KINDS = ["thinking", "writing"] as const;

export type SpanKind = (typeof SPAN_KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface Span {
  id: string;
  /** The subagent or child thread this ran inside, or null for the turn's own agent. */
  parentId: string | null;
  kind: SpanKind;
  name: string;
  detail: string;
  start: number;
  /** Null while it runs. */
  end: number | null;
  status: Status;
  /** Runs alongside its agent instead of blocking it, like a dev server or a background subagent. */
  background: boolean;
  /** Tokens a subagent has reported so far; null when the provider reports none. */
  tokens: number | null;
  /** The command's exit code, when it reported one. */
  exitCode: number | null;
  /** What went wrong, for failed or interrupted spans. */
  error: string | null;
  /** The tool call that launched this background task. */
  launchedBy: string | null;
  /** The event that started the span. */
  seq: number;
  /** The event that ended it, which carries its output. */
  endSeq: number | null;
  /** The closest chat message to jump to, as bb's `?msg=` sequence. */
  chatSeq: number | null;
}

/** When an agent was visibly thinking or writing its reply. */
export interface Activity {
  id: string;
  /** The subagent it belongs to, or null for the turn's own agent. */
  lane: string | null;
  kind: ActivityKind;
  start: number;
  end: number | null;
}

export interface Turn {
  id: string;
  /** 1-based position among the thread's top-level turns. */
  index: number;
  prompt: string;
  /** The thread that sent the prompt, or `bb` for bb's own notices; null when the user did. */
  sender: string | null;
  start: number;
  /** Null while it runs. */
  end: number | null;
  status: Status;
  spans: Span[];
  activity: Activity[];
  /** The prompt, as bb's `#msg=` sequence. A queued prompt comes before `firstSeq`. */
  requestSeq: number | null;
  /**
   * The stretch of history the turn ran over, from its `turn/started` to its
   * `turn/completed`. Turns never overlap here, so a message's sequence finds
   * its turn even when background work reported into an earlier one later.
   */
  firstSeq: number;
  lastSeq: number;
}

/** The slice of a bb thread event row the trace reads. */
export interface TraceEvent {
  seq: number;
  createdAt: number;
  type: string;
  scope: { kind: string; turnId?: string };
  data: unknown;
}

const MAX_TEXT = 160;
const MAX_ERROR = 300;
// Commands keep their lines and more length: the details pane shows them whole.
const MAX_COMMAND = 1_000;
// Shorter startups are just the provider's own latency.
const MIN_STARTUP_MS = 300;
// After this long without a single event, nothing in the thread is still running.
const STALE_MS = 6 * 60 * 60 * 1_000;
const SKIPPED_ITEMS = new Set(["userMessage", "plan", "planSteps"]);
const ACTIVITY_ITEMS: Record<string, ActivityKind> = {
  reasoning: "thinking",
  agentMessage: "writing",
};
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

interface Request {
  prompt: string;
  sender: string | null;
  seq: number;
  at: number;
}
type TurnState = Omit<Turn, "spans" | "activity"> & {
  spanIds: string[];
  activityIds: string[];
  /** The turn's own agent's replies, oldest first, for chat links. */
  messages: Array<{ seq: number; at: number }>;
  /** When the turn last had an event, for turns that never finished. */
  lastAt: number;
};

function clipCommand(value: string): string {
  const command = value.trim();
  return command.length > MAX_COMMAND ? `${command.slice(0, MAX_COMMAND - 1)}…` : command;
}

function clip(value: string, max = MAX_TEXT): string {
  return oneLine(value, max);
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function itemStatus(value: unknown): Status {
  if (value === "pending") return "running";
  if (value === "failed" || value === "interrupted") return value;
  return "completed";
}

/** Codex wraps commands in `/bin/bash -lc "…"`; show what actually ran. */
function unwrapCommand(command: unknown): string {
  const raw = Array.isArray(command) ? command.map(text).join(" ") : text(command);
  const wrapped = /^\/bin\/(?:ba|z)?sh -lc (["'])([\s\S]*)\1$/.exec(raw.trim());
  return wrapped ? wrapped[2] : raw;
}

const SETUP_COMMANDS = new Set(["cd", "export", "set", "source", ".", "mkdir", "true", ":"]);
const SHELL_KEYWORDS = new Set(["for", "while", "until", "if", "case", "do", "then", "{", "("]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// A heredoc's body is data, not commands to name the span after. The rest of
// its first line stays (`cat <<EOF > file`, `cat <<EOF | kubectl apply -f -`),
// and the marker becomes a `<<…` word that no heredoc pattern matches again.
const HEREDOC =
  /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
// A heredoc whose terminator was cut off, as in a clipped command, runs to the end.
const UNTERMINATED_HEREDOC = /<<-?[ \t]*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1([^\n]*)\n[\s\S]*$/;
const HEREDOC_WORD = "<<…";
const THREAD_MESSAGE_PREFIX = /^\s*\[bb message from thread:([^\]\s]+)\]\s*/;
// bb's own notices, such as a spawned thread finishing, arrive as prompts too.
const SYSTEM_MESSAGE_PREFIX = /^\s*\[bb system\]\s*/;
/** The sender of a prompt that bb itself sent. */
export const BB_SENDER = "bb";

/**
 * `cat > file`, `echo … > file`, and `tee` only write a file for the next
 * step, and `cat <<EOF | …` only hands text to the next program.
 */
function writesFile(words: string[]): boolean {
  if (words[0] === "tee") return true;
  if (words[0] === "cat" && words.includes(HEREDOC_WORD)) return true;
  return ["cat", "echo", "printf"].includes(words[0]) && words.some((word) => word.startsWith(">"));
}

/**
 * Splits a command line into simple commands, each a list of words, the way a
 * shell would: quotes, `$(…)`, backticks, and line continuations keep their
 * contents together, and `&&`, `||`, `|`, `;`, `&`, and newlines separate.
 */
export function shellCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (char === "'") {
      const close = command.indexOf(char, index + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(index + 1, end);
      inWord = true;
      index = end;
    } else if (char === '"') {
      // Inside double quotes, a backslash escapes `"`, `\\`, `$`, and backticks.
      let end = index + 1;
      for (; end < command.length && command[end] !== '"'; end++) {
        if (command[end] === "\\" && '"\\$`'.includes(command[end + 1] ?? "x")) end++;
        word += command[end] ?? "";
      }
      inWord = true;
      index = end;
    } else if ((char === "$" && next === "(") || char === "`") {
      // Command substitution stays one word, nested parentheses included.
      let depth = 0;
      let end = index;
      for (; end < command.length; end++) {
        const current = command[end];
        if (char === "`" ? current === "`" && end > index : current === ")" && --depth === 0) break;
        if (char !== "`" && current === "(") depth++;
      }
      word += command.slice(index, end + 1);
      inWord = true;
      index = end;
    } else if (char === "\\") {
      if (next !== "\n") {
        word += next ?? "";
        inWord = true;
      }
      index++;
    } else if (char === "&" && (command[index - 1] === ">" || next === ">")) {
      // A redirection such as `2>&1` or `&>`, not a separator.
      word += char;
      inWord = true;
    } else if (char === "\n" || char === ";" || char === "&" || char === "|") {
      endCommand();
      if ((char === "&" || char === "|") && next === char) index++;
    } else if (/\s/.test(char)) {
      endWord();
    } else if ((char === "(" || char === ")" || char === "{" || char === "}") && !inWord) {
      endCommand();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/**
 * The words of the part of a command line that matters, past `cd x &&`,
 * `VAR=value`, and file setup. Empty for a shell loop or conditional.
 */
export function commandWords(command: string): string[] {
  for (const words of shellCommands(
    command
      .replace(HEREDOC, `${HEREDOC_WORD}$3`)
      .replace(UNTERMINATED_HEREDOC, `${HEREDOC_WORD}$2`),
  )) {
    const meaningful = words.filter((word) => !ASSIGNMENT.test(word));
    const program = meaningful[0];
    if (
      !program ||
      program.startsWith("-") ||
      SETUP_COMMANDS.has(program) ||
      writesFile(meaningful)
    )
      continue;
    // A loop, a conditional, or a function definition (`spawn() {`) is shell code, not one program.
    return SHELL_KEYWORDS.has(program) || program.endsWith("()") ? [] : meaningful;
  }
  return [];
}

/** The program a command line is about. */
function programOf(command: string): string {
  const [program] = commandWords(command);
  return (program && basename(program)) || "shell";
}

type Description = Pick<Span, "kind" | "name" | "detail"> & { background?: boolean };

function describe(item: Json): Description {
  const title = text(record(item.presentation).title);
  switch (item.type) {
    case "commandExecution": {
      const command = unwrapCommand(item.command);
      return { kind: "command", name: programOf(command), detail: clipCommand(command) };
    }
    case "fileRead":
      return { kind: "read", name: "Read", detail: basename(text(item.path)) || title };
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((change) => basename(text(record(change).path))).filter(Boolean);
      return { kind: "edit", name: "Edit", detail: clip(paths.join(", ")) || title };
    }
    case "search":
      return { kind: "search", name: "Search", detail: clip(text(item.query) || title) };
    case "webSearch":
      return { kind: "web", name: "Web search", detail: clip(text(item.query) || title) };
    case "webFetch":
      return { kind: "web", name: "Web fetch", detail: clip(text(item.url) || title) };
    case "contextCompaction":
      return { kind: "compaction", name: "Compaction", detail: "Compacting the context" };
    case "delegation":
      return {
        kind: "subagent",
        name: clip(text(item.label)) || "Subagent",
        detail: item.background === true ? "background subagent" : "subagent",
        background: item.background === true,
      };
    case "backgroundTask":
      return {
        kind: "background",
        name: "Background",
        detail: clip(text(item.description) || title),
        background: true,
      };
    case "toolCall": {
      const tool = text(item.tool) || "tool";
      if (SUBAGENT_TOOLS.has(tool)) {
        const args = record(item.arguments);
        const background = args.run_in_background === true;
        return {
          kind: "subagent",
          name: clip(text(args.description) || title) || "Subagent",
          detail: background ? "background subagent" : "subagent",
          background,
        };
      }
      return { kind: "tool", name: tool, detail: clip(title || text(item.server)) };
    }
    default: {
      const label = record(record(item.presentation).label);
      return {
        kind: "tool",
        name: text(label.completed) || text(item.type) || "tool",
        detail: clip(title),
      };
    }
  }
}

/** What an interaction asked of the user, in a few words. */
function describeInteraction(payload: Json): Pick<Span, "name" | "detail"> {
  const kind = text(payload.kind);
  const label = record(record(payload.presentation).label);
  if (kind === "user_question") {
    const [first] = Array.isArray(payload.questions) ? payload.questions.map(record) : [];
    return {
      name: "Question",
      detail: clip(
        text(first?.prompt) || text(first?.shortLabel) || "The agent asked you a question",
      ),
    };
  }
  const fallback =
    kind.includes("permission") || kind.includes("approval") ? "Approval" : "Waiting for you";
  return {
    name: clip(text(payload.title) || fallback),
    detail: clip(text(label.pending) || kind.replace(/_/g, " ")),
  };
}

function errorOf(item: Json): string | null {
  const error = item.error;
  const message = typeof error === "string" ? error : text(record(error).message);
  return message ? clip(message, MAX_ERROR) : null;
}

/**
 * Folds thread events into turns. Events at or below the last folded `seq`
 * are ignored, so re-applying an overlapping page is harmless.
 */
export class TraceBuilder {
  lastSeq = 0;
  /** When the thread's latest event happened. */
  private lastEventAt = 0;
  private readonly turns = new Map<string, TurnState>();
  /** Any turn id, including subagent turns, to the top-level turn it belongs to. */
  private readonly rootTurn = new Map<string, string>();
  /** A subagent turn to the tool call that started it. */
  private readonly turnParent = new Map<string, string>();
  private readonly spans = new Map<string, Span>();
  /** A span to the top-level turn it belongs to. */
  private readonly spanTurn = new Map<string, string>();
  private readonly activities = new Map<string, Activity>();
  private readonly requests = new Map<string, Request>();
  /** Subagent tokens that arrived before their span. */
  private readonly pendingTokens = new Map<string, number>();
  /** Subagents whose agent is still working after its tool call returned. */
  private readonly runningAgents = new Set<string>();
  /**
   * A span or activity to the tool call it ran under. Its subagent is looked
   * up when the trace is read, so a call recorded before its subagent's own
   * tool call still nests under it.
   */
  private readonly via = new Map<string, string>();
  /** The top-level turn that is running, for events bb records outside any turn. */
  private activeTurn: string | null = null;

  apply(events: readonly TraceEvent[]): void {
    for (const event of events) {
      if (event.seq <= this.lastSeq) continue;
      this.lastSeq = event.seq;
      this.lastEventAt = Math.max(this.lastEventAt, event.createdAt);
      this.fold(event);
    }
  }

  /**
   * Top-level turns, oldest first. A call cannot outlive its finished turn
   * without saying so, and after hours of silence nothing is still running:
   * those close as interrupted instead of growing with the clock.
   */
  snapshot(now?: number): Turn[] {
    const stale = now !== undefined && now - this.lastEventAt > STALE_MS;
    return [...this.turns.values()].map(({ spanIds, activityIds, messages, lastAt, ...turn }) => {
      const end = turn.end ?? (stale ? lastAt : null);
      const close = <T extends { start: number; end: number | null }>(
        item: T,
        background: boolean,
      ): T =>
        item.end !== null || end === null || (background && !stale)
          ? item
          : { ...item, end: Math.max(item.start, end) };
      return {
        ...turn,
        end,
        status: turn.end === null && stale ? "interrupted" : turn.status,
        spans: spanIds.flatMap((id) => {
          const stored = this.spans.get(id);
          if (!stored) return [];
          const span = close(stored, stored.background);
          const closed = span !== stored;
          // The reply that followed the span, else the prompt that started the turn.
          const after = span.end ?? span.start;
          const reply = messages.find((message) => message.at >= after);
          return [
            {
              ...span,
              parentId: this.subagentLane(this.via.get(id) ?? ""),
              status: closed ? "interrupted" : span.status,
              error: closed ? (span.error ?? "Never reported finishing") : span.error,
              chatSeq: reply?.seq ?? turn.requestSeq,
            },
          ];
        }),
        activity: activityIds.flatMap((id) => {
          const activity = this.activities.get(id);
          if (!activity) return [];
          return [close({ ...activity, lane: this.subagentLane(this.via.get(id) ?? "") }, false)];
        }),
      };
    });
  }

  private fold(event: TraceEvent): void {
    const data = record(event.data);
    const turnId = event.scope.turnId;
    switch (event.type) {
      case "client/turn/requested": {
        const input = Array.isArray(data.input) ? data.input : [];
        const raw = input.map((part) => text(record(part).text)).find(Boolean) ?? "";
        // bb prefixes messages from other threads and its own notices; the sender is shown on its own.
        const prefix = THREAD_MESSAGE_PREFIX.exec(raw);
        const system = prefix ? null : SYSTEM_MESSAGE_PREFIX.exec(raw);
        const requestId = text(data.requestId);
        if (requestId) {
          this.requests.set(requestId, {
            prompt: clip(raw.slice((prefix ?? system)?.[0].length ?? 0)),
            sender: text(data.senderThreadId) || prefix?.[1] || (system ? BB_SENDER : null),
            seq: event.seq,
            at: event.createdAt,
          });
        }
        return;
      }
      case "turn/started":
        if (turnId) this.startTurn(turnId, text(data.parentToolCallId), event);
        return;
      case "turn/input/accepted": {
        const turn = turnId ? this.turns.get(turnId) : undefined;
        const request = this.requests.get(text(data.clientRequestId));
        if (turn && request && turn.requestSeq === null) this.acceptRequest(turn, request, event);
        return;
      }
      case "turn/completed": {
        const turn = turnId ? this.turns.get(turnId) : undefined;
        if (!turn) return;
        this.touch(turn, event.seq, event.createdAt);
        turn.end = event.createdAt;
        turn.status = itemStatus(data.status);
        if (this.activeTurn === turn.id) this.activeTurn = null;
        return;
      }
      case "item/started":
      case "item/completed":
      case "item/backgroundTask/progress":
      case "item/backgroundTask/completed":
        this.foldItem(turnId, record(data.item), event);
        return;
      case "system/interaction/lifecycle":
        this.foldInteraction(turnId, record(data.interaction), event);
        return;
      case "provider/error":
        this.addMarker(turnId, event, {
          name: "Provider error",
          detail: [text(data.message), text(data.detail)].filter(Boolean).join(": "),
          status: "failed",
        });
        return;
      case "system/error":
        this.addMarker(turnId, event, {
          name: "bb error",
          detail: text(data.message) || text(data.code),
          status: "failed",
        });
        return;
      case "system/thread/interrupted":
        this.addMarker(turnId, event, {
          name: "Stopped",
          detail: text(data.reason) === "manual-stop" ? "Stopped by hand" : text(data.reason),
          status: "interrupted",
        });
        return;
    }
  }

  private touch(turn: TurnState, seq: number, at: number): void {
    // Background work reporting after the turn ended does not stretch it.
    if (turn.end === null) turn.lastSeq = Math.max(turn.lastSeq, seq);
    turn.lastAt = Math.max(turn.lastAt, at);
  }

  /** The top-level turn an event belongs to, by its scope or by what was running. */
  private turnFor(turnId: string | undefined): TurnState | undefined {
    const root = turnId ? this.rootTurn.get(turnId) : this.activeTurn;
    return root ? this.turns.get(root) : undefined;
  }

  private startTurn(turnId: string, parentToolCallId: string, event: TraceEvent): void {
    // A subagent's turn can be recorded before the tool call that started it;
    // it still belongs to the turn that is running.
    const parentTurn = parentToolCallId
      ? (this.spanTurn.get(parentToolCallId) ?? this.activeTurn ?? undefined)
      : undefined;
    if (parentTurn) {
      this.rootTurn.set(turnId, parentTurn);
      this.turnParent.set(turnId, parentToolCallId);
      return;
    }
    if (this.turns.has(turnId)) return;
    this.rootTurn.set(turnId, turnId);
    this.activeTurn = turnId;
    this.turns.set(turnId, {
      id: turnId,
      index: this.turns.size + 1,
      prompt: "",
      sender: null,
      start: event.createdAt,
      end: null,
      status: "running",
      requestSeq: null,
      firstSeq: event.seq,
      lastSeq: event.seq,
      spanIds: [],
      activityIds: [],
      messages: [],
      lastAt: event.createdAt,
    });
  }

  /**
   * Links the prompt to its turn, and counts the wait between sending it and
   * the agent starting as part of the turn, unless an earlier turn held it up.
   */
  private acceptRequest(turn: TurnState, request: Request, event: TraceEvent): void {
    turn.prompt = request.prompt;
    turn.sender = request.sender;
    turn.requestSeq = request.seq;
    this.touch(turn, request.seq, request.at);
    const previous = [...this.turns.values()].find((other) => other.index === turn.index - 1);
    const from = Math.max(request.at, previous?.end ?? -Infinity);
    if (turn.start - from < MIN_STARTUP_MS) return;
    const id = `startup:${turn.id}`;
    this.spans.set(id, {
      ...this.blankSpan(id, request.seq),
      kind: "startup",
      name: "Starting",
      detail: "Getting the agent ready for the prompt",
      start: from,
      end: turn.start,
      status: "completed",
      endSeq: event.seq,
    });
    this.spanTurn.set(id, turn.id);
    turn.spanIds.unshift(id);
    turn.start = from;
  }

  private blankSpan(id: string, seq: number): Span {
    return {
      id,
      parentId: null,
      kind: "tool",
      name: "",
      detail: "",
      start: 0,
      end: null,
      status: "running",
      background: false,
      tokens: null,
      exitCode: null,
      error: null,
      launchedBy: null,
      seq,
      endSeq: null,
      chatSeq: null,
    };
  }

  private addSpan(turn: TurnState, span: Span): void {
    this.spans.set(span.id, span);
    this.spanTurn.set(span.id, turn.id);
    turn.spanIds.push(span.id);
  }

  private addMarker(
    turnId: string | undefined,
    event: TraceEvent,
    marker: Pick<Span, "name" | "detail" | "status">,
  ): void {
    const turn = this.turnFor(turnId);
    if (!turn) return;
    this.touch(turn, event.seq, event.createdAt);
    this.addSpan(turn, {
      ...this.blankSpan(`marker:${event.seq}`, event.seq),
      kind: "error",
      ...marker,
      detail: clip(marker.detail, MAX_ERROR),
      error: clip(marker.detail, MAX_ERROR) || null,
      start: event.createdAt,
      end: event.createdAt,
      endSeq: event.seq,
    });
  }

  /** Approvals, questions, and other forms that wait on the user. */
  private foldInteraction(turnId: string | undefined, interaction: Json, event: TraceEvent): void {
    const interactionId = text(interaction.id);
    if (!interactionId) return;
    const id = `interaction:${interactionId}`;
    const status = text(interaction.status);
    // Still waiting: asked, or answered and on its way to the agent.
    const waiting = status === "pending" || status === "resolving";
    const existing = this.spans.get(id);
    if (existing) {
      if (waiting || existing.end !== null) return;
      const turn = this.turns.get(this.spanTurn.get(id) ?? "");
      if (turn) this.touch(turn, event.seq, event.createdAt);
      existing.end = Math.max(event.createdAt, existing.start);
      existing.endSeq = event.seq;
      existing.status = status === "resolved" ? "completed" : "interrupted";
      existing.error = status === "resolved" ? null : text(interaction.statusReason) || status;
      return;
    }
    const turn = this.turnFor(turnId);
    if (status !== "pending" || !turn) return;
    this.touch(turn, event.seq, event.createdAt);
    this.addSpan(turn, {
      ...this.blankSpan(id, event.seq),
      kind: "waiting",
      ...describeInteraction(record(interaction.payload)),
      start: event.createdAt,
    });
  }

  private foldItem(turnId: string | undefined, item: Json, event: TraceEvent): void {
    const id = text(item.id);
    const type = text(item.type);
    if (!id || SKIPPED_ITEMS.has(type)) return;
    const parentToolCallId =
      text(item.parentToolCallId) || (turnId && this.turnParent.get(turnId)) || "";
    // Background tasks report completion outside any turn; find their turn
    // through the span itself or the tool call that started it.
    const root = turnId
      ? this.rootTurn.get(turnId)
      : (this.spanTurn.get(id) ?? this.spanTurn.get(parentToolCallId));
    const turn = root ? this.turns.get(root) : undefined;
    if (!turn) return;
    this.touch(turn, event.seq, event.createdAt);

    if (type in ACTIVITY_ITEMS) {
      this.foldActivity(turn, id, ACTIVITY_ITEMS[type], parentToolCallId, event);
      return;
    }
    if (type === "backgroundTask" && item.taskType === "local_agent") {
      this.foldSubagentTask(parentToolCallId, item, event);
      return;
    }
    // Only completions of other background tasks matter; their progress does not.
    if (event.type === "item/backgroundTask/progress") return;

    const finished = event.type !== "item/started";
    const existing = this.spans.get(id);
    if (existing) {
      if (!finished) return;
      // Its call returned while its agent works on: the agent runs in the background.
      if (this.runningAgents.has(id)) existing.background = true;
      else this.finish(existing, item, event);
      return;
    }
    const { background = false, ...description } = describe(item);
    const launcher = parentToolCallId ? this.spans.get(parentToolCallId) : undefined;
    if (parentToolCallId) this.via.set(id, parentToolCallId);
    const span: Span = {
      ...this.blankSpan(id, event.seq),
      parentId: this.subagentLane(parentToolCallId),
      ...description,
      background,
      start: event.createdAt,
      tokens: this.pendingTokens.get(id) ?? null,
      launchedBy: background && launcher && launcher.kind !== "subagent" ? launcher.id : null,
    };
    this.pendingTokens.delete(id);
    this.addSpan(turn, span);
    if (finished) this.finish(span, item, event);
  }

  private finish(span: Span, item: Json, event: TraceEvent): void {
    span.end = Math.max(event.createdAt, span.start);
    span.endSeq = event.seq;
    span.status = itemStatus(item.status);
    if (typeof item.exitCode === "number") span.exitCode = item.exitCode;
    span.error = errorOf(item) ?? span.error;
  }

  private foldActivity(
    turn: TurnState,
    id: string,
    kind: ActivityKind,
    parentToolCallId: string,
    event: TraceEvent,
  ): void {
    const lane = this.subagentLane(parentToolCallId);
    const existing = this.activities.get(id);
    const finished = event.type === "item/completed";
    if (parentToolCallId) this.via.set(id, parentToolCallId);
    if (existing) {
      if (finished) existing.end = Math.max(event.createdAt, existing.start);
    } else {
      this.activities.set(id, {
        id,
        lane,
        kind,
        start: event.createdAt,
        end: finished ? event.createdAt : null,
      });
      turn.activityIds.push(id);
    }
    // Only the turn's own agent writes the replies chat links point at.
    if (finished && kind === "writing" && !parentToolCallId) {
      turn.messages.push({ seq: event.seq, at: event.createdAt });
    }
  }

  /** The nearest enclosing subagent, so spans nest only under subagents. */
  private subagentLane(parentToolCallId: string): string | null {
    let cursor = parentToolCallId;
    for (let depth = 0; cursor && depth < 32; depth++) {
      if (this.spans.get(cursor)?.kind === "subagent") return cursor;
      cursor = this.via.get(cursor) ?? "";
    }
    return null;
  }

  /**
   * A subagent's agent task: its tool call can return at once while the agent
   * keeps working in the background, so the task says when it really ends.
   */
  private foldSubagentTask(spanId: string, item: Json, event: TraceEvent): void {
    this.recordSubagentUsage(spanId, record(item.usage));
    const span = this.spans.get(spanId);
    if (!span) return;
    const status = itemStatus(item.status);
    const finished = event.type === "item/backgroundTask/completed" || status !== "running";
    if (!finished) {
      // Its call already returned, so the agent runs in the background.
      if (span.endSeq !== null && !this.runningAgents.has(spanId)) span.background = true;
      this.runningAgents.add(spanId);
      span.end = null;
      span.status = "running";
      return;
    }
    this.runningAgents.delete(spanId);
    span.end = Math.max(event.createdAt, span.end ?? span.start);
    span.endSeq = event.seq;
    span.status = status;
  }

  private recordSubagentUsage(spanId: string, usage: Json): void {
    const tokens = usage.totalTokens;
    if (!spanId || typeof tokens !== "number") return;
    const span = this.spans.get(spanId);
    if (span) span.tokens = tokens;
    else this.pendingTokens.set(spanId, tokens);
  }
}

export function formatDuration(ms: number): string {
  // Each unit is picked after rounding, so 59.6s reads "1m 00s", not "60s".
  if (Math.round(ms) < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  if (Math.round(ms / 100) < 100) return `${(ms / 1_000).toFixed(1)}s`;
  if (Math.round(ms / 1_000) < 60) return `${Math.round(ms / 1_000)}s`;
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 3_600) {
    return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (Math.round(tokens / 100) < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}
