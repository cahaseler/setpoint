#!/usr/bin/env bun

/**
 * Bumps the patch version in package.json and src/cli/index.ts.
 * Only bumps if there are uncommitted changes or untracked files.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");
const CLI_PATH = join(ROOT, "src/cli/index.ts");

// Check if there are changes to deploy
const status = execSync("git status --porcelain", { cwd: ROOT, encoding: "utf-8" }).trim();
if (!status) {
	console.log("No changes to deploy, skipping version bump.");
	process.exit(0);
}

// Read and bump package.json
const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
const [major, minor, patch] = (pkg.version as string).split(".").map(Number);
const newVersion = `${major}.${minor}.${patch + 1}`;
pkg.version = newVersion;
writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, "\t")}\n`, "utf-8");

// Update CLI constant
const cliSource = readFileSync(CLI_PATH, "utf-8");
const updated = cliSource.replace(/const VERSION = ".*?"/, `const VERSION = "${newVersion}"`);
writeFileSync(CLI_PATH, updated, "utf-8");

console.log(`Bumped version to ${newVersion}`);
