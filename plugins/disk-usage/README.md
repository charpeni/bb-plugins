# Disk Usage

See what's taking up disk space on the bb server host, `ncdu`-style: scan a
directory, get its immediate children sorted by recursive size, and drill down
until you find the culprit.

<img width="2983" height="1607" alt="bettershot_1787007625230" src="https://github.com/user-attachments/assets/46b2e522-f47c-493a-a992-08ab1c930e05" />

## What it does

- **Disk Usage panel** — a sidebar panel that scans a directory (default: the
  server home directory) and lists its children largest-first with share bars,
  breadcrumbs, drill-down by click, and a free-form path input. While a scan
  runs, a live progress card streams entries visited, bytes so far, and the
  directory currently being walked.
- **Per-path cache** — the last result for each path is kept in memory, so
  drilling back up (or reopening the panel) is instant; the header shows the
  snapshot's age and **Rescan** forces a fresh walk. Concurrent requests for
  the same path join a single walk.
- **`bb disk-usage` CLI** — the same scan for agents and scripts:

  ```sh
  bb disk-usage                     # scan the server home directory
  bb disk-usage /var --top 10       # the 10 largest entries under /var
  bb disk-usage ~/GitHub --json     # machine-readable output
  bb disk-usage --refresh           # bypass the per-path cache
  ```

## How sizes are measured

- Sizes are **allocated disk blocks** (`blocks × 512`), not apparent size, so
  sparse files are reported by what they actually occupy.
- Symlinks are **never followed** and count as zero bytes.
- Hardlinked files are counted **once** per scan.
- Unreadable entries (permissions, races) are skipped and counted, never fatal.
- Directories are walked concurrently (bounded), and a scan visits at most
  500,000 entries; past that it stops descending and the result is flagged as
  truncated, with the budget spread across the tree rather than exhausted
  depth-first.

The scan runs on the machine hosting the bb server, so paths are server-host
paths — the same model as the System Monitor plugin.
