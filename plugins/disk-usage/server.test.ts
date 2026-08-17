import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin, { scanSchema } from "./server";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bb-disk-usage-"));
  await mkdir(join(root, "big"));
  await writeFile(join(root, "big", "blob.bin"), Buffer.alloc(256 * 1024, 1));
  await mkdir(join(root, "small"));
  await writeFile(join(root, "small", "note.txt"), "hello");
  await writeFile(join(root, "loose.bin"), Buffer.alloc(64 * 1024, 2));
  await symlink(join(root, "big"), join(root, "link"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function loadPlugin() {
  const host = createFakePluginHost({ pluginId: "disk-usage" });
  await plugin(host.bb);
  return host;
}

describe("Disk Usage", () => {
  it("scans a directory over RPC with recursive per-child sizes", async () => {
    const { harness } = await loadPlugin();
    const result = scanSchema.parse(await harness.callRpc("scan", { path: root }));

    expect(result.path).toBe(root);
    expect(result.parentPath).toBe(tmpdir());
    expect(result.truncated).toBe(false);
    // big/ (256K), loose.bin (64K), small/ (5B), link (0B, never followed)
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "big",
      "loose.bin",
      "small",
      "link",
    ]);
    expect(result.entries[0]).toMatchObject({ kind: "directory", entryCount: 1 });
    expect(result.entries[0]!.bytes).toBeGreaterThanOrEqual(256 * 1024);
    expect(result.entries[1]).toMatchObject({ kind: "file", entryCount: 0 });
    expect(result.entries[3]).toMatchObject({ name: "link", kind: "other", bytes: 0 });
    // 4 top-level entries + blob.bin + note.txt inside the two directories.
    expect(result.entryCount).toBe(6);
    const childSum = result.entries.reduce((sum, entry) => sum + entry.bytes, 0);
    expect(result.totalBytes).toBe(childSum);
  });

  it("rejects a path that is not a directory", async () => {
    const { harness } = await loadPlugin();
    await expect(harness.callRpc("scan", { path: join(root, "loose.bin") })).rejects.toThrow(
      /Not a directory/,
    );
  });

  it("registers the disk-usage CLI with human and JSON output", async () => {
    const { harness } = await loadPlugin();
    expect(harness.registrations.cli?.name).toBe("disk-usage");

    const human = await harness.runCli([root, "--top", "2"]);
    expect(human).toMatchObject({ exitCode: 0 });
    expect(human.stdout).toContain(root);
    expect(human.stdout).toContain("big/");
    expect(human.stdout).not.toContain("small/");
    expect(human.stdout).toContain("smaller entries");

    const json = await harness.runCli([root, "--json"]);
    expect(json.exitCode).toBe(0);
    expect(() => scanSchema.parse(JSON.parse(json.stdout))).not.toThrow();
  });

  it("rejects unknown options and unreadable paths on the CLI", async () => {
    const { harness } = await loadPlugin();

    const unknown = await harness.runCli(["--nope"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("Unknown option");

    const missing = await harness.runCli([join(root, "does-not-exist")]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("Cannot access");
  });
});
