import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeSkillFolderHash,
  discoverSkills,
  filterSkills,
  parseFrontmatter,
  parseSource,
  sanitizeName,
} from "./skills-core";

describe("parseSource", () => {
  it("parses owner/repo shorthand as a GitHub clone URL", () => {
    expect(parseSource("anthropics/skills")).toEqual({
      type: "github",
      url: "https://github.com/anthropics/skills.git",
      subpath: undefined,
    });
  });

  it("parses owner/repo/subpath shorthand", () => {
    expect(parseSource("anthropics/skills/document-skills/pdf")).toMatchObject({
      type: "github",
      url: "https://github.com/anthropics/skills.git",
      subpath: "document-skills/pdf",
    });
  });

  it("parses owner/repo@skill filters", () => {
    expect(parseSource("vercel-labs/agent-skills@react-best-practices")).toMatchObject({
      type: "github",
      skillFilter: "react-best-practices",
    });
  });

  it("parses #ref fragments with optional @skill", () => {
    expect(parseSource("owner/repo#v2")).toMatchObject({ type: "github", ref: "v2" });
    expect(parseSource("owner/repo#v2@pdf")).toMatchObject({
      type: "github",
      ref: "v2",
      skillFilter: "pdf",
    });
  });

  it("parses GitHub tree URLs with branch and path", () => {
    expect(parseSource("https://github.com/o/r/tree/main/skills/pdf")).toMatchObject({
      type: "github",
      url: "https://github.com/o/r.git",
      ref: "main",
      subpath: "skills/pdf",
    });
  });

  it("parses skills.sh detail URLs into GitHub sources with a skill filter", () => {
    expect(parseSource("https://skills.sh/anthropics/skills/pdf")).toMatchObject({
      type: "github",
      url: "https://github.com/anthropics/skills.git",
      skillFilter: "pdf",
    });
    expect(parseSource("https://www.skills.sh/anthropics/skills")).toMatchObject({
      type: "github",
      url: "https://github.com/anthropics/skills.git",
    });
  });

  it("parses GitLab URLs including /-/tree/ paths", () => {
    expect(parseSource("https://gitlab.com/group/sub/repo")).toMatchObject({
      type: "gitlab",
      url: "https://gitlab.com/group/sub/repo.git",
    });
    expect(parseSource("https://gitlab.com/o/r/-/tree/main/skills")).toMatchObject({
      type: "gitlab",
      ref: "main",
      subpath: "skills",
    });
  });

  it("treats SSH and file URLs as generic git sources", () => {
    expect(parseSource("git@github.com:o/r.git")).toMatchObject({ type: "git" });
    expect(parseSource("file:///tmp/some-repo")).toMatchObject({
      type: "git",
      url: "file:///tmp/some-repo",
    });
  });

  it("resolves absolute paths as local sources", () => {
    expect(parseSource("/tmp/skills-fixture")).toEqual({
      type: "local",
      url: "/tmp/skills-fixture",
      localPath: "/tmp/skills-fixture",
    });
  });

  it("rejects path-traversal subpaths", () => {
    expect(() => parseSource("o/r/../../etc")).toThrow(/Unsafe subpath/);
  });
});

describe("parseFrontmatter", () => {
  it("parses YAML frontmatter and returns the body", () => {
    const { data, content } = parseFrontmatter("---\nname: pdf\ndescription: d\n---\nBody");
    expect(data).toEqual({ name: "pdf", description: "d" });
    expect(content).toBe("Body");
  });

  it("returns empty data without frontmatter", () => {
    expect(parseFrontmatter("Just text").data).toEqual({});
  });
});

describe("sanitizeName", () => {
  it("kebab-cases and strips traversal attempts", () => {
    expect(sanitizeName("My Cool Skill")).toBe("my-cool-skill");
    expect(sanitizeName("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeName("...")).toBe("unnamed-skill");
  });
});

describe("discoverSkills", () => {
  let base: string;

  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true });
  });

  async function writeSkill(relDir: string, name: string, extra?: Record<string, string>) {
    const dir = join(base, relDir);
    await mkdir(dir, { recursive: true });
    const metadata = extra?.internal ? "metadata:\n  internal: true\n" : "";
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Test skill ${name}\n${metadata}---\n# ${name}\n`,
    );
  }

  it("returns a root skill directly without descending", async () => {
    base = await mkdtemp(join(tmpdir(), "skills-disc-"));
    await writeSkill(".", "root-skill");
    await writeSkill("skills/nested", "nested-skill");
    const skills = await discoverSkills(base);
    expect(skills.map((s) => s.name)).toEqual(["root-skill"]);
  });

  it("finds skills in containers up to three levels deep", async () => {
    base = await mkdtemp(join(tmpdir(), "skills-disc-"));
    await writeSkill("skills/pdf", "pdf");
    await writeSkill("skills/category/deep/docx", "docx");
    const skills = await discoverSkills(base);
    expect(skills.map((s) => s.name).sort()).toEqual(["docx", "pdf"]);
  });

  it("skips internal skills unless explicitly included", async () => {
    base = await mkdtemp(join(tmpdir(), "skills-disc-"));
    await writeSkill("skills/visible", "visible");
    await writeSkill("skills/hidden", "hidden", { internal: "true" });
    expect((await discoverSkills(base)).map((s) => s.name)).toEqual(["visible"]);
    expect(
      (await discoverSkills(base, undefined, { includeInternal: true })).map((s) => s.name).sort(),
    ).toEqual(["hidden", "visible"]);
  });

  it("skips SKILL.md files missing required frontmatter", async () => {
    base = await mkdtemp(join(tmpdir(), "skills-disc-"));
    await mkdir(join(base, "skills/broken"), { recursive: true });
    await writeFile(join(base, "skills/broken/SKILL.md"), "---\nname: only-name\n---\n");
    await writeSkill("skills/ok", "ok");
    expect((await discoverSkills(base)).map((s) => s.name)).toEqual(["ok"]);
  });

  it("falls back to a full recursive search when priority dirs are empty", async () => {
    base = await mkdtemp(join(tmpdir(), "skills-disc-"));
    await writeSkill("packages/tools/my-skill", "buried");
    expect((await discoverSkills(base)).map((s) => s.name)).toEqual(["buried"]);
  });
});

describe("computeSkillFolderHash", () => {
  it("is deterministic and detects renames and edits", async () => {
    const base = await mkdtemp(join(tmpdir(), "skills-hash-"));
    try {
      await writeFile(join(base, "SKILL.md"), "content");
      const first = await computeSkillFolderHash(base);
      expect(await computeSkillFolderHash(base)).toBe(first);

      await writeFile(join(base, "SKILL.md"), "changed");
      const edited = await computeSkillFolderHash(base);
      expect(edited).not.toBe(first);

      await writeFile(join(base, "SKILL.md"), "content");
      await writeFile(join(base, "extra.md"), "");
      expect(await computeSkillFolderHash(base)).not.toBe(first);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("filterSkills", () => {
  it("matches names case-insensitively", () => {
    const skills = [
      { name: "PDF", description: "", path: "/x/pdf" },
      { name: "docx", description: "", path: "/x/docx" },
    ];
    expect(filterSkills(skills, ["pdf"]).map((s) => s.name)).toEqual(["PDF"]);
    expect(filterSkills(skills, ["nope"])).toEqual([]);
  });
});
