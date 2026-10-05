---
name: agent-calendar
description: Answer questions about what bb agents worked on and when, such as "what did my agents work on last week?" or "how much time went into project X?". Uses the `bb agent-calendar` time sheet and activity log.
---

# Agent Calendar

`bb agent-calendar` reports when bb threads had an agent turn running. Use it
for questions about past agent work: what was worked on, when, and for how
long.

## Commands

```sh
bb agent-calendar [timesheet] [--week this|last|YYYY-MM-DD] [--gap 15|30|60|120] [--json]
bb agent-calendar log [--day today|yesterday|YYYY-MM-DD | --week this|last|YYYY-MM-DD] [--gap 15|30|60|120] [--json]
```

- `timesheet` (default): hours per thread and day for one Monday-to-Sunday
  week, grouped by project.
- `log`: work blocks in time order for one day (default: today) or one week.
- `--week YYYY-MM-DD` selects the week that contains that date.
- `--gap` sets the idle time that still counts as one block (default 30
  minutes).
- `--json` prints thread IDs, project IDs, and epoch-millisecond times.

## Read the output correctly

- Times use the bb server's local time zone. The header names the zone.
- Blocks are rounded out to quarter hours. Do not report them as exact
  minutes.
- Hours add up per thread. Parallel agents can log more than 24 hours in a
  day. Say "agent hours" when you sum them.
- "Agent turns" is the unrounded time turns were running.
- Hidden threads are not included.

To see what happened in a thread, use its ID with `bb thread show <id>` or
`bb thread log <id>`.
