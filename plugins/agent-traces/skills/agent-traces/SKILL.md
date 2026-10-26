---
name: agent-traces
description: Explain where an agent's time went in a bb thread (slowest calls, waits, subagents, child threads, failures), group calls across turns or a project's threads, compare two turns, or export a turn as OpenTelemetry or HTML. Use when asked why a turn was slow or what took the time.
---

# Agent Traces

Prefer the `agent_traces` tool when it is available. Otherwise use the
`bb agent-traces` command. Both default to the current thread and to its
last finished turn.

To point the user at a trace, the Traces page lives at
`/plugins/agent-traces/traces/<thread>`, with `/turns/<turn id>`,
`/commands`, or `/compare/<turn id>/<turn id>` after it.

## Read a trace

```sh
bb agent-traces show [thread] [--turn n|latest|previous] [--limit 8] [--json]
bb agent-traces turns [thread] [--json]
bb agent-traces commands [thread] [--project] [--threads 20] [--json]
bb agent-traces compare <a> <b> [thread] [--json]
```

- `show` splits the turn's time into phases and lists its slowest calls,
  subagents, child threads, and failures with exit codes.
- `commands` groups calls by what they ran (`pnpm test`, `git diff`,
  `node bench.mjs`), most total time first. `--project` reads the project's
  most recently active threads instead.
- `compare` shows where the time moved between two turns, such as before and
  after you changed a test script.

## Phases

| Phase          | Means                                                                     |
| -------------- | ------------------------------------------------------------------------- |
| Tools          | Commands and tool calls the agent waited on                               |
| Subagents      | Waiting on subagents with nothing else running                            |
| Thinking       | The agent's visible thinking                                              |
| Writing        | The agent streaming its reply                                             |
| Model          | Model time nothing else explains: response latency and writing tool calls |
| Waiting on you | Approvals, questions, and forms                                           |
| Compaction     | Summarizing the conversation                                              |
| Starting       | Between sending the prompt and the agent starting                         |

Background work (dev servers, background subagents, spawned threads) runs
alongside the agent, so it never counts against these phases.

## Export

```sh
bb agent-traces export [thread] [--turn n] [--format otlp|html]
bb agent-traces export [thread] [--turn n] --send
```

`otlp` prints the turn as OpenTelemetry OTLP/JSON. `--send` posts it to the
endpoint set with `bb plugin config agent-traces set otlpEndpoint <url>`.
Headers go in the secret `otlpHeaders` setting as `key=value` pairs, and
`autoExport` sends every turn as it finishes.

## Limits

- A turn's output only shows what each provider records. Codex reports many
  quick commands as 0ms, and OpenCode threads have no subagents.
- Cost is not shown.
