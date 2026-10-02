// Composes the handoff API contract (contracts/openapi.json, kept unchanged) with the
// reviewed extensions in contracts/extensions/*.json into packages/contracts/openapi.json.
// Extension semantics: an operation (path + method) or schema declared in an extension
// replaces/adds the base definition. Every change must be listed in contracts/CHANGELOG_JA.md.
import { readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const base = JSON.parse(readFileSync(join(root, "contracts/openapi.json"), "utf8"));
const extDir = join(root, "contracts/extensions");
const files = readdirSync(extDir).filter((f) => f.endsWith(".json")).sort();

const seenOps = new Map();
const seenSchemas = new Map();
for (const file of files) {
  const ext = JSON.parse(readFileSync(join(extDir, file), "utf8"));
  for (const [path, ops] of Object.entries(ext.paths ?? {})) {
    base.paths[path] ??= {};
    for (const [method, op] of Object.entries(ops)) {
      const key = `${method.toUpperCase()} ${path}`;
      if (seenOps.has(key)) throw new Error(`${key} is defined by both ${seenOps.get(key)} and ${file}`);
      seenOps.set(key, file);
      base.paths[path][method] = op;
    }
  }
  for (const [name, schema] of Object.entries(ext.components?.schemas ?? {})) {
    if (seenSchemas.has(name)) throw new Error(`schema ${name} is defined by both ${seenSchemas.get(name)} and ${file}`);
    seenSchemas.set(name, file);
    base.components.schemas[name] = schema;
  }
  for (const [name, param] of Object.entries(ext.components?.parameters ?? {})) {
    base.components.parameters ??= {};
    base.components.parameters[name] = param;
  }
}
base.info.version = `${base.info.version}+arms.${files.length}`;
writeFileSync(join(root, "packages/contracts/openapi.json"), JSON.stringify(base, null, 2) + "\n");
copyFileSync(join(root, "contracts/voice-tools.json"), join(root, "packages/contracts/voice-tools.json"));
console.info(`contracts merged: ${files.length} extension file(s), ${seenOps.size} operation(s), ${seenSchemas.size} schema(s)`);
