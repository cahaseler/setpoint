import { describe, expect, test } from "bun:test";
import { isFileLoggingEnabled } from "../../src/util/logger.js";

describe("daemon entry module side effects", () => {
	test("importing src/index.ts does not turn on file logging", async () => {
		// tests/server/loop-persistence.test.ts imports connectAccounts and
		// resumeLoopConfig from the daemon entry module. Those calls used to sit
		// at the top level, so that import enabled file logging for the whole
		// test process and every subsequent test log line was appended to the
		// live logs/daemon.log — fabricated goal activity, with synthetic account
		// and module ids, in the operational log other tooling greps. Anything
		// that only RUNS the daemon belongs behind the import.meta.main guard.
		await import("../../src/index.js");
		expect(isFileLoggingEnabled()).toBe(false);
	});
});
