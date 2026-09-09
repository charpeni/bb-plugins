# Dependabot plugin

An independent BB plugin for GitHub Dependabot alerts. It lists open alerts,
groups them by repository, package ecosystem, and dependency name, and starts
one BB agent thread to fix every CVE in a dependency group.

It does not require or communicate with BB's official GitHub plugin.

<img width="2806" height="1916" alt="bettershot_1787000567680" src="https://github.com/user-attachments/assets/bda5043e-a05f-45e3-9a67-60b8f2860061" />

## Install

Requires a BB version with Plugin SDK 0.4.47 or newer for the custom prompt textarea.

From the marketplace:

```sh
bb marketplace add git:github.com/charpeni/bb-plugins@main
bb plugin install dependabot@charpeni
```

Or directly from this repository:

```sh
bb plugin install git:https://github.com/charpeni/bb-plugins.git@^0.1.0 --tag-prefix dependabot/ --plugin dependabot
```

## Authentication

The plugin uses the GitHub CLI and stores no GitHub token itself:

```sh
gh auth login
gh auth status
bb plugin reload dependabot
```

Reading private-repository alerts requires access to the repository's security
alerts. OAuth and classic personal access tokens need the `security_events`
scope. A fine-grained personal access token needs repository read permission
for **Dependabot alerts**. For a GitHub CLI OAuth token, add the classic scope
with:

```sh
gh auth refresh -s security_events
bb plugin reload dependabot
```

Organization policy can still restrict alerts to repository administrators,
security managers, or explicitly authorized teams.

## Repositories and projects

The plugin reads each BB project's inspected GitHub remote, including projects
whose checkout lives on a remote BB host.
Configure `extraRepos` for additional comma-separated `owner/repo` values:

```sh
bb plugin config dependabot set extraRepos "owner/repo, owner/other"
bb plugin reload dependabot
```

Set `defaultProject` in the plugin settings when an extra repository should
spawn fix threads in a project that was not discovered automatically.

## Agent and CLI surfaces

The sidebar panel groups alerts by dependency, even when the dependency appears
in multiple manifests. Its exposure overview reports open alerts, deduplicated
CVEs and GHSA-only advisories, affected dependencies and manifests, patch
availability, severity distribution, and per-repository exposure. **Fix with
agent** re-fetches the group, then starts one project-scoped thread with every
CVE, vulnerable range, and first patched version in its prompt. The prompt asks
the agent to update manifests and lockfiles, run repository checks, and never
dismiss an alert instead of fixing the code.

Use the **Custom prompt** textarea (`customPrompt`) in the Dependabot plugin settings to
append your own instructions to the standard remediation prompt and alert
details. For example:

```sh
bb plugin config dependabot set customPrompt "Open a draft PR and include the test results in its description."
```

The setting applies to both **Fix with agent** and `bb dependabot fix`. Changes
take effect on the next fix without reloading the plugin. Leave it blank to use
only the standard prompt.

Alert groups are cached per repository in the plugin's SQLite database for five
minutes. Concurrent requests share one GitHub fetch, a background service
refreshes the cache every five minutes, and failed refreshes retain stale data
with a warning. The panel's Refresh button bypasses the freshness window.
Repository and search filters persist in browser local storage so reloading or
reopening BB restores the previous view. A repository that is no longer tracked
is cleared automatically.

Agents and terminals can use the same feature through the CLI:

```sh
bb dependabot repos
bb dependabot alerts [owner/repo]
bb dependabot refresh [owner/repo]
bb dependabot fix <owner/repo> <ecosystem> <package>
```

The RPC methods `status`, `listAlerts`, `refreshAlerts`, and `startFix` provide
the SDK surface.

## Develop

From the repository root:

```sh
bb plugin install ./plugins/dependabot
bb plugin dev plugins/dependabot
```
