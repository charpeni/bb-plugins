import { rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  cleanAndCreateDirectory,
  computeSkillFolderHash,
  copySkillDirectory,
  discoverSkills,
  filterSkills,
  getOwnerRepo,
  getSkillDisplayName,
  isPathSafe,
  parseSource,
  sanitizeName,
  toSkillPath,
  type ParsedSource,
  type Skill,
  type SourceType,
} from "./skills-core";
import {
  cleanupTempDir,
  cloneRepo,
  fetchRepoTree,
  getGitTreeHash,
  getSkillFolderHashFromTree,
} from "./git-source";

const LOCK_PREFIX = "skill:";

/** One installed skill, mirroring the skills CLI's lock entry (v3). */
export interface SkillLockEntry {
  /** Frontmatter name. */
  name: string;
  /** Sanitized directory name under the skills root. */
  installName: string;
  /** Normalized identifier (owner/repo when derivable, else URL/path). */
  source: string;
  sourceType: SourceType;
  /** Clone URL (or absolute local path) used to install, for re-fetching. */
  sourceUrl: string;
  ref?: string;
  /** Repo-relative path to SKILL.md, e.g. "skills/pdf/SKILL.md". */
  skillPath?: string;
  /**
   * Git tree SHA of the skill folder (git sources — identical to GitHub's
   * Trees API folder SHA) or a SHA-256 over file contents (local sources).
   */
  skillFolderHash: string | null;
  hashKind: "git-tree" | "content";
  installedAt: string;
  updatedAt: string;
}

type CheckStatus = "up-to-date" | "update-available" | "deleted-upstream" | "skipped" | "error";

interface CheckResult {
  entry: SkillLockEntry;
  status: CheckStatus;
  detail?: string;
}

interface UpdateReport {
  results: CheckResult[];
  updated: SkillLockEntry[];
  failed: Array<{ entry: SkillLockEntry; error: string }>;
}

interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

const lockEntrySchema = z
  .object({
    name: z.string(),
    installName: z.string(),
    source: z.string(),
    sourceType: z.enum(["github", "gitlab", "git", "local"]),
    sourceUrl: z.string(),
    ref: z.string().optional(),
    skillPath: z.string().optional(),
    skillFolderHash: z.string().nullable(),
    hashKind: z.enum(["git-tree", "content"]),
    installedAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const checkResultSchema = z
  .object({
    installName: z.string(),
    name: z.string(),
    source: z.string(),
    status: z.enum(["up-to-date", "update-available", "deleted-upstream", "skipped", "error"]),
    detail: z.string().optional(),
  })
  .strict();

export const skillsRpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({ skillsRoot: z.string(), skills: z.array(lockEntrySchema) }).strict(),
  },
  search: {
    input: z.object({ query: z.string() }).strict(),
    output: z
      .object({
        skills: z.array(
          z
            .object({
              id: z.string(),
              source: z.string(),
              skillId: z.string(),
              name: z.string(),
              installs: z.number(),
              summary: z.string().nullable(),
              url: z.string(),
            })
            .strict(),
        ),
        total: z.number(),
      })
      .strict(),
  },
  previewSource: {
    input: z.object({ source: z.string().min(1) }).strict(),
    output: z
      .object({
        skills: z.array(
          z.object({ name: z.string(), description: z.string(), installed: z.boolean() }).strict(),
        ),
      })
      .strict(),
  },
  install: {
    input: z
      .object({ source: z.string().min(1), skills: z.array(z.string().min(1)).optional() })
      .strict(),
    output: z.object({ installed: z.array(lockEntrySchema) }).strict(),
  },
  check: {
    input: z.object({ skills: z.array(z.string().min(1)).optional() }).strict(),
    output: z.object({ results: z.array(checkResultSchema) }).strict(),
  },
  update: {
    input: z.object({ skills: z.array(z.string().min(1)).optional() }).strict(),
    output: z
      .object({
        results: z.array(checkResultSchema),
        updated: z.array(lockEntrySchema),
        failed: z.array(z.object({ installName: z.string(), error: z.string() }).strict()),
      })
      .strict(),
  },
  remove: {
    input: z.object({ skills: z.array(z.string().min(1)).min(1) }).strict(),
    output: z.object({ removed: z.array(z.string()), missing: z.array(z.string()) }).strict(),
  },
});

function serializeCheck(result: CheckResult): z.infer<typeof checkResultSchema> {
  return {
    installName: result.entry.installName,
    name: result.entry.name,
    source: result.entry.source,
    status: result.status,
    ...(result.detail ? { detail: result.detail } : {}),
  };
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    skillsDir: { type: "string", label: "Skills directory override", default: "" },
  });

  async function resolveSkillsRoot(): Promise<string> {
    const { skillsDir } = await settings.get();
    if (skillsDir) return skillsDir;
    const config = await bb.sdk.system.config();
    return join(config.dataDir, "skills");
  }

  async function readLock(): Promise<SkillLockEntry[]> {
    const keys = await bb.storage.kv.list(LOCK_PREFIX);
    const entries = await Promise.all(keys.map((key) => bb.storage.kv.get<SkillLockEntry>(key)));
    return entries
      .filter((entry): entry is SkillLockEntry => entry != null)
      .sort((a, b) => a.installName.localeCompare(b.installName));
  }

  async function getLockEntry(installName: string): Promise<SkillLockEntry | null> {
    return (await bb.storage.kv.get<SkillLockEntry>(`${LOCK_PREFIX}${installName}`)) ?? null;
  }

  async function writeLockEntry(entry: SkillLockEntry): Promise<void> {
    await bb.storage.kv.set(`${LOCK_PREFIX}${entry.installName}`, entry);
  }

  /** Copy one discovered skill into the skills root and record it in the lock. */
  async function installSkill(
    skill: Skill,
    basePath: string,
    parsed: ParsedSource,
    sourceInput: string,
  ): Promise<SkillLockEntry> {
    const skillsRoot = await resolveSkillsRoot();
    const installName = sanitizeName(getSkillDisplayName(skill));
    const dest = join(skillsRoot, installName);
    if (!isPathSafe(skillsRoot, dest)) {
      throw new Error(`Invalid skill name: potential path traversal detected (${skill.name})`);
    }

    await cleanAndCreateDirectory(dest);
    await copySkillDirectory(skill.path, dest);

    const skillPath = toSkillPath(basePath, skill.path);
    const isGitSource = parsed.type !== "local";
    const treeHash = isGitSource ? await getGitTreeHash(basePath, skillPath) : null;
    const hashKind = treeHash ? "git-tree" : "content";
    const skillFolderHash = treeHash ?? (await computeSkillFolderHash(skill.path));

    const existing = await getLockEntry(installName);
    const now = new Date().toISOString();
    const entry: SkillLockEntry = {
      name: skill.name,
      installName,
      source: getOwnerRepo(parsed) ?? (parsed.type === "local" ? parsed.url : sourceInput),
      sourceType: parsed.type,
      sourceUrl: parsed.url,
      ...(parsed.ref ? { ref: parsed.ref } : {}),
      skillPath,
      skillFolderHash,
      hashKind,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    };
    await writeLockEntry(entry);
    bb.log.info(`installed skill ${entry.installName} from ${entry.source}`);
    return entry;
  }

  function parseSourceInput(sourceInput: string): ParsedSource {
    const parsed = parseSource(sourceInput);
    if (parsed.type === "local" && !sourceInput.startsWith("/")) {
      throw new Error(
        "Relative local paths are not supported: bb runs this command on the server, " +
          "so pass an absolute path on the bb server host.",
      );
    }
    return parsed;
  }

  /** Resolve a source's skills: clone (or use a local path) and discover. */
  async function loadSource(
    parsed: ParsedSource,
    options: { includeInternal?: boolean; fullDepth?: boolean },
  ): Promise<{ basePath: string; skills: Skill[]; cleanup: () => Promise<void> }> {
    let basePath: string;
    let cleanup = async () => {};
    if (parsed.type === "local") {
      basePath = parsed.localPath!;
      const stats = await stat(basePath).catch(() => null);
      if (!stats?.isDirectory()) {
        throw new Error(
          `Local path not found on the bb server host: ${basePath}. ` +
            `Local sources must be absolute paths on the machine running the bb server.`,
        );
      }
    } else {
      basePath = await cloneRepo(parsed.url, parsed.ref);
      cleanup = () => cleanupTempDir(basePath);
    }
    try {
      const skills = await discoverSkills(basePath, parsed.subpath, options);
      return { basePath, skills, cleanup };
    } catch (error) {
      await cleanup().catch(() => {});
      throw error;
    }
  }

  /**
   * Install skills from a source string. Empty `skillNames` installs every
   * discovered skill (the CLI's non-interactive `-y` behavior).
   */
  async function installFromSource(
    sourceInput: string,
    skillNames: string[],
    options: { fullDepth?: boolean } = {},
  ): Promise<SkillLockEntry[]> {
    const parsed = parseSourceInput(sourceInput);
    if (parsed.skillFilter && skillNames.length === 0) {
      skillNames = [parsed.skillFilter];
    }
    const explicitNames = skillNames.length === 1 && skillNames[0] === "*" ? [] : skillNames;

    const { basePath, skills, cleanup } = await loadSource(parsed, {
      includeInternal: explicitNames.length > 0,
      fullDepth: options.fullDepth,
    });
    try {
      if (skills.length === 0) {
        throw new Error(`No skills found in ${sourceInput}`);
      }
      const selected = explicitNames.length > 0 ? filterSkills(skills, explicitNames) : skills;
      if (selected.length === 0) {
        const available = skills.map((s) => getSkillDisplayName(s)).join(", ");
        throw new Error(
          `No matching skills found for: ${explicitNames.join(", ")}. Available: ${available}`,
        );
      }
      const installed: SkillLockEntry[] = [];
      for (const skill of selected) {
        installed.push(await installSkill(skill, basePath, parsed, sourceInput));
      }
      return installed;
    } finally {
      await cleanup().catch(() => {});
    }
  }

  /** Compare each lock entry against its source; never mutates anything. */
  async function checkEntries(entries: SkillLockEntry[]): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    const bySource = new Map<string, SkillLockEntry[]>();

    for (const entry of entries) {
      if (entry.sourceType === "local") {
        results.push({ entry, status: "skipped", detail: "Local path" });
        continue;
      }
      if (!entry.skillPath || !entry.skillFolderHash) {
        results.push({ entry, status: "skipped", detail: "No version tracking" });
        continue;
      }
      const key = `${entry.sourceUrl}#${entry.ref ?? ""}`;
      bySource.set(key, [...(bySource.get(key) ?? []), entry]);
    }

    for (const group of bySource.values()) {
      const first = group[0]!;

      // GitHub fast path: one Trees API call answers every skill in the repo
      // without cloning. Fall back to a shallow clone when unavailable.
      if (first.sourceType === "github" && first.hashKind === "git-tree") {
        const ownerRepo = first.source.includes("/") ? first.source : null;
        const tree = ownerRepo ? await fetchRepoTree(ownerRepo, first.ref) : null;
        if (tree) {
          for (const entry of group) {
            const latest = getSkillFolderHashFromTree(tree, entry.skillPath!);
            if (!latest) {
              results.push({ entry, status: "deleted-upstream" });
            } else if (latest !== entry.skillFolderHash) {
              results.push({ entry, status: "update-available" });
            } else {
              results.push({ entry, status: "up-to-date" });
            }
          }
          continue;
        }
      }

      let tempDir: string | null = null;
      try {
        tempDir = await cloneRepo(first.sourceUrl, first.ref);
        for (const entry of group) {
          const skillDir = join(tempDir, dirname(entry.skillPath!));
          const exists = await stat(join(tempDir, entry.skillPath!)).catch(() => null);
          if (!exists?.isFile()) {
            results.push({ entry, status: "deleted-upstream" });
            continue;
          }
          const latest =
            entry.hashKind === "git-tree"
              ? await getGitTreeHash(tempDir, entry.skillPath!)
              : await computeSkillFolderHash(skillDir);
          if (latest && latest !== entry.skillFolderHash) {
            results.push({ entry, status: "update-available" });
          } else {
            results.push({ entry, status: "up-to-date" });
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        for (const entry of group) {
          results.push({ entry, status: "error", detail });
        }
      } finally {
        if (tempDir) await cleanupTempDir(tempDir).catch(() => {});
      }
    }

    return results;
  }

  /** Check the given entries and re-install the ones whose source differs. */
  async function applyUpdates(names: string[]): Promise<UpdateReport> {
    const entries = selectEntries(await readLock(), names);
    const results = await checkEntries(entries);
    const toUpdate = results.filter((r) => r.status === "update-available");

    const updated: SkillLockEntry[] = [];
    const failed: Array<{ entry: SkillLockEntry; error: string }> = [];
    const bySource = new Map<string, SkillLockEntry[]>();
    for (const { entry } of toUpdate) {
      const key = `${entry.sourceUrl}#${entry.ref ?? ""}`;
      bySource.set(key, [...(bySource.get(key) ?? []), entry]);
    }

    for (const group of bySource.values()) {
      const first = group[0]!;
      let tempDir: string | null = null;
      try {
        tempDir = await cloneRepo(first.sourceUrl, first.ref);
        // Skills can move within the repo; rediscover instead of trusting the
        // recorded folder blindly (the CLI re-runs `add --skill <name>`).
        const skills = await discoverSkills(tempDir, undefined, {
          fullDepth: true,
          includeInternal: true,
        });
        for (const entry of group) {
          const parsed: ParsedSource = {
            type: entry.sourceType,
            url: entry.sourceUrl,
            ...(entry.ref ? { ref: entry.ref } : {}),
          };
          const match =
            filterSkills(skills, [entry.name])[0] ?? filterSkills(skills, [entry.installName])[0];
          if (!match) {
            failed.push({ entry, error: `no longer found in ${entry.source}` });
            continue;
          }
          updated.push(await installSkill(match, tempDir, parsed, entry.source));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const entry of group) {
          failed.push({ entry, error: message });
        }
      } finally {
        if (tempDir) await cleanupTempDir(tempDir).catch(() => {});
      }
    }

    return { results, updated, failed };
  }

  async function removeSkills(names: string[]): Promise<{ removed: string[]; missing: string[] }> {
    const skillsRoot = await resolveSkillsRoot();
    const removed: string[] = [];
    const missing: string[] = [];
    for (const name of names) {
      const entries = selectEntries(await readLock(), [name]);
      if (entries.length === 0) {
        missing.push(name);
        continue;
      }
      for (const entry of entries) {
        const dir = join(skillsRoot, entry.installName);
        if (isPathSafe(skillsRoot, dir) && dir !== skillsRoot) {
          await rm(dir, { recursive: true, force: true });
        }
        await bb.storage.kv.delete(`${LOCK_PREFIX}${entry.installName}`);
        removed.push(entry.installName);
      }
    }
    return { removed, missing };
  }

  function selectEntries(entries: SkillLockEntry[], names: string[]): SkillLockEntry[] {
    if (names.length === 0) return entries;
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    return entries.filter(
      (e) => wanted.has(e.installName.toLowerCase()) || wanted.has(e.name.toLowerCase()),
    );
  }

  async function searchRegistry(query: string) {
    const page = await bb.sdk.skills.registry.search(
      query ? { query, perPage: 12 } : { perPage: 12 },
    );
    return {
      skills: page.skills.map((skill) => ({
        id: skill.id,
        source: skill.source,
        skillId: skill.skillId,
        name: skill.name,
        installs: skill.installs,
        summary: skill.summary,
        url: skill.url,
      })),
      total: page.pagination.total,
    };
  }

  bb.rpc.register(skillsRpcContract, {
    async status() {
      return { skillsRoot: await resolveSkillsRoot(), skills: await readLock() };
    },
    async search({ query }) {
      return await searchRegistry(query.trim());
    },
    async previewSource({ source }) {
      const parsed = parseSourceInput(source);
      const installedNames = new Set((await readLock()).map((e) => e.installName));
      const { skills, cleanup } = await loadSource(parsed, {});
      try {
        return {
          skills: skills.map((skill) => ({
            name: getSkillDisplayName(skill),
            description: skill.description,
            installed: installedNames.has(sanitizeName(getSkillDisplayName(skill))),
          })),
        };
      } finally {
        await cleanup().catch(() => {});
      }
    },
    async install({ source, skills }) {
      return { installed: await installFromSource(source, skills ?? []) };
    },
    async check({ skills }) {
      const entries = selectEntries(await readLock(), skills ?? []);
      return { results: (await checkEntries(entries)).map(serializeCheck) };
    },
    async update({ skills }) {
      const report = await applyUpdates(skills ?? []);
      return {
        results: report.results.map(serializeCheck),
        updated: report.updated,
        failed: report.failed.map(({ entry, error }) => ({
          installName: entry.installName,
          error,
        })),
      };
    },
    async remove({ skills }) {
      return await removeSkills(skills);
    },
  });

  // ─── CLI ───

  async function runAdd(argv: string[]): Promise<CliResult> {
    const skillNames: string[] = [];
    let listOnly = false;
    let fullDepth = false;
    let sourceInput: string | undefined;

    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "-s" || arg === "--skill") {
        const value = argv[++i];
        if (!value) return { exitCode: 1, stderr: `Missing value for ${arg}` };
        skillNames.push(
          ...value
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
        );
      } else if (arg === "-l" || arg === "--list") {
        listOnly = true;
      } else if (arg === "--full-depth") {
        fullDepth = true;
      } else if (arg === "-y" || arg === "--yes" || arg === "-g" || arg === "--global") {
        // Always non-interactive, always the bb user scope; accepted for parity.
      } else if (!arg.startsWith("-") && !sourceInput) {
        sourceInput = arg;
      } else {
        return { exitCode: 1, stderr: `Unknown argument: ${arg}` };
      }
    }

    if (!sourceInput) {
      return { exitCode: 1, stderr: "Usage: bb skills add <source> [--skill <name>] [--list]" };
    }

    if (listOnly) {
      const parsed = parseSourceInput(sourceInput);
      const { skills, cleanup } = await loadSource(parsed, { fullDepth });
      try {
        if (skills.length === 0) {
          return { exitCode: 1, stderr: `No skills found in ${sourceInput}` };
        }
        const lines = skills.map((s) => `  ${getSkillDisplayName(s)} — ${s.description}`);
        return {
          exitCode: 0,
          stdout: `${skills.length} skill(s) available in ${sourceInput}:\n${lines.join("\n")}`,
        };
      } finally {
        await cleanup().catch(() => {});
      }
    }

    const installed = await installFromSource(sourceInput, skillNames, { fullDepth });
    const lines = installed.map((entry) => `✓ Installed ${entry.installName} (${entry.source})`);
    const root = await resolveSkillsRoot();
    lines.push(`${installed.length} skill(s) installed to ${root}`);
    return { exitCode: 0, stdout: lines.join("\n") };
  }

  async function runList(): Promise<CliResult> {
    const entries = await readLock();
    if (entries.length === 0) {
      return { exitCode: 0, stdout: "No skills installed. Install with: bb skills add <source>" };
    }
    const root = await resolveSkillsRoot();
    const lines = entries.map((entry) => {
      const ref = entry.ref ? `#${entry.ref}` : "";
      const hash = entry.skillFolderHash ? entry.skillFolderHash.slice(0, 12) : "untracked";
      return `  ${entry.installName}  ${entry.source}${ref}  ${hash}  (updated ${entry.updatedAt.slice(0, 10)})`;
    });
    return {
      exitCode: 0,
      stdout: `${entries.length} skill(s) installed in ${root}:\n${lines.join("\n")}`,
    };
  }

  function formatCheckLine(result: CheckResult): string {
    const { entry, status, detail } = result;
    switch (status) {
      case "up-to-date":
        return `  ✓ ${entry.installName} is up to date`;
      case "update-available":
        return `  ↑ ${entry.installName} has an update available (${entry.source})`;
      case "deleted-upstream":
        return `  ✗ ${entry.installName} was deleted upstream — remove with: bb skills remove ${entry.installName}`;
      case "skipped":
        return `  - ${entry.installName} skipped (${detail})`;
      case "error":
        return `  ✗ ${entry.installName} check failed: ${detail}`;
    }
  }

  async function runCheck(names: string[]): Promise<CliResult> {
    const entries = selectEntries(await readLock(), names);
    if (entries.length === 0) {
      return { exitCode: 0, stdout: "No installed skills to check." };
    }
    const results = await checkEntries(entries);
    const updates = results.filter((r) => r.status === "update-available").length;
    const summary =
      updates === 0
        ? "✓ All checked skills are up to date"
        : `${updates} update(s) available — run: bb skills update`;
    return {
      exitCode: results.some((r) => r.status === "error") ? 1 : 0,
      stdout: `${results.map(formatCheckLine).join("\n")}\n${summary}`,
    };
  }

  async function runUpdate(names: string[]): Promise<CliResult> {
    const entries = selectEntries(await readLock(), names);
    if (entries.length === 0) {
      return { exitCode: 0, stdout: "No installed skills to update." };
    }

    const { results, updated, failed } = await applyUpdates(names);
    const lines = results.filter((r) => r.status !== "update-available").map(formatCheckLine);
    for (const entry of updated) {
      lines.push(`  ✓ Updated ${entry.installName} (${entry.skillFolderHash?.slice(0, 12)})`);
    }
    for (const { entry, error } of failed) {
      lines.push(`  ✗ Failed to update ${entry.installName}: ${error}`);
    }

    const changed = updated.length + failed.length;
    const summary =
      changed === 0
        ? "✓ All skills are up to date"
        : `Updated ${updated.length} skill(s)${failed.length > 0 ? `, ${failed.length} failed` : ""}`;
    return {
      exitCode: failed.length > 0 || results.some((r) => r.status === "error") ? 1 : 0,
      stdout: `${lines.join("\n")}\n${summary}`.trim(),
    };
  }

  async function runRemove(names: string[]): Promise<CliResult> {
    if (names.length === 0) {
      return { exitCode: 1, stderr: "Usage: bb skills remove <skill> [skill...]" };
    }
    const { removed, missing } = await removeSkills(names);
    const lines = [
      ...removed.map((name) => `✓ Removed ${name}`),
      ...missing.map((name) => `✗ ${name} is not installed`),
    ];
    return { exitCode: missing.length > 0 ? 1 : 0, stdout: lines.join("\n") };
  }

  async function runFind(queryParts: string[]): Promise<CliResult> {
    const query = queryParts.join(" ").trim();
    const { skills } = await searchRegistry(query);
    if (skills.length === 0) {
      return { exitCode: 0, stdout: `No skills found on skills.sh for "${query}"` };
    }
    const lines = skills.map((skill) => {
      const summary = skill.summary ? ` — ${skill.summary.slice(0, 100)}` : "";
      return `  ${skill.id}  (${skill.installs.toLocaleString()} installs)${summary}\n    Install: bb skills add ${skill.source} --skill ${skill.skillId}`;
    });
    const heading = query ? `Top skills.sh results for "${query}":` : "Trending on skills.sh:";
    return { exitCode: 0, stdout: `${heading}\n${lines.join("\n")}` };
  }

  bb.cli.register({
    name: "skills",
    summary: "Install agent skills from skills.sh globally for every AI agent bb runs",
    commands: [
      {
        name: "add",
        summary:
          "Install skills from a source (owner/repo, GitHub/GitLab/skills.sh URL, git URL, or absolute server path). Installs every discovered skill unless filtered with --skill; --list previews instead",
        usage: "bb skills add <source> [--skill <name>] [--list] [--full-depth]",
      },
      {
        name: "list",
        summary: "List installed skills with their source and tracked version",
        usage: "bb skills list",
      },
      {
        name: "check",
        summary: "Check installed skills against their sources without changing anything",
        usage: "bb skills check [skill...]",
      },
      {
        name: "update",
        summary: "Re-install skills whose source content differs from the installed copy",
        usage: "bb skills update [skill...]",
      },
      {
        name: "remove",
        summary: "Remove installed skills",
        usage: "bb skills remove <skill> [skill...]",
      },
      {
        name: "find",
        summary: "Search the skills.sh registry (trending when no query is given)",
        usage: "bb skills find [query]",
      },
    ],
    async run(argv) {
      const [command, ...rest] = argv;
      try {
        switch (command) {
          case "add":
            return await runAdd(rest);
          case "list":
          case "ls":
            return await runList();
          case "check":
            return await runCheck(rest.filter((a) => !a.startsWith("-")));
          case "update":
            return await runUpdate(rest.filter((a) => !a.startsWith("-")));
          case "remove":
          case "rm":
            return await runRemove(rest.filter((a) => !a.startsWith("-")));
          case "find":
            return await runFind(rest);
          default:
            return {
              exitCode: command ? 1 : 0,
              stdout:
                "bb skills — install and update agent skills from skills.sh\n\n" +
                "Commands:\n" +
                "  add <source> [--skill <name>] [--list]   Install skills from a repo or skills.sh URL\n" +
                "  list                                     List installed skills\n" +
                "  check [skill...]                         Check for upstream changes\n" +
                "  update [skill...]                        Update skills whose source differs\n" +
                "  remove <skill...>                        Remove installed skills\n" +
                "  find [query]                             Search the skills.sh registry",
              ...(command ? { stderr: `Unknown command: ${command}` } : {}),
            };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bb.log.error(`skills command failed: ${message}`);
        return { exitCode: 1, stderr: message };
      }
    },
  });
}
