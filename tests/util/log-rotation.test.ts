import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createLogger, disableFileLogging, enableFileLogging } from "../../src/util/logger.js";

const log = createLogger("rotation-test");
let dir: string | undefined;

function newLogPath(): string {
	dir = mkdtempSync(join(tmpdir(), "setpoint-logs-"));
	return join(dir, "daemon.log");
}

/**
 * Seed an active log already over the threshold, so the next line triggers
 * exactly one rotation. Filling by logging would rotate an unpredictable number
 * of times and make the assertions meaningless.
 */
function seedOversizedLog(path: string, content: string, maxSizeBytes: number): void {
	writeFileSync(path, content.padEnd(maxSizeBytes + 1, "."));
}

afterEach(() => {
	disableFileLogging();
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

describe("log rotation", () => {
	test("rotated history is compressed, and the content survives", () => {
		const path = newLogPath();
		seedOversizedLog(path, "first-generation marker\n", 1_000);
		enableFileLogging(path, { maxSizeBytes: 1_000, maxFiles: 5 });

		log.info("triggers rotation");

		expect(existsSync(`${path}.1.gz`)).toBe(true);
		expect(gunzipSync(readFileSync(`${path}.1.gz`)).toString()).toContain(
			"first-generation marker",
		);
	});

	test("compression is a real saving, not a rename", () => {
		const path = newLogPath();
		// Log lines are highly repetitive; measured ~8:1 on real daemon output.
		seedOversizedLog(path, "repeated line\n".repeat(500), 5_000);
		enableFileLogging(path, { maxSizeBytes: 5_000, maxFiles: 5 });

		log.info("triggers rotation");

		const compressed = readFileSync(`${path}.1.gz`).length;
		expect(compressed).toBeLessThan(1_000);
	});

	test("retention is hard-bounded — the oldest generation is dropped", () => {
		// The property that matters: an unrotated log here once reached 7 GB.
		const path = newLogPath();
		enableFileLogging(path, { maxSizeBytes: 500, maxFiles: 3 });

		for (let i = 0; i < 10; i++) {
			seedOversizedLog(path, `generation ${i}\n`, 500);
			log.info("triggers rotation");
		}

		expect(existsSync(`${path}.3.gz`)).toBe(true);
		expect(existsSync(`${path}.4.gz`)).toBe(false);
		expect(existsSync(`${path}.4`)).toBe(false);
	});

	test("history written before compression existed is shifted, not stranded", () => {
		const path = newLogPath();
		seedOversizedLog(path, "active\n", 500);
		// A plain generation left behind by the previous rotation scheme.
		writeFileSync(`${path}.1`, "legacy generation content");
		enableFileLogging(path, { maxSizeBytes: 500, maxFiles: 5 });

		log.info("triggers rotation");

		expect(readFileSync(`${path}.2`).toString()).toBe("legacy generation content");
	});

	test("logging continues into a fresh file after rotation", () => {
		const path = newLogPath();
		seedOversizedLog(path, "old\n", 500);
		enableFileLogging(path, { maxSizeBytes: 500, maxFiles: 3 });

		log.info("post-rotation marker");

		const active = readFileSync(path).toString();
		expect(active).toContain("post-rotation marker");
		expect(active).not.toContain("old");
	});
});
