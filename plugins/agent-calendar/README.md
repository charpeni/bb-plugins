# Agent Calendar plugin

Shows what your agents worked on and when, the way you would check your own
calendar: a weekly **calendar** of work blocks and a **time sheet** of hours per
thread and day.

## Install

Directly from this repository:

```sh
bb plugin install git:https://github.com/charpeni/bb-plugins.git@^0.1.0 --tag-prefix agent-calendar/ --plugin agent-calendar
```

Open **Agent Calendar** from the app sidebar, or ask the CLI:

```sh
bb agent-calendar                      # this week's time sheet
bb agent-calendar --week last          # last week's time sheet
bb agent-calendar log                  # today's work blocks, in order
bb agent-calendar log --day yesterday --json
```

## How blocks are built

A thread is on the calendar only while an agent turn is running. The plugin
reads each thread's `turn/started` and `turn/completed` events, then:

1. Merges a thread's turns separated by at most the **merge gap** (30 minutes
   by default; 15m, 1h, and 2h are available). A thread that goes on and off
   for an hour is one block. A 30-minute session in the morning and another
   three hours later are two blocks.
2. Rounds each block out to the surrounding quarter hours, like a person's
   calendar entry. A two-minute turn takes a 15-minute slot.

The calendar shows a **Day**, **3 days** (ending on the selected day), or
**Week** at a time. Click a day's header, in the calendar or the time sheet,
to focus on that day. Each thread is its own entry, colored by its project.
Switch to **Projects** to merge a project's parallel threads into one entry
("monorepo, 9:00–11:45, 17 threads"); click it to list its threads and open
one. The time sheet lists every thread under its project, with decimal hours
per day, and can copy itself as CSV.

The eight projects with the most agent time over the last 30 days get the
palette's colors, in bb's project order, so a project keeps its color in every
view. Other projects share a neutral color.

Hours count each thread, so five agents working for one hour count as five
hours. "Agent turns" is the time turns were running, before merging and
rounding.

## Data

The plugin indexes turn history into its own SQLite database. It backfills all
visible threads, including archived ones, when it loads. After that it only
re-reads threads whose `updatedAt` changed, and thread lifecycle events keep
the calendar live. Hidden threads (background workers) are not shown. Deleted
threads drop out.

Times use the viewer's time zone in the app and the bb server's time zone in
the CLI. Weeks start on Monday.

The icon adapts the [Hugeicons](https://hugeicons.com) Calendar 03 glyph
(MIT), with three bars standing for parallel agent sessions.

## Develop

From the repository root:

```sh
bb plugin install ./plugins/agent-calendar
bb plugin dev plugins/agent-calendar
```
