import type { DependabotGroup } from "./server.js";

type Severity = DependabotGroup["highestSeverity"];

export interface DependabotReport {
  alerts: number;
  advisories: number;
  cves: number;
  ghsaOnly: number;
  dependencies: number;
  repositories: number;
  manifests: number;
  patchAvailable: number;
  severity: Record<Severity, number>;
  byRepository: Array<{
    repo: string;
    alerts: number;
    advisories: number;
    dependencies: number;
  }>;
}

const SEVERITY_WEIGHT: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function emptySeverity(): Record<Severity, number> {
  return { low: 0, medium: 0, high: 0, critical: 0 };
}

export function buildDependabotReport(groups: DependabotGroup[]): DependabotReport {
  const advisories = new Map<
    string,
    { severity: Severity; hasCve: boolean; patchAvailable: boolean }
  >();
  const cves = new Set<string>();
  const manifests = new Set<string>();
  const byRepository = new Map<
    string,
    {
      alerts: number;
      dependencies: number;
      advisoryIds: Set<string>;
    }
  >();
  let alertCount = 0;

  for (const group of groups) {
    let repository = byRepository.get(group.repo);
    if (repository === undefined) {
      repository = { alerts: 0, dependencies: 0, advisoryIds: new Set() };
      byRepository.set(group.repo, repository);
    }
    repository.dependencies += 1;
    repository.alerts += group.alerts.length;
    alertCount += group.alerts.length;

    for (const manifest of group.manifests) {
      manifests.add(`${group.repo}\u0000${manifest}`);
    }
    for (const alert of group.alerts) {
      repository.advisoryIds.add(alert.ghsaId);
      if (alert.cveId !== null) cves.add(alert.cveId);
      const existing = advisories.get(alert.ghsaId);
      if (existing === undefined) {
        advisories.set(alert.ghsaId, {
          severity: alert.severity,
          hasCve: alert.cveId !== null,
          patchAvailable: alert.firstPatchedVersion !== null,
        });
        continue;
      }
      existing.hasCve ||= alert.cveId !== null;
      existing.patchAvailable ||= alert.firstPatchedVersion !== null;
      if (SEVERITY_WEIGHT[alert.severity] > SEVERITY_WEIGHT[existing.severity]) {
        existing.severity = alert.severity;
      }
    }
  }

  const severity = emptySeverity();
  let ghsaOnly = 0;
  let patchAvailable = 0;
  for (const advisory of advisories.values()) {
    severity[advisory.severity] += 1;
    if (!advisory.hasCve) ghsaOnly += 1;
    if (advisory.patchAvailable) patchAvailable += 1;
  }

  return {
    alerts: alertCount,
    advisories: advisories.size,
    cves: cves.size,
    ghsaOnly,
    dependencies: groups.length,
    repositories: byRepository.size,
    manifests: manifests.size,
    patchAvailable,
    severity,
    byRepository: [...byRepository.entries()]
      .map(([repo, value]) => ({
        repo,
        alerts: value.alerts,
        advisories: value.advisoryIds.size,
        dependencies: value.dependencies,
      }))
      .sort(
        (left, right) => right.advisories - left.advisories || left.repo.localeCompare(right.repo),
      ),
  };
}
