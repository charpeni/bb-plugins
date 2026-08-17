# System Monitor plugin

Shows live CPU, memory, disk, load-average, and uptime data for the machine
running the bb server, plus usage history charts over the last day, week, or
month.

<img width="2952" height="1102" alt="bettershot_1787008930979" src="https://github.com/user-attachments/assets/023c5632-18e5-497a-85c4-97019b071a53" />

## Install

From the marketplace:

```sh
bb marketplace add git:github.com/charpeni/bb-plugins@main
bb plugin install system-monitor@charpeni
```

Or directly from this repository:

```sh
bb plugin install git:https://github.com/charpeni/bb-plugins.git@^0.2.0 --tag-prefix system-monitor/ --plugin system-monitor
```

Open **System Monitor** from the app sidebar, or query the same data from the
CLI:

```sh
bb system-monitor
bb system-monitor --json
bb system-monitor history --range 7d
bb system-monitor history --range 30d --json
```

The panel refreshes every five seconds. Because plugin backend code runs in the
bb server process, the values describe the server host, not a separately
enrolled execution machine.

## History

While the plugin is loaded, a background service records a CPU/memory/disk
sample every 30 seconds into the plugin's own SQLite database and keeps 31
days of data. Each metric card embeds a sparkline of that history over three
ranges — **1D** (5-minute averages), **7D** (30-minute averages), and **30D**
(2-hour averages) — with the range average and peak below it and a hover
crosshair synced across the three cards. The selected range is remembered
across reloads, and `bb system-monitor history --json` exposes the exact
bucket values. Gaps where the bb server was not running are left as breaks
in the line rather than interpolated.

## Develop

From the repository root:

```sh
bb plugin install ./plugins/system-monitor
bb plugin dev plugins/system-monitor
```
