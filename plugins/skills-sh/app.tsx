import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { skillsRpcContract } from "./server.js";

type StatusResult = PluginRpcResult<(typeof skillsRpcContract)["status"]>;
type InstalledSkill = StatusResult["skills"][number];
type SearchPage = PluginRpcResult<(typeof skillsRpcContract)["search"]>;
type SearchSkill = SearchPage["skills"][number];
type CheckEntry = PluginRpcResult<(typeof skillsRpcContract)["check"]>["results"][number];

const STATUS_BADGES: Record<CheckEntry["status"], { label: string; className: string }> = {
  "up-to-date": {
    label: "Up to date",
    className: "bg-success/10 text-success",
  },
  "update-available": {
    label: "Update available",
    className: "bg-attention/15 text-attention",
  },
  "deleted-upstream": {
    label: "Deleted upstream",
    className: "bg-destructive/10 text-destructive",
  },
  skipped: {
    label: "Not tracked",
    className: "bg-surface-recessed text-muted-foreground",
  },
  error: {
    label: "Check failed",
    className: "bg-destructive/10 text-destructive",
  },
};

function formatInstalls(installs: number): string {
  if (installs >= 1_000_000) return `${(installs / 1_000_000).toFixed(1)}M`;
  if (installs >= 1_000) return `${(installs / 1_000).toFixed(1)}k`;
  return String(installs);
}

function Button({
  children,
  onClick,
  disabled,
  tone = "default",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "destructive";
}) {
  const toneClasses =
    tone === "primary"
      ? "bg-primary text-primary-foreground hover:opacity-90"
      : tone === "destructive"
        ? "border text-destructive hover:bg-destructive/10"
        : "border hover:bg-surface-recessed";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClasses}`}
    >
      {children}
    </button>
  );
}

function SearchResultRow({
  skill,
  installedNames,
  busy,
  onInstall,
}: {
  skill: SearchSkill;
  installedNames: Set<string>;
  busy: string | null;
  onInstall: (skill: SearchSkill) => void;
}) {
  const installed = installedNames.has(skill.skillId) || installedNames.has(skill.name);
  const installing = busy === `install:${skill.id}`;
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <a
            href={skill.url}
            target="_blank"
            rel="noreferrer"
            className="truncate text-sm font-medium hover:underline"
          >
            {skill.name}
          </a>
          <span className="truncate text-xs text-muted-foreground">{skill.source}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatInstalls(skill.installs)} installs
          </span>
        </div>
        {skill.summary ? (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{skill.summary}</p>
        ) : null}
      </div>
      <div className="shrink-0">
        {installed ? (
          <span className="rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
            Installed
          </span>
        ) : (
          <Button tone="primary" onClick={() => onInstall(skill)} disabled={busy !== null}>
            {installing ? "Installing…" : "Install"}
          </Button>
        )}
      </div>
    </li>
  );
}

function InstalledRow({
  skill,
  check,
  busy,
  onUpdate,
  onRemove,
}: {
  skill: InstalledSkill;
  check: CheckEntry | undefined;
  busy: string | null;
  onUpdate: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  const badge = check ? STATUS_BADGES[check.status] : null;
  const updating = busy === `update:${skill.installName}`;
  const removing = busy === `remove:${skill.installName}`;
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <p className="truncate text-sm font-medium">{skill.installName}</p>
          {badge ? (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
              title={check?.detail}
            >
              {badge.label}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs tabular-nums text-muted-foreground">
          {skill.skillFolderHash ? skill.skillFolderHash.slice(0, 12) : "untracked"} · updated{" "}
          {skill.updatedAt.slice(0, 10)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {check?.status === "update-available" ? (
          <Button
            tone="primary"
            onClick={() => onUpdate(skill.installName)}
            disabled={busy !== null}
          >
            {updating ? "Updating…" : "Update"}
          </Button>
        ) : null}
        <Button
          tone="destructive"
          onClick={() => onRemove(skill.installName)}
          disabled={busy !== null}
        >
          {removing ? "Removing…" : "Remove"}
        </Button>
      </div>
    </li>
  );
}

interface InstalledGroup {
  /** Origin label: owner/repo (plus #ref) when known, else the URL/path. */
  label: string;
  /** Repo link for http(s) sources; null for SSH/local origins. */
  url: string | null;
  skills: InstalledSkill[];
}

function groupBySource(skills: InstalledSkill[]): InstalledGroup[] {
  const groups = new Map<string, InstalledGroup>();
  for (const skill of skills) {
    const label = `${skill.source}${skill.ref ? `#${skill.ref}` : ""}`;
    let group = groups.get(label);
    if (!group) {
      const url = skill.sourceUrl.startsWith("http") ? skill.sourceUrl.replace(/\.git$/, "") : null;
      group = { label, url, skills: [] };
      groups.set(label, group);
    }
    group.skills.push(skill);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function SkillsPanel() {
  const rpc = useRpc<typeof skillsRpcContract>();
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckEntry>>({});
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchPage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const installedNames = useMemo(
    () => new Set((status?.skills ?? []).map((skill) => skill.installName)),
    [status],
  );
  const installedGroups = useMemo(() => groupBySource(status?.skills ?? []), [status]);
  const updatesAvailable = useMemo(
    () => Object.values(checks).filter((c) => c.status === "update-available").length,
    [checks],
  );

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await rpc.call("status", null));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const search = (nextQuery: string) =>
    run("search", async () => {
      setResults(await rpc.call("search", { query: nextQuery }));
    });

  const installFromRegistry = (skill: SearchSkill) =>
    run(`install:${skill.id}`, async () => {
      const { installed } = await rpc.call("install", {
        source: skill.source,
        skills: [skill.skillId],
      });
      setNotice(`Installed ${installed.map((s) => s.installName).join(", ")}`);
      await refreshStatus();
    });

  const installFromSource = () =>
    run("install:source", async () => {
      const { installed } = await rpc.call("install", { source: query.trim() });
      setNotice(`Installed ${installed.map((s) => s.installName).join(", ")}`);
      await refreshStatus();
    });

  const checkForUpdates = () =>
    run("check", async () => {
      const { results: checkResults } = await rpc.call("check", {});
      setChecks(Object.fromEntries(checkResults.map((result) => [result.installName, result])));
    });

  const update = (names?: string[]) =>
    run(names?.length === 1 ? `update:${names[0]}` : "update:all", async () => {
      const report = await rpc.call("update", names ? { skills: names } : {});
      if (report.updated.length > 0) {
        setNotice(`Updated ${report.updated.map((s) => s.installName).join(", ")}`);
      } else if (report.failed.length === 0) {
        setNotice("All skills are up to date");
      }
      if (report.failed.length > 0) {
        setError(
          report.failed.map(({ installName, error: e }) => `${installName}: ${e}`).join("; "),
        );
      }
      setChecks({});
      await refreshStatus();
    });

  const remove = (name: string) =>
    run(`remove:${name}`, async () => {
      await rpc.call("remove", { skills: [name] });
      setChecks((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      await refreshStatus();
    });

  const trimmedQuery = query.trim();
  const looksLikeSource =
    trimmedQuery.includes("/") && !trimmedQuery.includes(" ") && trimmedQuery.length > 2;

  return (
    <div className="h-full overflow-y-auto bg-background">
      <main className="mx-auto w-full max-w-3xl p-4 md:p-6">
        <header className="mb-5 pt-12 md:pt-0">
          <h1 className="text-base font-semibold">Skills.sh</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Install agent skills from skills.sh once, globally — every AI agent bb runs picks them
            up. Kept in sync with their source, 1:1 with the npx skills CLI.
          </p>
          {status ? (
            <code className="mt-2 inline-block max-w-full truncate rounded-md bg-surface-recessed px-2 py-1 text-xs text-muted-foreground">
              {status.skillsRoot}
            </code>
          ) : null}
        </header>

        {error ? (
          <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="mb-4 rounded-lg border border-success/40 bg-success/10 p-3 text-sm text-success">
            {notice}
          </div>
        ) : null}

        <section className="rounded-xl border bg-card p-4 shadow-sm">
          <h2 className="text-sm font-semibold">Find skills</h2>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void search(trimmedQuery);
            }}
          >
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search skills.sh, or paste owner/repo or a skills.sh URL"
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
            />
            <Button onClick={() => void search(trimmedQuery)} disabled={busy !== null}>
              {busy === "search" ? "Searching…" : "Search"}
            </Button>
          </form>
          {looksLikeSource ? (
            <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-surface-recessed p-2 pl-3">
              <p className="truncate text-xs text-muted-foreground">
                Install every skill from <code className="text-foreground">{trimmedQuery}</code>
              </p>
              <Button tone="primary" onClick={installFromSource} disabled={busy !== null}>
                {busy === "install:source" ? "Installing…" : "Install from source"}
              </Button>
            </div>
          ) : null}
          {results ? (
            results.skills.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-2">
                {results.skills.map((skill) => (
                  <SearchResultRow
                    key={skill.id}
                    skill={skill}
                    installedNames={installedNames}
                    busy={busy}
                    onInstall={(s) => void installFromRegistry(s)}
                  />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No skills found on skills.sh.</p>
            )
          ) : null}
        </section>

        <section className="mt-4 rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">Installed skills</h2>
              <p className="text-sm text-muted-foreground">
                {status
                  ? `${status.skills.length} skill(s)` +
                    (updatesAvailable > 0 ? ` · ${updatesAvailable} update(s) available` : "")
                  : "Loading…"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => void checkForUpdates()}
                disabled={busy !== null || !status || status.skills.length === 0}
              >
                {busy === "check" ? "Checking…" : "Check for updates"}
              </Button>
              {updatesAvailable > 0 ? (
                <Button tone="primary" onClick={() => void update()} disabled={busy !== null}>
                  {busy === "update:all" ? "Updating…" : `Update all (${updatesAvailable})`}
                </Button>
              ) : null}
            </div>
          </div>

          {status && status.skills.length === 0 ? (
            <p className="mt-4 rounded-lg bg-surface-recessed p-4 text-sm text-muted-foreground">
              Nothing installed yet. Search above or run{" "}
              <code className="text-foreground">bb skills add owner/repo</code>.
            </p>
          ) : null}

          <div className="mt-3 flex flex-col gap-4">
            {installedGroups.map((group) => {
              const isCollapsed = collapsedGroups[group.label] === true;
              const groupUpdates = group.skills.filter(
                (skill) => checks[skill.installName]?.status === "update-available",
              ).length;
              return (
                <div key={group.label}>
                  <div className="flex items-center justify-between gap-2 px-1">
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      onClick={() =>
                        setCollapsedGroups((prev) => ({
                          ...prev,
                          [group.label]: !prev[group.label],
                        }))
                      }
                      className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        className={`size-3 shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                        aria-hidden="true"
                      >
                        <path
                          d="M9 18l6-6-6-6"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span className="truncate">{group.label}</span>
                    </button>
                    <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                      {isCollapsed && groupUpdates > 0 ? (
                        <span className="font-medium text-attention">{groupUpdates} update(s)</span>
                      ) : null}
                      {group.skills.length} skill(s)
                      {group.url ? (
                        <a
                          href={group.url}
                          target="_blank"
                          rel="noreferrer"
                          title={`Open ${group.label}`}
                          className="transition-colors hover:text-foreground"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            className="size-3"
                            aria-hidden="true"
                          >
                            <path
                              d="M7 17L17 7M9 7h8v8"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </a>
                      ) : null}
                    </span>
                  </div>
                  {isCollapsed ? null : (
                    <ul className="mt-1.5 flex flex-col gap-2">
                      {group.skills.map((skill) => (
                        <InstalledRow
                          key={skill.installName}
                          skill={skill}
                          check={checks[skill.installName]}
                          busy={busy}
                          onUpdate={(name) => void update([name])}
                          onRemove={(name) => void remove(name)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "skills-sh",
    title: "Skills.sh",
    // The sidebar prefers the plugin's logo (assets/skills-sh.svg, a sparkles
    // glyph); this name is only a fallback and must exist in bb's icon set.
    icon: "Star",
    path: "skills",
    component: SkillsPanel,
  });
});
