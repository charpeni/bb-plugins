import { useDeferredValue, useEffect, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { DependabotGroup, DependabotGroupWithFix, dependabotRpcContract } from "./server.js";
import { buildDependabotReport } from "./reports.js";

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      groups: DependabotGroupWithFix[];
      errors: Array<{ repo: string; message: string }>;
    }
  | { status: "error"; message: string };

const REPOSITORY_FILTER_KEY = "bb-plugin-dependabot:repository-filter";
const SEARCH_FILTER_KEY = "bb-plugin-dependabot:search-filter";

function readLocalFilter(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeLocalFilter(key: string, value: string): void {
  try {
    if (value.length === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorSummary(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("showing cached data")) return "Using cached alerts";
  if (normalized.includes("dependabot alerts are disabled")) {
    return "Dependabot alerts disabled";
  }
  if (normalized.includes("not authenticated")) {
    return "GitHub authentication required";
  }
  if (normalized.includes("403") || normalized.includes("forbidden")) {
    return "Dependabot alerts unavailable";
  }
  return "Could not load Dependabot alerts";
}

function severityClasses(severity: DependabotGroup["highestSeverity"]): string {
  if (severity === "critical") {
    return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
  }
  if (severity === "high") {
    return "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  }
  if (severity === "medium") {
    return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300";
}

function severityBarClass(severity: DependabotGroup["highestSeverity"]): string {
  if (severity === "critical") return "bg-red-500";
  if (severity === "high") return "bg-orange-500";
  if (severity === "medium") return "bg-amber-500";
  return "bg-blue-500";
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: number | string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background/60 p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</dd>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function ExposureReport({ groups }: { groups: DependabotGroup[] }) {
  const report = buildDependabotReport(groups);
  const severityOrder = ["critical", "high", "medium", "low"] as const;
  const maxSeverity = Math.max(1, ...severityOrder.map((severity) => report.severity[severity]));
  const maxRepository = Math.max(
    1,
    ...report.byRepository.map((repository) => repository.advisories),
  );
  const patchPercentage =
    report.advisories === 0 ? 0 : Math.round((report.patchAvailable / report.advisories) * 100);

  return (
    <section
      aria-labelledby="exposure-heading"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex flex-col gap-1 border-b border-border px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 id="exposure-heading" className="font-semibold text-foreground">
          Exposure overview
        </h2>
        <p className="text-xs text-muted-foreground">
          Current view · deduplicated by GitHub advisory
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
        <Metric
          label="CVEs"
          value={report.cves}
          detail={`${report.ghsaOnly} additional GHSA-only`}
        />
        <Metric
          label="Open alerts"
          value={report.alerts}
          detail={`${report.advisories} unique advisories`}
        />
        <Metric
          label="Dependencies"
          value={report.dependencies}
          detail={`${report.manifests} affected manifests`}
        />
        <Metric
          label="Patch available"
          value={`${patchPercentage}%`}
          detail={`${report.patchAvailable} of ${report.advisories} advisories`}
        />
      </dl>

      <div className="grid border-t border-border lg:grid-cols-2 lg:divide-x lg:divide-border">
        <div className="p-4">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-medium text-foreground">Risk distribution</h3>
            <span className="text-xs text-muted-foreground">unique advisories</span>
          </div>
          <div
            className="space-y-3"
            role="img"
            aria-label={`${report.severity.critical} critical, ${report.severity.high} high, ${report.severity.medium} medium, and ${report.severity.low} low severity advisories`}
          >
            {severityOrder.map((severity) => {
              const count = report.severity[severity];
              return (
                <div key={severity} className="grid grid-cols-[4.5rem_1fr_2rem] items-center gap-2">
                  <span className="text-xs font-medium capitalize text-muted-foreground">
                    {severity}
                  </span>
                  <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${severityBarClass(severity)}`}
                      style={{
                        width: `${(count / maxSeverity) * 100}%`,
                        minWidth: count > 0 ? "0.5rem" : 0,
                      }}
                    />
                  </div>
                  <span className="text-right font-mono text-xs tabular-nums text-foreground">
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="border-t border-border p-4 lg:border-t-0">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-medium text-foreground">Repository exposure</h3>
            <span className="text-xs text-muted-foreground">
              {report.repositories} repositories
            </span>
          </div>
          <div className="space-y-3">
            {report.byRepository.map((repository) => (
              <div key={repository.repo}>
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <span
                    className="min-w-0 truncate text-xs font-medium text-foreground"
                    title={repository.repo}
                  >
                    {repository.repo}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {repository.advisories} advisories · {repository.dependencies} deps
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{
                      width: `${(repository.advisories / maxRepository) * 100}%`,
                      minWidth: repository.advisories > 0 ? "0.5rem" : 0,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function AlertGroupCard({ group }: { group: DependabotGroupWithFix }) {
  const rpc = useRpc<typeof dependabotRpcContract>();
  const navigate = useBbNavigate();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startFix() {
    setStarting(true);
    setError(null);
    try {
      const result = await rpc.call("startFix", {
        repo: group.repo,
        ecosystem: group.ecosystem,
        dependency: group.dependency,
      });
      navigate.toThread(result.threadId);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setStarting(false);
    }
  }

  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <header className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="break-all text-base font-semibold text-foreground">
              {group.dependency}
            </h2>
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {group.ecosystem}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${severityClasses(group.highestSeverity)}`}
            >
              {group.highestSeverity}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {group.repo} · {group.alerts.length} alert
            {group.alerts.length === 1 ? "" : "s"} · {group.manifests.join(", ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {group.fixThread !== null ? (
            <span className="text-xs text-muted-foreground" role="status">
              {
                {
                  pending: "Fix queued",
                  starting: "Agent starting",
                  active: "Agent working",
                  idle: "Thread idle",
                  error: "Thread needs attention",
                  stopping: "Agent stopping",
                }[group.fixThread.status]
              }
            </span>
          ) : null}
          <button
            type="button"
            disabled={starting}
            onClick={() =>
              group.fixThread === null
                ? void startFix()
                : navigate.toThread(group.fixThread.threadId)
            }
            className="h-9 shrink-0 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {starting
              ? "Starting agent..."
              : group.fixThread === null
                ? "Fix with agent"
                : "Open fix thread"}
          </button>
        </div>
      </header>

      <div className="divide-y divide-border">
        {group.alerts.map((alert) => (
          <div key={alert.number} className="grid gap-2 px-4 py-3 md:grid-cols-[9rem_1fr]">
            <div className="flex flex-wrap items-center gap-2 md:block">
              <a
                href={alert.url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-sm font-medium text-foreground underline-offset-4 hover:underline"
              >
                {alert.cveId ?? alert.ghsaId}
              </a>
              <span
                className={`ml-0 inline-block rounded-full border px-1.5 py-0.5 text-xs capitalize md:ml-0 md:mt-1 ${severityClasses(alert.severity)}`}
              >
                {alert.severity}
              </span>
            </div>
            <div className="min-w-0">
              <p className="text-sm text-foreground">{alert.summary}</p>
              <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
                vulnerable {alert.vulnerableVersionRange}
                {alert.firstPatchedVersion === null
                  ? " · no patched version listed"
                  : ` · patched in ${alert.firstPatchedVersion}`}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {alert.manifestPath}
                {alert.relationship !== null ? ` · ${alert.relationship}` : ""}
                {alert.scope !== null ? ` · ${alert.scope}` : ""}
                {` · alert #${alert.number}`}
              </p>
            </div>
          </div>
        ))}
      </div>
      {error !== null ? (
        <p className="border-t border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function DependabotPanel(_props: PluginNavPanelProps) {
  const rpc = useRpc<typeof dependabotRpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [repos, setRepos] = useState<string[]>([]);
  const [selectedRepo, setSelectedRepo] = useState(() => readLocalFilter(REPOSITORY_FILTER_KEY));
  const [query, setQuery] = useState(() => readLocalFilter(SEARCH_FILTER_KEY));
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [authError, setAuthError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ status: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useRealtime("alerts-changed", () => {
    setRefreshKey((current) => current + 1);
  });

  useEffect(() => {
    const timer = window.setInterval(() => setRefreshKey((current) => current + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void rpc.call("status").then(
      (result) => {
        if (cancelled) return;
        const nextRepos = result.repos.map((entry) => entry.repo);
        setRepos(nextRepos);
        setSelectedRepo((current) => {
          if (current === "" || nextRepos.includes(current)) return current;
          writeLocalFilter(REPOSITORY_FILTER_KEY, "");
          return "";
        });
        setAuthError(result.ghOk ? null : (result.ghError ?? "GitHub CLI is not authenticated."));
      },
      (error: unknown) => {
        if (!cancelled) setAuthError(errorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    setLoadState((current) => (current.status === "ready" ? current : { status: "loading" }));
    void rpc.call("listAlerts", selectedRepo === "" ? {} : { repo: selectedRepo }).then(
      (result) => {
        if (!cancelled) {
          setLoadState({
            status: "ready",
            groups: result.groups,
            errors: result.errors,
          });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoadState({ status: "error", message: errorMessage(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, selectedRepo, refreshKey, connectionState]);

  async function refresh() {
    setRefreshing(true);
    try {
      const result = await rpc.call(
        "refreshAlerts",
        selectedRepo === "" ? {} : { repo: selectedRepo },
      );
      setLoadState({
        status: "ready",
        groups: result.groups,
        errors: result.errors,
      });
    } catch (error) {
      setLoadState({ status: "error", message: errorMessage(error) });
    } finally {
      setRefreshing(false);
    }
  }

  const groups =
    loadState.status !== "ready" || deferredQuery.length === 0
      ? loadState.status === "ready"
        ? loadState.groups
        : []
      : loadState.groups.filter((group) => {
          const identifiers = group.alerts
            .map((alert) => `${alert.cveId ?? ""} ${alert.ghsaId} ${alert.summary}`)
            .join(" ");
          return `${group.repo} ${group.ecosystem} ${group.dependency} ${identifiers}`
            .toLowerCase()
            .includes(deferredQuery);
        });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background p-3 sm:p-5">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border bg-muted/40 px-4 py-4">
            <p className="max-w-3xl text-sm text-muted-foreground">
              Open Dependabot alerts are grouped by package, so one agent can update a dependency
              once and address every related CVE across its manifests. Results are cached locally
              and refreshed automatically every five minutes.
            </p>
          </div>
          <div className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)_auto]">
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                writeLocalFilter(SEARCH_FILTER_KEY, event.target.value);
              }}
              placeholder="Filter dependency, CVE, repository..."
              className="h-9 min-w-0 rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
            />
            <select
              value={selectedRepo}
              onChange={(event) => {
                setSelectedRepo(event.target.value);
                writeLocalFilter(REPOSITORY_FILTER_KEY, event.target.value);
              }}
              className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
              aria-label="Repository"
            >
              <option value="">All tracked repositories</option>
              {repos.map((repo) => (
                <option key={repo} value={repo}>
                  {repo}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={refreshing}
              onClick={() => void refresh()}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </section>

        {authError !== null ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
            {authError}
          </div>
        ) : null}

        {loadState.status === "loading" ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            Loading Dependabot alerts...
          </div>
        ) : loadState.status === "error" ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
            {loadState.message}
          </div>
        ) : (
          <>
            {loadState.errors.map((error) => (
              <details
                key={error.repo}
                className="group overflow-hidden rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs marker:hidden">
                  <span
                    className="shrink-0 transition-transform group-open:rotate-90"
                    aria-hidden="true"
                  >
                    ▸
                  </span>
                  <strong className="min-w-0 truncate text-foreground">{error.repo}</strong>
                  <span className="ml-auto shrink-0 text-amber-700 dark:text-amber-300">
                    {errorSummary(error.message)}
                  </span>
                </summary>
                <p className="whitespace-pre-wrap break-words border-t border-amber-500/20 px-3 py-2 font-mono text-xs leading-relaxed">
                  {error.message}
                </p>
              </details>
            ))}
            {groups.length === 0 ? (
              <div className="rounded-xl border border-border bg-card p-8 text-center">
                <p className="font-medium text-foreground">
                  {loadState.groups.length === 0
                    ? loadState.errors.length === 0
                      ? "No open Dependabot alerts."
                      : "No alert data was returned."
                    : "No dependency groups match this filter."}
                </p>
                {repos.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Add a GitHub checkout to a BB project or configure extraRepos in this plugin's
                    settings.
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                <ExposureReport groups={groups} />
                <div className="flex items-baseline justify-between gap-3 px-1 pt-1">
                  <h2 className="font-semibold text-foreground">Dependency groups</h2>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {groups.length} groups
                  </span>
                </div>
                {groups.map((group) => (
                  <AlertGroupCard
                    key={`${group.repo}:${group.ecosystem}:${group.dependency}`}
                    group={group}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "dependabot",
    title: "Dependabot",
    icon: "ShieldBlockchain",
    path: "dependabot",
    component: DependabotPanel,
  });
});
