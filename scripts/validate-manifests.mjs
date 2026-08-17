// Validates .bb/plugins.json and marketplace.json against the vendored BB
// schemas, then cross-checks both manifests against the plugin directories.
// The marketplace schema is strict on BB's side — one unknown field rejects
// the whole catalog for users — so CI must catch violations before merge.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

const errors = [];
const fail = (message) => errors.push(message);

const ajv = new Ajv2020.default({ allErrors: true, strict: false });
const validateWith = (schemaPath, documentPath, document) => {
  const validate = ajv.compile(readJson(schemaPath));
  if (!validate(document)) {
    for (const issue of validate.errors ?? []) {
      fail(`${documentPath}: ${issue.instancePath || "/"} ${issue.message}`);
    }
    return false;
  }
  return true;
};

const collection = readJson(".bb/plugins.json");
const marketplace = readJson("marketplace.json");
validateWith("schema/plugins.schema.json", ".bb/plugins.json", collection);
validateWith("schema/marketplace.schema.json", "marketplace.json", marketplace);

// The schemas request unique names/ids in $comment only; enforce them here.
const collectionNames = collection.plugins.map((entry) => entry.name);
if (new Set(collectionNames).size !== collectionNames.length) {
  fail(".bb/plugins.json: duplicate plugin names");
}
const marketplaceIds = marketplace.plugins.map((entry) => entry.id);
if (new Set(marketplaceIds).size !== marketplaceIds.length) {
  fail("marketplace.json: duplicate entry ids");
}
if (marketplace.name === "bb-community") {
  fail("marketplace.json: the name bb-community is reserved");
}

// Collection entries must point at real plugin directories whose package name
// derives the same plugin id (final name component minus the bb-plugin- prefix).
const pluginIdFromPackageName = (name) => {
  const finalComponent = name.split("/").pop() ?? name;
  return finalComponent.replace(/^bb-plugin-/, "");
};
const idsBySource = new Map();
for (const entry of collection.plugins) {
  const manifestPath = join(entry.source, "package.json");
  if (!existsSync(join(root, manifestPath))) {
    fail(`.bb/plugins.json: ${entry.source} has no package.json`);
    continue;
  }
  const manifest = readJson(manifestPath);
  const id = pluginIdFromPackageName(manifest.name);
  idsBySource.set(entry.source.replace(/^\.\//, ""), id);
  if (id !== entry.name) {
    fail(
      `.bb/plugins.json: entry "${entry.name}" points at ${entry.source}, whose package name derives id "${id}"`,
    );
  }
  for (const [dependency, range] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })) {
    if (range.startsWith("workspace:") || range.startsWith("catalog:")) {
      // bb installs git plugins with plain `npm install --omit=dev`, which
      // rejects both protocols — even in devDependencies.
      fail(
        `${manifestPath}: "${dependency}": "${range}" breaks git installs (npm cannot resolve it)`,
      );
    }
  }
}

// Marketplace entries must match this repository's layout and tag scheme.
for (const entry of marketplace.plugins) {
  const git = entry.source?.git;
  if (!git) continue;
  if (git.subdir) {
    const id = idsBySource.get(git.subdir);
    if (id === undefined) {
      fail(
        `marketplace.json: entry "${entry.id}" subdir ${git.subdir} is not in .bb/plugins.json`,
      );
    } else if (id !== entry.id) {
      fail(
        `marketplace.json: entry "${entry.id}" installs ${git.subdir}, which is plugin "${id}" — BB refuses mismatched ids`,
      );
    }
  }
  if (git.range && git.tagPrefix !== `${entry.id}/`) {
    fail(
      `marketplace.json: entry "${entry.id}" tagPrefix "${git.tagPrefix ?? ""}" does not follow this repo's <id>/vX.Y.Z tag scheme`,
    );
  }
  if (typeof entry.icon === "object" && !/^https:/i.test(entry.icon.url)) {
    const iconPath = entry.icon.url.replace(/^\.\//, "");
    if (!existsSync(join(root, iconPath))) {
      fail(`marketplace.json: entry "${entry.id}" icon ${entry.icon.url} does not exist`);
    }
  }
}

if (errors.length > 0) {
  for (const message of errors) console.error(`✗ ${message}`);
  process.exit(1);
}
console.log(
  `✓ manifests valid (${collection.plugins.length} plugin(s), ${marketplace.plugins.length} marketplace entrie(s))`,
);
