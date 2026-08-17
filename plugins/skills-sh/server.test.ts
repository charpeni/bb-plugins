import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "./server";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync(
    "git",
    ["-c", "user.email=test@test", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args],
    { cwd },
  );
}

async function writeSkill(
  repo: string,
  relDir: string,
  name: string,
  body = "Instructions",
): Promise<void> {
  const dir = join(repo, relDir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill ${name}\n---\n${body}\n`,
  );
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

describe("bb-plugin-skills-sh", () => {
  let skillsRoot: string;
  let fixtureRepo: string;
  let harness: Awaited<ReturnType<typeof createFakePluginHost>>["harness"];

  async function runCli(argv: string[]) {
    return harness.behavior.runCli(argv);
  }

  beforeEach(async () => {
    skillsRoot = await mkdtemp(join(tmpdir(), "bb-skills-root-"));
    fixtureRepo = await mkdtemp(join(tmpdir(), "bb-skills-fixture-"));

    await writeSkill(fixtureRepo, "skills/alpha", "alpha", "Alpha v1");
    await writeFile(join(fixtureRepo, "skills/alpha/reference.md"), "extra file");
    await writeSkill(fixtureRepo, "skills/beta", "beta");
    await git(fixtureRepo, "init", "-b", "main");
    await git(fixtureRepo, "add", "-A");
    await git(fixtureRepo, "commit", "-m", "initial");

    const host = createFakePluginHost({
      pluginId: "skills-sh",
      settings: { skillsDir: skillsRoot },
    });
    harness = host.harness;
    await plugin(host.bb);
  });

  afterEach(async () => {
    await harness.lifecycle.dispose();
    await rm(skillsRoot, { recursive: true, force: true });
    await rm(fixtureRepo, { recursive: true, force: true });
  });

  it("installs every discovered skill from a git source", async () => {
    const result = await runCli(["add", `file://${fixtureRepo}`]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ Installed alpha");
    expect(result.stdout).toContain("✓ Installed beta");

    expect(await exists(join(skillsRoot, "alpha/SKILL.md"))).toBe(true);
    expect(await exists(join(skillsRoot, "alpha/reference.md"))).toBe(true);
    expect(await exists(join(skillsRoot, "beta/SKILL.md"))).toBe(true);

    const list = await runCli(["list"]);
    expect(list.stdout).toContain("2 skill(s) installed");
    expect(list.stdout).toContain("alpha");
  });

  it("filters skills with --skill and previews with --list", async () => {
    const preview = await runCli(["add", `file://${fixtureRepo}`, "--list"]);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("2 skill(s) available");

    const result = await runCli(["add", `file://${fixtureRepo}`, "--skill", "alpha"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ Installed alpha");
    expect(result.stdout).not.toContain("beta");
    expect(await exists(join(skillsRoot, "beta"))).toBe(false);

    const missing = await runCli(["add", `file://${fixtureRepo}`, "--skill", "nope"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("No matching skills found");
  });

  it("reports up to date, then updates only when the source differs", async () => {
    expect((await runCli(["add", `file://${fixtureRepo}`])).exitCode).toBe(0);

    const clean = await runCli(["check"]);
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout).toContain("✓ alpha is up to date");
    expect(clean.stdout).toContain("All checked skills are up to date");

    const noop = await runCli(["update"]);
    expect(noop.exitCode).toBe(0);
    expect(noop.stdout).toContain("All skills are up to date");

    await writeSkill(fixtureRepo, "skills/alpha", "alpha", "Alpha v2");
    await git(fixtureRepo, "add", "-A");
    await git(fixtureRepo, "commit", "-m", "update alpha");

    const drift = await runCli(["check"]);
    expect(drift.stdout).toContain("↑ alpha has an update available");
    expect(drift.stdout).toContain("✓ beta is up to date");

    const update = await runCli(["update"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("✓ Updated alpha");
    expect(await readFile(join(skillsRoot, "alpha/SKILL.md"), "utf-8")).toContain("Alpha v2");

    const after = await runCli(["check"]);
    expect(after.stdout).toContain("✓ alpha is up to date");
  });

  it("reports skills deleted upstream without removing them", async () => {
    expect((await runCli(["add", `file://${fixtureRepo}`])).exitCode).toBe(0);

    await rm(join(fixtureRepo, "skills/beta"), { recursive: true });
    await git(fixtureRepo, "add", "-A");
    await git(fixtureRepo, "commit", "-m", "delete beta");

    const check = await runCli(["check"]);
    expect(check.stdout).toContain("✗ beta was deleted upstream");
    expect(await exists(join(skillsRoot, "beta/SKILL.md"))).toBe(true);
  });

  it("installs from an absolute local path and skips it on check", async () => {
    const result = await runCli(["add", fixtureRepo, "--skill", "alpha"]);
    expect(result.exitCode).toBe(0);
    expect(await exists(join(skillsRoot, "alpha/SKILL.md"))).toBe(true);

    const check = await runCli(["check"]);
    expect(check.stdout).toContain("alpha skipped (Local path)");
  });

  it("rejects relative local paths (server-side execution)", async () => {
    const result = await runCli(["add", "./skills"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("absolute path");
  });

  it("removes installed skills and their lock entries", async () => {
    expect((await runCli(["add", `file://${fixtureRepo}`])).exitCode).toBe(0);

    const result = await runCli(["remove", "alpha"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ Removed alpha");
    expect(await exists(join(skillsRoot, "alpha"))).toBe(false);

    const list = await runCli(["list"]);
    expect(list.stdout).toContain("1 skill(s) installed");

    const missing = await runCli(["remove", "alpha"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("not installed");
  });

  it("searches the skills.sh registry through the bb SDK", async () => {
    harness.sdk.stub("skills.registry.search", async () => ({
      skills: [
        {
          id: "anthropics/skills/pdf",
          source: "anthropics/skills",
          skillId: "pdf",
          name: "pdf",
          installs: 12345,
          stars: null,
          installUrl: null,
          url: "https://www.skills.sh/anthropics/skills/pdf",
          topic: null,
          summary: "Extract text from PDFs",
        },
      ],
      pagination: { page: 0, perPage: 10, total: 1, hasMore: false },
      ranking: "all-time",
    }));

    const result = await runCli(["find", "pdf"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("anthropics/skills/pdf");
    expect(result.stdout).toContain("bb skills add anthropics/skills --skill pdf");
  });

  it("prints help for unknown commands", async () => {
    const help = await runCli([]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("bb skills");

    const unknown = await runCli(["bogus"]);
    expect(unknown.exitCode).toBe(1);
  });
});
