import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, disableFileLogging, enableFileLogging } from "../../src/util/logger.js";

/**
 * Several sessions watch the live daemon log with `tail -n 0 -F`, looking for
 * server-restart notices. Rotation must not break them, so this runs the real
 * command against a real rotation rather than reasoning about tail's semantics.
 */

const log = createLogger("watcher-test");
let dir: string | undefined;
let tail: ReturnType<typeof Bun.spawn> | undefined;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
	tail?.kill();
	tail = undefined;
	disableFileLogging();
	if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

describe("a tail -F watcher survives rotation", () => {
	test("keeps receiving lines written after the log rotates", async () => {
		dir = mkdtempSync(join(tmpdir(), "setpoint-watch-"));
		const path = join(dir, "daemon.log");
		writeFileSync(path, "");

		// The exact invocation the live monitors use.
		tail = Bun.spawn(["tail", "-n", "0", "-F", path], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const chunks: string[] = [];
		const reader = (tail.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		void (async () => {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(decoder.decode(value));
				}
			} catch {
				// Stream closed when the process was killed.
			}
		})();

		await wait(1200); // let tail attach

		enableFileLogging(path, { maxSizeBytes: 2_000, maxFiles: 3 });
		log.info("BEFORE-ROTATION marker");
		await wait(1200);

		// Push the active file over the threshold, then log to trigger rotation.
		writeFileSync(path, "x".repeat(3_000));
		log.info("TRIGGERS-ROTATION marker");
		await wait(1500);

		log.info("AFTER-ROTATION marker");
		await wait(1500);

		const seen = chunks.join("");
		expect(seen).toContain("BEFORE-ROTATION marker");
		// The one that matters: the watcher followed the file through rotation.
		expect(seen).toContain("AFTER-ROTATION marker");
	}, 15_000);
});
