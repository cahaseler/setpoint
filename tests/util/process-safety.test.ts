import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// These spawn real `bun run` subprocesses rather than exercising
// installCrashSafetyHandlers() in-process: `bun test` installs its own
// unhandledRejection handler, so an in-process "simulate a leaked rejection,
// assert no crash" test would pass regardless of whether the fix is present.
// Only a separate process reproduces Bun's real default behavior.
const FIXTURES_DIR = join(import.meta.dir, "fixtures");

async function runFixture(
	name: string,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
	const proc = Bun.spawn(["bun", "run", join(FIXTURES_DIR, name)], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stderr, stdout };
}

describe("installCrashSafetyHandlers", () => {
	test("baseline: a detached (unawaited, uncaught) rejection crashes a plain Bun process", async () => {
		const { exitCode, stdout } = await runFixture("without-crash-safety.ts");
		expect(exitCode).toBe(1);
		expect(stdout).not.toContain("SURVIVED");
	}, 10_000);

	test("with the handler installed, the same detached rejection is logged and the process survives", async () => {
		const { exitCode, stdout, stderr } = await runFixture("with-crash-safety.ts");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("SURVIVED");
		expect(stderr).toContain("Unhandled promise rejection (daemon continues running)");
		expect(stderr).toContain("simulated: connection closed mid-query");
	}, 10_000);
});
