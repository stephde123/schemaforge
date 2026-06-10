#!/usr/bin/env node
// Increments the patch segment of package.json version (x.y.z → x.y.z+1).
// Called by the pre-commit git hook.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const parts = pkg.version.split(".");
parts[2] = String(Number(parts[2]) + 1);
pkg.version = parts.join(".");

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
process.stdout.write(pkg.version + "\n");
