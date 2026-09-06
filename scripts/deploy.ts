#!/usr/bin/env bun

/**
 * Deploy pipeline: bump version, lint/format, typecheck, test, build CLI.
 *
 * Runs each step sequentially, captures output, and prints a clean summary
 * at the end with the version number and pass/fail status for each step.
 * On failure, prints the relevant output for the failing step.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");

interface StepResult {
	name: string;
	success: boolean;
	output: string;
	durationMs: number;
}

function runStep(name: string, command: string): StepResult {
	const start = Date.now();
	try {
		// Merge stderr into stdout so we capture test runner output (bun test writes to stderr)
		const output = execSync(`${command} 2>&1`, {
			cwd: ROOT,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 300_000,
		});
		return { name, success: true, output, durationMs: Date.now() - start };
	} catch (err) {
		const output =
			err && typeof err === "object" && "stdout" in err
				? `${(err as { stdout: string }).stdout}\n${(err as { stderr: string }).stderr}`
				: String(err);
		return { name, success: false, output, durationMs: Date.now() - start };
	}
}

function getVersion(): string {
	const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
	return pkg.version as string;
}

// ── Run pipeline ─────────────────────────────────────────────────────

const results: StepResult[] = [];

// Step 1: Version bump
const bump = runStep("version-bump", "bun scripts/bump-version.ts");
results.push(bump);
if (!bump.success) {
	console.error("Version bump failed:");
	console.error(bump.output);
	process.exit(1);
}

const version = getVersion();

// Step 2: Lint + format (biome check --write && biome format --write)
const lint = runStep("lint+format", "bun run check");
results.push(lint);
if (!lint.success) {
	console.error("Lint/format failed:");
	console.error(lint.output);
	process.exit(1);
}

// Step 3: Typecheck
// Must match package.json's `typecheck` script: the root tsconfig does not
// include packages/, so a bare `tsc --noEmit` type-checks src/ only and lets a
// broken @setpoint/client or @setpoint/protocol through a green deploy.
const typecheck = runStep("typecheck", "bun run typecheck");
results.push(typecheck);
if (!typecheck.success) {
	console.error("Typecheck failed:");
	console.error(typecheck.output);
	process.exit(1);
}

// Step 4: Tests
const test = runStep("test", "bun test");
results.push(test);

// Extract test summary lines from bun test output (e.g., " 904 pass\n 0 fail")
// Anchored to start-of-line to avoid matching log messages like "(failure 1/10)"
const passMatch = test.output.match(/^\s*(\d+) pass$/m);
const failMatch = test.output.match(/^\s*(\d+) fail$/m);
const filesMatch = test.output.match(/Ran (\d+) tests across (\d+) files/);
const testSummary = passMatch
	? `${passMatch[1]} pass, ${failMatch?.[1] ?? "?"} fail${filesMatch ? ` (${filesMatch[1]} tests, ${filesMatch[2]} files)` : ""}`
	: "unknown";

if (!test.success) {
	console.error("Tests failed:");
	console.error(test.output);
	process.exit(1);
}

// Step 5: Build CLI
const build = runStep("build-cli", "bun build src/cli/index.ts --compile --outfile dist/smctl");
results.push(build);
if (!build.success) {
	console.error("CLI build failed:");
	console.error(build.output);
	process.exit(1);
}

// ── Summary ──────────────────────────────────────────────────────────

console.log("");
console.log("═══════════════════════════════════════");
console.log(`  Deploy v${version} — SUCCESS`);
console.log("═══════════════════════════════════════");
for (const r of results) {
	const status = r.success ? "OK" : "FAIL";
	const detail = r.name === "test" ? ` (${testSummary})` : "";
	console.log(`  ${status.padEnd(5)} ${r.name}${detail} [${(r.durationMs / 1000).toFixed(1)}s]`);
}
console.log("═══════════════════════════════════════");
console.log(`  dist/smctl compiled — v${version}`);
console.log("═══════════════════════════════════════");
