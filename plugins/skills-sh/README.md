# Skills.sh

Install and update agent skills from [skills.sh](https://skills.sh) inside
[bb](https://github.com/get-bb/bb), 1:1 with the
[`npx skills`](https://github.com/vercel-labs/skills) CLI.

Skills are installed into bb's user skills directory (`<data-dir>/skills`,
usually `~/.bb/skills`), where bb picks them up for every agent thread. The
plugin tracks each install with the same folder-hash mechanism as the skills
CLI — the git tree SHA of the skill folder — so `update` only rewrites a skill
when its source actually differs.

## Panel

The plugin adds a **Skills.sh** panel to bb's sidebar: search the skills.sh
registry (or paste `owner/repo` / a skills.sh URL to install straight from a
source), see installed skills with their tracked version, check for upstream
drift, and update or remove skills — all backed by the same operations as the
CLI below.

## Usage

```sh
# Install every skill a repo publishes (same discovery as `npx skills add`)
bb skills add anthropics/skills

# Install one skill — all of these are equivalent
bb skills add anthropics/skills --skill pdf
bb skills add anthropics/skills@pdf
bb skills add https://skills.sh/anthropics/skills/pdf

# Pin a branch or tag, preview without installing
bb skills add owner/repo#v2
bb skills add owner/repo --list

# See what is installed, and what drifted upstream
bb skills list
bb skills check

# Re-install only the skills whose source differs
bb skills update

# Search the skills.sh registry (trending when no query is given)
bb skills find react

bb skills remove pdf
```

## Supported sources

Same shapes as the skills CLI: GitHub shorthand (`owner/repo`,
`owner/repo/sub/path`, `owner/repo@skill`, `#ref` fragments), GitHub and
GitLab URLs (including `/tree/<branch>/<path>`), skills.sh detail URLs,
generic git URLs (`git@…`, `ssh://…`, `https://….git`), and absolute local
paths on the bb server host.

Skill discovery is the CLI's algorithm: a root `SKILL.md`, `skills/` and
agent-skill containers walked three levels deep, then a full recursive
fallback. Skills marked `metadata.internal: true` are skipped unless
requested by name.

## How updates work

Each install records the skill's source, the repo-relative `SKILL.md` path,
and the git tree SHA of the skill folder (a SHA-256 content hash for local
sources). `bb skills check`/`update` compare that hash against the source —
via the GitHub Trees API when possible, falling back to a shallow clone — and
re-install only the skills that differ. Skills deleted upstream are reported
but never removed automatically.

## Settings

- **Skills directory override** — install somewhere other than
  `<data-dir>/skills`.

## Prototype limitations

- Symlink install mode, per-agent targeting, `use`, and `init` from the
  skills CLI don't apply to bb and are not implemented.
- Private repos rely on the bb server's ambient git credentials
  (`GITHUB_TOKEN`/`GH_TOKEN` are honored for the GitHub API fast path).
- Local sources must be absolute paths on the machine running the bb server.
