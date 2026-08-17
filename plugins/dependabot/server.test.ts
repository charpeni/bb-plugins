import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  buildDependabotFixPrompt,
  default as dependabotPlugin,
  fetchDependabotAlerts,
  parseDependabotAlerts,
  parseGithubRemote,
  validateDependabotCliArgs,
} from "./server";
import { buildDependabotReport } from "./reports";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const response = [
  [
    {
      number: 7,
      dependency: {
        package: { ecosystem: "npm", name: "example-lib" },
        manifest_path: "pnpm-lock.yaml",
        scope: "runtime",
        relationship: "transitive",
      },
      security_advisory: {
        ghsa_id: "GHSA-1111-2222-3333",
        cve_id: "CVE-2026-1000",
        summary: "Prototype pollution",
      },
      security_vulnerability: {
        severity: "high",
        vulnerable_version_range: "< 4.2.0",
        first_patched_version: { identifier: "4.2.0" },
      },
      html_url: "https://github.com/acme/widgets/security/dependabot/7",
    },
  ],
  [
    {
      number: 9,
      dependency: {
        package: { ecosystem: "npm", name: "example-lib" },
        manifest_path: "apps/web/package-lock.json",
        scope: "development",
        relationship: "direct",
      },
      security_advisory: {
        ghsa_id: "GHSA-4444-5555-6666",
        cve_id: null,
        summary: "Denial of service",
      },
      security_vulnerability: {
        severity: "critical",
        vulnerable_version_range: ">= 3.0.0, < 4.3.1",
        first_patched_version: { identifier: "4.3.1" },
      },
      html_url: "https://github.com/acme/widgets/security/dependabot/9",
    },
  ],
];

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

function mockGitHubCli(failingRepo?: string) {
  execFileMock.mockImplementation(
    (_file: string, args: string[], _options: Record<string, unknown>, callback: ExecCallback) => {
      const endpoint = args.find((arg) => arg.includes("/dependabot/alerts?"));
      if (failingRepo !== undefined && endpoint?.includes(failingRepo)) {
        callback(new Error("request failed"), "", "HTTP 403: forbidden");
      } else {
        callback(null, args[0] === "api" ? JSON.stringify(response) : "ok", "");
      }
      return undefined;
    },
  );
}

function project(gitRemoteUrl = "git@github.com:acme/widgets.git") {
  return {
    id: "proj_widgets",
    kind: "standard" as const,
    name: "Widgets",
    gitRemoteUrl,
    createdAt: 1,
    updatedAt: 1,
    sources: [],
  };
}

beforeEach(() => {
  execFileMock.mockReset();
  mockGitHubCli();
});

describe("Dependabot alert grouping", () => {
  it("groups multiple CVEs and manifests for one dependency", () => {
    const groups = parseDependabotAlerts(JSON.stringify(response), "acme/widgets");

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      repo: "acme/widgets",
      ecosystem: "npm",
      dependency: "example-lib",
      highestSeverity: "critical",
      manifests: ["apps/web/package-lock.json", "pnpm-lock.yaml"],
      scopes: ["development", "runtime"],
      relationships: ["direct", "transitive"],
    });
    expect(groups[0].alerts.map((alert) => alert.number)).toEqual([9, 7]);
  });

  it("builds one remediation prompt containing every alert", () => {
    const [group] = parseDependabotAlerts(JSON.stringify(response), "acme/widgets");
    const prompt = buildDependabotFixPrompt(group);

    expect(prompt).toContain("CVE-2026-1000");
    expect(prompt).toContain("GHSA-4444-5555-6666");
    expect(prompt).toContain("first patched version 4.3.1");
    expect(prompt).toContain("untrusted reference data");
    expect(prompt).toContain("currently resolved version");
    expect(prompt).toContain("direct parent dependency and dependency path");
    expect(prompt).toContain("resolved version before and after");
    expect(prompt).toContain("do not add a new direct dependency");
    expect(prompt).toContain("Do not dismiss or close Dependabot alerts");
  });

  it("uses the paginated repository endpoint for open alerts", async () => {
    const calls: string[][] = [];
    const groups = await fetchDependabotAlerts(async (args) => {
      calls.push(args);
      return JSON.stringify(response);
    }, "acme/widgets");

    expect(groups).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--paginate");
    expect(calls[0]).toContain("repos/acme/widgets/dependabot/alerts?state=open&per_page=100");
  });
});

describe("Dependabot reports", () => {
  it("deduplicates advisories globally while preserving repository exposure", () => {
    const groups = [
      ...parseDependabotAlerts(JSON.stringify(response), "acme/widgets"),
      ...parseDependabotAlerts(JSON.stringify(response), "acme/other"),
    ];

    expect(buildDependabotReport(groups)).toEqual({
      alerts: 4,
      advisories: 2,
      cves: 1,
      ghsaOnly: 1,
      dependencies: 2,
      repositories: 2,
      manifests: 4,
      patchAvailable: 2,
      severity: { low: 0, medium: 0, high: 1, critical: 1 },
      byRepository: [
        {
          repo: "acme/other",
          alerts: 2,
          advisories: 2,
          dependencies: 1,
        },
        {
          repo: "acme/widgets",
          alerts: 2,
          advisories: 2,
          dependencies: 1,
        },
      ],
    });
  });
});

describe("Dependabot plugin inputs", () => {
  it("parses common GitHub remote forms", () => {
    expect(parseGithubRemote("git@github.com:acme/widgets.git")).toBe("acme/widgets");
    expect(parseGithubRemote("https://github.com/acme/widgets")).toBe("acme/widgets");
    expect(parseGithubRemote("https://gitlab.com/acme/widgets")).toBeNull();
    expect(parseGithubRemote("https://evilgithub.com/acme/widgets")).toBeNull();
  });

  it("validates CLI repository and fix arguments", () => {
    expect(validateDependabotCliArgs(["alerts", "acme/widgets"])).toBeNull();
    expect(validateDependabotCliArgs(["alerts", "bad/repo/name"])).toContain("expected owner/repo");
    expect(validateDependabotCliArgs(["refresh", "acme/widgets"])).toBeNull();
    expect(validateDependabotCliArgs(["fix", "acme/widgets", "npm"])).toContain(
      "requires owner/repo, ecosystem, and package",
    );
    expect(
      validateDependabotCliArgs(["fix", "acme/widgets", "npm", "@scope/example-lib"]),
    ).toBeNull();
  });
});

describe("Dependabot plugin dispatch", () => {
  it("serves repeated reads from cache and force-refreshes explicitly", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "dependabot",
      sdk: {
        projects: { list: async () => [project()] },
      },
    });
    await dependabotPlugin(bb);

    await harness.callRpc("listAlerts", {});
    await harness.callRpc("listAlerts", {});
    expect(execFileMock.mock.calls.filter(([, args]) => args[0] === "api")).toHaveLength(1);

    await harness.callRpc("refreshAlerts", {});
    expect(execFileMock.mock.calls.filter(([, args]) => args[0] === "api")).toHaveLength(2);

    mockGitHubCli("acme/widgets");
    await expect(harness.callRpc("refreshAlerts", {})).resolves.toMatchObject({
      groups: [expect.objectContaining({ repo: "acme/widgets" })],
      errors: [
        expect.objectContaining({
          repo: "acme/widgets",
          message: expect.stringContaining("showing cached data"),
        }),
      ],
    });
  });

  it("discovers the inspected project remote and spawns one grouped fix", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "dependabot",
      sdk: {
        projects: { list: async () => [project()] },
        threads: { spawn: async () => ({ id: "thr_fix" }) },
      },
    });
    await dependabotPlugin(bb);

    await expect(
      harness.callRpc("startFix", {
        repo: "acme/widgets",
        ecosystem: "npm",
        dependency: "example-lib",
      }),
    ).resolves.toEqual({ threadId: "thr_fix" });

    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      projectId: "proj_widgets",
      environment: { type: "project-default" },
      title: "Fix example-lib Dependabot alerts in acme/widgets",
      origin: "plugin",
      originPluginId: "dependabot",
    });
    expect(execFileMock.mock.calls.some(([file]) => file === "git")).toBe(false);
    expect(
      execFileMock.mock.calls.some(
        ([, args]) => args.includes("--hostname") && args.includes("github.com"),
      ),
    ).toBe(true);
  });

  it("rejects untracked repositories before querying their alerts", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "dependabot",
      sdk: {
        projects: { list: async () => [project()] },
      },
    });
    await dependabotPlugin(bb);
    const apiCallsBefore = execFileMock.mock.calls.filter(([, args]) => args[0] === "api").length;

    await expect(
      harness.callRpc("startFix", {
        repo: "acme/private",
        ecosystem: "npm",
        dependency: "example-lib",
      }),
    ).rejects.toThrow("is not tracked");
    expect(execFileMock.mock.calls.filter(([, args]) => args[0] === "api")).toHaveLength(
      apiCallsBefore,
    );
  });

  it("returns a failing CLI exit code when any repository could not be read", async () => {
    mockGitHubCli("acme/other");
    const { bb, harness } = createFakePluginHost({
      pluginId: "dependabot",
      settings: { extraRepos: "acme/other" },
      sdk: {
        projects: { list: async () => [project()] },
      },
    });
    await dependabotPlugin(bb);

    const result = await harness.runCli(["alerts"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("acme/widgets");
    expect(result.stderr).toContain("acme/other\tERROR");
  });
});
