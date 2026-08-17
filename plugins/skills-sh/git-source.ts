/**
 * Git and GitHub transport for skill sources, ported from the `skills` CLI:
 * shallow clones into a temp dir, git tree hashes for skill folders, and the
 * GitHub Trees API fast path used by update checks.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLONE_TIMEOUT_MS = 300_000;
const ALLOWED_GIT_PROTOCOLS = "https:http:ssh:git:file";

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: ALLOWED_GIT_PROTOCOLS,
    // Skip LFS content during checkout; skills are plain text and LFS
    // pointers are never read by the installer.
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

export async function cloneRepo(url: string, ref?: string): Promise<string> {
  if (/^ext::/i.test(url)) {
    throw new Error("Unsupported Git transport: ext");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "bb-skills-"));
  const args = [
    // Disable the LFS filter entirely so checkout succeeds whether or not
    // git-lfs is installed (see vercel-labs/skills for the full rationale).
    "-c",
    "filter.lfs.required=false",
    "-c",
    "filter.lfs.smudge=",
    "-c",
    "filter.lfs.clean=",
    "-c",
    "filter.lfs.process=",
    "clone",
    "--depth",
    "1",
    ...(ref ? ["--branch", ref] : []),
    "--",
    url,
    tempDir,
  ];

  try {
    await execFileAsync("git", args, { timeout: CLONE_TIMEOUT_MS, env: gitEnv() });
    return tempDir;
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to clone ${url}: ${message}`);
  }
}

/**
 * Resolve the git tree object SHA for a skill folder inside a clone. Matches
 * the folder SHA served by GitHub's Trees API, so a lock entry written from a
 * clone compares cleanly against an API-side check later.
 */
export async function getGitTreeHash(repoDir: string, skillPath: string): Promise<string | null> {
  const segments = skillPath.replace(/\\/g, "/").split("/");
  segments.pop();
  const folderPath = segments.join("/");
  const revision = folderPath ? `HEAD:${folderPath}` : "HEAD^{tree}";

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", "--end-of-options", revision],
      {
        timeout: CLONE_TIMEOUT_MS,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
    );
    const hash = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(hash) ? hash.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function cleanupTempDir(dir: string): Promise<void> {
  const normalizedDir = normalize(resolve(dir));
  const normalizedTmpDir = normalize(resolve(tmpdir()));
  if (!normalizedDir.startsWith(normalizedTmpDir + sep) && normalizedDir !== normalizedTmpDir) {
    throw new Error("Attempted to clean up directory outside of temp directory");
  }
  await rm(dir, { recursive: true, force: true });
}

// ─── GitHub Trees API fast path ───

export interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  sha: string;
}

export interface RepoTree {
  sha: string;
  tree: TreeEntry[];
}

function getGitHubToken(): string | null {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

async function fetchTreeBranch(ownerRepo: string, branch: string): Promise<RepoTree | null> {
  const url = `https://api.github.com/repos/${ownerRepo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "bb-plugin-skills-sh",
  };
  const token = getGitHubToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    sha?: string;
    truncated?: boolean;
    tree?: Array<{ path?: string; type?: string; sha?: string }>;
  };
  // A truncated tree could hide the skill folder; treat it as unavailable so
  // callers fall back to a clone-based comparison instead of a false verdict.
  if (!data.sha || !Array.isArray(data.tree) || data.truncated) return null;
  return {
    sha: data.sha,
    tree: data.tree
      .filter(
        (entry): entry is { path: string; type: "blob" | "tree"; sha: string } =>
          typeof entry.path === "string" &&
          (entry.type === "blob" || entry.type === "tree") &&
          typeof entry.sha === "string",
      )
      .map((entry) => ({ path: entry.path, type: entry.type, sha: entry.sha })),
  };
}

export async function fetchRepoTree(ownerRepo: string, ref?: string): Promise<RepoTree | null> {
  const branches = ref ? [ref] : ["HEAD", "main", "master"];
  for (const branch of branches) {
    try {
      const tree = await fetchTreeBranch(ownerRepo, branch);
      if (tree) return tree;
    } catch {
      return null;
    }
  }
  return null;
}

/** Extract the folder tree SHA for a skill path from a fetched repo tree. */
export function getSkillFolderHashFromTree(tree: RepoTree, skillPath: string): string | null {
  let folderPath = skillPath.replace(/\\/g, "/");
  if (folderPath.toLowerCase().endsWith("/skill.md")) {
    folderPath = folderPath.slice(0, -9);
  } else if (folderPath.toLowerCase().endsWith("skill.md")) {
    folderPath = folderPath.slice(0, -8);
  }
  if (folderPath.endsWith("/")) folderPath = folderPath.slice(0, -1);

  if (!folderPath) return tree.sha;
  const entry = tree.tree.find((e) => e.type === "tree" && e.path === folderPath);
  return entry?.sha ?? null;
}
