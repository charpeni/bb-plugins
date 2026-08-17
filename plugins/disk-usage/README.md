# Disk Usage

See what's taking up disk space on the bb server host, `ncdu`-style: scan a
directory, get its immediate children sorted by recursive size, and drill down
until you find the culprit.

## What it does

- **Disk Usage panel** — a sidebar panel that scans a directory (default: the
  server home directory) and lists its children largest-first with share bars,
  breadcrumbs, drill-down by click, and a free-form path input.
- **`bb disk-usage` CLI** — the same scan for agents and scripts:

  ```sh
  bb disk-usage                     # scan the server home directory
  bb disk-usage /var --top 10       # the 10 largest entries under /var
  bb disk-usage ~/GitHub --json     # machine-readable output
  ```

## How sizes are measured

- Sizes are **allocated disk blocks** (`blocks × 512`), not apparent size, so
  sparse files are reported by what they actually occupy.
- Symlinks are **never followed** and count as zero bytes.
- Hardlinked files are counted **once** per scan.
- Unreadable entries (permissions, races) are skipped and counted, never fatal.
- A scan visits at most 500,000 entries; past that it stops descending and the
  result is flagged as truncated.

The scan runs on the machine hosting the bb server, so paths are server-host
paths — the same model as the System Monitor plugin.
