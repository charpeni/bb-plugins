# System Monitor plugin

Shows live CPU, memory, disk, load-average, and uptime data for the machine
running the bb server.

## Install

From the marketplace:

```sh
bb marketplace add git:github.com/charpeni/bb-plugins@main
bb plugin install system-monitor@charpeni
```

Or directly from this repository:

```sh
bb plugin install git:https://github.com/charpeni/bb-plugins.git@^0.1.0 --tag-prefix system-monitor/ --plugin system-monitor
```

Open **System Monitor** from the app sidebar, or query the same data from the
CLI:

```sh
bb system-monitor
bb system-monitor --json
```

The panel refreshes every five seconds. Because plugin backend code runs in the
bb server process, the values describe the server host, not a separately
enrolled execution machine.

## Develop

From the repository root:

```sh
bb plugin install ./plugins/system-monitor
bb plugin dev plugins/system-monitor
```
