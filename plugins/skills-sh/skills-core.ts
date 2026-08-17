/**
 * Core skills.sh logic, ported 1:1 from the `skills` CLI
 * (https://github.com/vercel-labs/skills): source parsing, SKILL.md
 * discovery, folder hashing, and skill-folder copying. Pure Node — no bb
 * dependency — so everything here is unit-testable without a server.
 */
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

// ─── Source parsing ───

export type SourceType = "github" | "gitlab" | "git" | "local";

export interface ParsedSource {
  type: SourceType;
  /** Clone URL for remote types; resolved absolute path for `local`. */
  url: string;
  ref?: string;
  subpath?: string;
  skillFilter?: string;
  localPath?: string;
}

const SOURCE_ALIASES: Record<string, string> = {
  "coinbase/agentWallet": "coinbase/agentic-wallet-skills",
  "vercel-labs/vercel-skills": "vercel-labs/agent-skills",
};

export function sanitizeSubpath(subpath: string): string {
  const normalized = subpath.replace(/\\/g, "/");
  for (const segment of normalized.split("/")) {
    if (segment === "..") {
      throw new Error(
        `Unsafe subpath: "${subpath}" contains path traversal segments. ` +
          `Subpaths must not contain ".." components.`,
      );
    }
  }
  return subpath;
}

function isLocalPath(input: string): boolean {
  return (
    isAbsolute(input) ||
    input.startsWith("./") ||
    input.startsWith("../") ||
    input === "." ||
    input === ".."
  );
}

interface FragmentRefResult {
  inputWithoutFragment: string;
  ref?: string;
  skillFilter?: string;
}

function decodeFragmentValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeGitSource(input: string): boolean {
  if (input.startsWith("github:") || input.startsWith("gitlab:") || input.startsWith("git@")) {
    return true;
  }
  if (/^ssh:\/\/.+\.git(?:$|[/?])/i.test(input)) return true;
  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const parsed = new URL(input);
      if (parsed.hostname === "github.com") {
        return /^\/[^/]+\/[^/]+(?:\.git)?(?:\/tree\/[^/]+(?:\/.*)?)?\/?$/.test(parsed.pathname);
      }
      if (parsed.hostname === "gitlab.com") {
        return /^\/.+?\/[^/]+(?:\.git)?(?:\/-\/tree\/[^/]+(?:\/.*)?)?\/?$/.test(parsed.pathname);
      }
    } catch {
      // Fall through to generic checks below.
    }
  }
  if (/^https?:\/\/.+\.git(?:$|[/?])/i.test(input)) return true;
  return (
    !input.includes(":") &&
    !input.startsWith(".") &&
    !input.startsWith("/") &&
    /^([^/]+)\/([^/]+)(?:\/(.+)|@(.+))?$/.test(input)
  );
}

function parseFragmentRef(input: string): FragmentRefResult {
  const hashIndex = input.indexOf("#");
  if (hashIndex < 0) return { inputWithoutFragment: input };

  const inputWithoutFragment = input.slice(0, hashIndex);
  const fragment = input.slice(hashIndex + 1);
  if (!fragment || !looksLikeGitSource(inputWithoutFragment)) {
    return { inputWithoutFragment: input };
  }

  const atIndex = fragment.indexOf("@");
  if (atIndex === -1) {
    return { inputWithoutFragment, ref: decodeFragmentValue(fragment) };
  }
  const ref = fragment.slice(0, atIndex);
  const skillFilter = fragment.slice(atIndex + 1);
  return {
    inputWithoutFragment,
    ref: ref ? decodeFragmentValue(ref) : undefined,
    skillFilter: skillFilter ? decodeFragmentValue(skillFilter) : undefined,
  };
}

function appendFragmentRef(input: string, ref?: string, skillFilter?: string): string {
  if (!ref) return input;
  return `${input}#${ref}${skillFilter ? `@${skillFilter}` : ""}`;
}

export function parseSource(input: string): ParsedSource {
  if (isLocalPath(input)) {
    const resolvedPath = resolve(input);
    return { type: "local", url: resolvedPath, localPath: resolvedPath };
  }

  const {
    inputWithoutFragment,
    ref: fragmentRef,
    skillFilter: fragmentSkillFilter,
  } = parseFragmentRef(input);
  input = inputWithoutFragment;

  const alias = SOURCE_ALIASES[input];
  if (alias) input = alias;

  const githubPrefixMatch = input.match(/^github:(.+)$/);
  if (githubPrefixMatch) {
    return parseSource(appendFragmentRef(githubPrefixMatch[1]!, fragmentRef, fragmentSkillFilter));
  }

  const gitlabPrefixMatch = input.match(/^gitlab:(.+)$/);
  if (gitlabPrefixMatch) {
    return parseSource(
      appendFragmentRef(
        `https://gitlab.com/${gitlabPrefixMatch[1]!}`,
        fragmentRef,
        fragmentSkillFilter,
      ),
    );
  }

  // skills.sh detail pages: https://skills.sh/<owner>/<repo>[/<skill>] — the
  // registry serves GitHub-backed sources, so map straight to a GitHub clone.
  const skillsShMatch = input.match(
    /^https?:\/\/(?:www\.)?skills\.sh\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/,
  );
  if (skillsShMatch) {
    const [, owner, repo, skill] = skillsShMatch;
    return {
      type: "github",
      url: `https://github.com/${owner}/${repo}.git`,
      ...(fragmentRef ? { ref: fragmentRef } : {}),
      ...(skill ? { skillFilter: skill } : {}),
    };
  }

  // GitHub URL with path: https://github.com/owner/repo/tree/branch/path/to/skill
  const githubTreeWithPathMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)/);
  if (githubTreeWithPathMatch) {
    const [, owner, repo, ref, subpath] = githubTreeWithPathMatch;
    return {
      type: "github",
      url: `https://github.com/${owner}/${repo}.git`,
      ref: ref || fragmentRef,
      subpath: subpath ? sanitizeSubpath(subpath) : subpath,
    };
  }

  // GitHub URL with branch only: https://github.com/owner/repo/tree/branch
  const githubTreeMatch = input.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)$/);
  if (githubTreeMatch) {
    const [, owner, repo, ref] = githubTreeMatch;
    return {
      type: "github",
      url: `https://github.com/${owner}/${repo}.git`,
      ref: ref || fragmentRef,
    };
  }

  // GitHub URL: https://github.com/owner/repo
  const githubRepoMatch = input.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (githubRepoMatch) {
    const [, owner, repo] = githubRepoMatch;
    const cleanRepo = repo!.replace(/\.git$/, "");
    return {
      type: "github",
      url: `https://github.com/${owner}/${cleanRepo}.git`,
      ...(fragmentRef ? { ref: fragmentRef } : {}),
    };
  }

  // GitLab URL with path: https://gitlab.com/owner/repo/-/tree/branch/path
  const gitlabTreeWithPathMatch = input.match(
    /^(https?):\/\/([^/]+)\/(.+?)\/-\/tree\/([^/]+)\/(.+)/,
  );
  if (gitlabTreeWithPathMatch) {
    const [, protocol, hostname, repoPath, ref, subpath] = gitlabTreeWithPathMatch;
    if (hostname !== "github.com" && repoPath) {
      return {
        type: "gitlab",
        url: `${protocol}://${hostname}/${repoPath.replace(/\.git$/, "")}.git`,
        ref: ref || fragmentRef,
        subpath: subpath ? sanitizeSubpath(subpath) : subpath,
      };
    }
  }

  // GitLab URL with branch only: https://gitlab.com/owner/repo/-/tree/branch
  const gitlabTreeMatch = input.match(/^(https?):\/\/([^/]+)\/(.+?)\/-\/tree\/([^/]+)$/);
  if (gitlabTreeMatch) {
    const [, protocol, hostname, repoPath, ref] = gitlabTreeMatch;
    if (hostname !== "github.com" && repoPath) {
      return {
        type: "gitlab",
        url: `${protocol}://${hostname}/${repoPath.replace(/\.git$/, "")}.git`,
        ref: ref || fragmentRef,
      };
    }
  }

  // GitLab.com URL (supports subgroups): https://gitlab.com/group/subgroup/repo
  const gitlabRepoMatch = input.match(/gitlab\.com\/(.+?)(?:\.git)?\/?$/);
  if (gitlabRepoMatch) {
    const repoPath = gitlabRepoMatch[1]!;
    if (repoPath.includes("/")) {
      return {
        type: "gitlab",
        url: `https://gitlab.com/${repoPath}.git`,
        ...(fragmentRef ? { ref: fragmentRef } : {}),
      };
    }
  }

  // GitHub shorthand with @skill: owner/repo@skill-name
  const atSkillMatch = input.match(/^([^/]+)\/([^/@]+)@(.+)$/);
  if (atSkillMatch && !input.includes(":") && !input.startsWith(".") && !input.startsWith("/")) {
    const [, owner, repo, skillFilter] = atSkillMatch;
    return {
      type: "github",
      url: `https://github.com/${owner}/${repo}.git`,
      ...(fragmentRef ? { ref: fragmentRef } : {}),
      skillFilter: fragmentSkillFilter || skillFilter,
    };
  }

  // GitHub shorthand: owner/repo or owner/repo/path/to/skill
  const shorthandMatch = input.match(/^([^/]+)\/([^/]+)(?:\/(.+?))?\/?$/);
  if (shorthandMatch && !input.includes(":") && !input.startsWith(".") && !input.startsWith("/")) {
    const [, owner, repo, subpath] = shorthandMatch;
    return {
      type: "github",
      url: `https://github.com/${owner}/${repo}.git`,
      ...(fragmentRef ? { ref: fragmentRef } : {}),
      subpath: subpath ? sanitizeSubpath(subpath) : subpath,
      ...(fragmentSkillFilter ? { skillFilter: fragmentSkillFilter } : {}),
    };
  }

  // Fallback: treat as a direct git URL (git@, ssh://, https://….git, file://…).
  return {
    type: "git",
    url: input,
    ...(fragmentRef ? { ref: fragmentRef } : {}),
  };
}

/**
 * Extract owner/repo (or group/subgroup/repo) from a parsed source for lock
 * tracking. Returns null for local paths or unparseable sources.
 */
export function getOwnerRepo(parsed: ParsedSource): string | null {
  if (parsed.type === "local") return null;

  const sshMatch = parsed.url.match(/^git@[^:]+:(.+)$/);
  if (sshMatch) {
    const path = sshMatch[1]!.replace(/\.git$/, "");
    return path.includes("/") ? path : null;
  }

  if (parsed.url.startsWith("ssh://")) {
    try {
      const path = new URL(parsed.url).pathname.slice(1).replace(/\.git$/, "");
      return path.includes("/") ? path : null;
    } catch {
      return null;
    }
  }

  if (!parsed.url.startsWith("http://") && !parsed.url.startsWith("https://")) {
    return null;
  }
  try {
    const path = new URL(parsed.url).pathname.slice(1).replace(/\.git$/, "");
    return path.includes("/") ? path : null;
  } catch {
    return null;
  }
}

// ─── Frontmatter ───

/**
 * Minimal frontmatter parser. YAML only (the `---` delimiter) — same as the
 * skills CLI, which avoids gray-matter's eval()-based `---js` engine.
 */
export function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  content: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: raw };
  const data = (parseYaml(match[1]!) as Record<string, unknown>) ?? {};
  return { data, content: match[2] ?? "" };
}

// ─── Skill discovery ───

export interface Skill {
  name: string;
  description: string;
  /** Absolute path of the directory containing SKILL.md. */
  path: string;
  metadata?: Record<string, unknown>;
}

const SKIP_DIRS = ["node_modules", ".git", "dist", "build", "__pycache__"];
const DEFAULT_SKILL_CONTAINER_DEPTH = 3;
const FULL_DEPTH_MAX = 5;

const AGENT_PROJECT_SKILL_DIRS = [
  ".agents/skills",
  ".claude/skills",
  ".cline/skills",
  ".codex/skills",
  ".github/skills",
  ".goose/skills",
  ".kilocode/skills",
  ".kiro/skills",
  ".opencode/skills",
  ".roo/skills",
  ".trae/skills",
  ".windsurf/skills",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, "SKILL.md"))).isFile();
  } catch {
    return false;
  }
}

export interface DiscoverSkillsOptions {
  /** Include `metadata.internal: true` skills (when explicitly requested by name). */
  includeInternal?: boolean;
  /** Search all subdirectories even when a root SKILL.md exists. */
  fullDepth?: boolean;
}

export async function parseSkillMd(
  skillMdPath: string,
  options?: DiscoverSkillsOptions,
): Promise<Skill | null> {
  let content: string;
  try {
    content = await readFile(skillMdPath, "utf-8");
  } catch {
    return null;
  }

  let data: Record<string, unknown>;
  try {
    ({ data } = parseFrontmatter(content));
  } catch {
    return null;
  }

  if (typeof data.name !== "string" || typeof data.description !== "string") {
    return null;
  }

  const metadata = isRecord(data.metadata) ? data.metadata : undefined;
  if (metadata?.internal === true && !options?.includeInternal) {
    return null;
  }

  return {
    name: data.name.trim(),
    description: data.description.trim(),
    path: dirname(skillMdPath),
    metadata,
  };
}

function isSubpathSafe(basePath: string, subpath: string): boolean {
  const normalizedBase = normalize(resolve(basePath));
  const normalizedTarget = normalize(resolve(join(basePath, subpath)));
  return normalizedTarget.startsWith(normalizedBase + sep) || normalizedTarget === normalizedBase;
}

async function findSkillDirs(dir: string, depth = 0, maxDepth = FULL_DEPTH_MAX): Promise<string[]> {
  if (depth > maxDepth) return [];
  try {
    const [hasSkill, entries] = await Promise.all([
      hasSkillMd(dir),
      readdir(dir, { withFileTypes: true }).catch(() => []),
    ]);
    const currentDir = hasSkill ? [dir] : [];
    const subDirResults = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !SKIP_DIRS.includes(entry.name))
        .map((entry) => findSkillDirs(join(dir, entry.name), depth + 1, maxDepth)),
    );
    return [...currentDir, ...subDirResults.flat()];
  } catch {
    return [];
  }
}

export async function discoverSkills(
  basePath: string,
  subpath?: string,
  options?: DiscoverSkillsOptions,
): Promise<Skill[]> {
  const skills: Skill[] = [];
  const seenNames = new Set<string>();
  const parsedSkillPaths = new Set<string>();

  if (subpath && !isSubpathSafe(basePath, subpath)) {
    throw new Error(`Invalid subpath: "${subpath}" resolves outside the repository directory.`);
  }

  const searchPath = subpath ? join(basePath, subpath) : basePath;

  const parseSkillAt = async (skillDir: string): Promise<Skill | null> => {
    const skillMdPath = resolve(skillDir, "SKILL.md");
    if (parsedSkillPaths.has(skillMdPath)) return null;
    parsedSkillPaths.add(skillMdPath);
    return parseSkillMd(skillMdPath, options);
  };

  // Pointing directly at a skill: add it and return early unless fullDepth.
  if (await hasSkillMd(searchPath)) {
    const skill = await parseSkillAt(searchPath);
    if (skill) {
      skills.push(skill);
      seenNames.add(skill.name);
      if (!options?.fullDepth) return skills;
    }
  }

  const prioritySearchDirs = [
    searchPath,
    join(searchPath, "skills"),
    join(searchPath, "skills/.curated"),
    join(searchPath, "skills/.experimental"),
    join(searchPath, "skills/.system"),
    ...AGENT_PROJECT_SKILL_DIRS.map((dir) => join(searchPath, dir)),
  ];
  // Known containers are walked three levels deep so layouts like
  // `skills/<category>/<skill>/SKILL.md` are found; the repo root keeps
  // depth-1 so unrelated `examples/foo/SKILL.md` files stay out.
  const deepContainerDirs = new Set(prioritySearchDirs.slice(1));

  const tryAddSkillAt = async (skillDir: string): Promise<boolean> => {
    if (!(await hasSkillMd(skillDir))) return false;
    const skill = await parseSkillAt(skillDir);
    if (!skill || seenNames.has(skill.name)) return true;
    skills.push(skill);
    seenNames.add(skill.name);
    return true;
  };

  const walkSkillDirs = async (dir: string, maxDepth: number, depth = 1): Promise<void> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const childDir = join(dir, entry.name);
        const foundAtChild = await tryAddSkillAt(childDir);
        if (foundAtChild || depth >= maxDepth || SKIP_DIRS.includes(entry.name)) continue;
        await walkSkillDirs(childDir, maxDepth, depth + 1);
      }
    } catch {
      // Directory doesn't exist or is unreadable; skip silently.
    }
  };

  for (const dir of prioritySearchDirs) {
    const walkDeep = deepContainerDirs.has(dir);
    await walkSkillDirs(dir, walkDeep ? DEFAULT_SKILL_CONTAINER_DEPTH : 1);
  }

  if (skills.length === 0 || options?.fullDepth) {
    for (const skillDir of await findSkillDirs(searchPath)) {
      const skill = await parseSkillAt(skillDir);
      if (skill && !seenNames.has(skill.name)) {
        skills.push(skill);
        seenNames.add(skill.name);
      }
    }
  }

  return skills;
}

export function getSkillDisplayName(skill: Skill): string {
  return skill.name || basename(skill.path);
}

export function filterSkills(skills: Skill[], inputNames: string[]): Skill[] {
  const normalizedInputs = inputNames.map((n) => n.toLowerCase());
  return skills.filter((skill) => {
    const name = skill.name.toLowerCase();
    const displayName = getSkillDisplayName(skill).toLowerCase();
    return normalizedInputs.some((input) => input === name || input === displayName);
  });
}

// ─── Install naming, copying, hashing ───

export function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return sanitized.substring(0, 255) || "unnamed-skill";
}

export function isPathSafe(basePath: string, targetPath: string): boolean {
  const normalizedBase = normalize(resolve(basePath));
  const normalizedTarget = normalize(resolve(targetPath));
  return normalizedTarget.startsWith(normalizedBase + sep) || normalizedTarget === normalizedBase;
}

const EXCLUDE_FILES = new Set(["metadata.json"]);
const EXCLUDE_DIRS = new Set([".git", "__pycache__", "__pypackages__"]);

function isExcluded(name: string, isDirectory: boolean): boolean {
  if (!isDirectory && EXCLUDE_FILES.has(name)) return true;
  if (isDirectory && EXCLUDE_DIRS.has(name)) return true;
  return false;
}

export async function copySkillDirectory(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => !isExcluded(entry.name, entry.isDirectory()))
      .map(async (entry) => {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (entry.isDirectory()) {
          await copySkillDirectory(srcPath, destPath);
        } else {
          try {
            // Dereference symlinks: a link inside a temp clone would dangle
            // once the clone is deleted.
            await cp(srcPath, destPath, { dereference: true, recursive: true });
            const sourceStats = await stat(srcPath);
            await chmod(destPath, sourceStats.mode & 0o777);
          } catch (err) {
            const isBrokenSymlink =
              err instanceof Error &&
              "code" in err &&
              (err as NodeJS.ErrnoException).code === "ENOENT" &&
              entry.isSymbolicLink();
            if (!isBrokenSymlink) throw err;
          }
        }
      }),
  );
}

/** Remove-then-recreate an install destination so stale files never linger. */
export async function cleanAndCreateDirectory(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

/**
 * SHA-256 over all files in a skill directory, sorted by relative path with
 * the path mixed into the hash so renames are detected. Matches the skills
 * CLI's `computeSkillFolderHash` byte for byte.
 */
export async function computeSkillFolderHash(skillDir: string): Promise<string> {
  const files: Array<{ relativePath: string; content: Buffer }> = [];
  await collectFiles(skillDir, skillDir, files);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

async function collectFiles(
  baseDir: string,
  currentDir: string,
  results: Array<{ relativePath: string; content: Buffer }>,
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") return;
        await collectFiles(baseDir, fullPath, results);
      } else if (entry.isFile()) {
        const content = await readFile(fullPath);
        results.push({ relativePath: relative(baseDir, fullPath).split(sep).join("/"), content });
      }
    }),
  );
}

/** Repo-relative `path/to/skill/SKILL.md` (posix separators) for lock tracking. */
export function toSkillPath(basePath: string, skillDir: string): string {
  return join(relative(basePath, skillDir), "SKILL.md").split(sep).join("/");
}
