# bb-plugins

My personal [bb](https://github.com/get-bb/bb) plugins, distributed as a
custom marketplace.

## Use the marketplace

```sh
bb marketplace add git:github.com/charpeni/bb-plugins@main
```

Then install plugins from it:

```sh
bb plugin install system-monitor@charpeni
```

## Plugins

| Plugin | Description |
| --- | --- |
| [System Monitor](plugins/system-monitor) | Live CPU, memory, disk, load, and uptime statistics for the bb server host. |

Each plugin can also be installed directly, without the marketplace:

```sh
bb plugin install git:https://github.com/charpeni/bb-plugins.git@^0.1.0 --tag-prefix system-monitor/ --plugin system-monitor
```

## Repository layout

- `plugins/<id>/` — one self-contained plugin per directory. No
  `workspace:`/`catalog:` dependencies: bb installs git plugins with plain
  `npm install --omit=dev`, so every manifest must resolve standalone.
- `.bb/plugins.json` — the collection index that makes
  `bb plugin install git:… --plugin <name>` work.
- `marketplace.json` — the marketplace catalog bb reads (with `icons/` for any
  file-based entry icons). Entries use git tag ranges, so releases reach users
  without catalog changes.
- `schema/` + `scripts/validate-manifests.mjs` — vendored BB schemas and the
  validation CI runs on every push.

## Develop

```sh
pnpm install
pnpm run validate   # manifests against BB's schemas + cross-checks
pnpm run typecheck
pnpm run test
pnpm run build      # bb plugin build, via the bb-app devDependency
```

For a live loop against a running bb, register a plugin directory as a path
install once, then let `bb plugin dev` rebuild and reload on save:

```sh
bb plugin install ./plugins/system-monitor
bb plugin dev plugins/system-monitor
```

## Release a plugin

Bump the plugin's `package.json` version, then tag `<id>/v<version>`:

```sh
git tag system-monitor/v0.1.1
git push origin system-monitor/v0.1.1
```

bb resolves each marketplace entry's semver range over its `tagPrefix` tags
(`system-monitor/vX.Y.Z`), records the tag and commit it installed, and
refuses a tag that later moves — publish a fix as a new version, never retag.
