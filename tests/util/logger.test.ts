import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createLogger, getLogLevel, redactToken, setLogLevel } from "../../src/util/logger.js";

describe("logger", () => {
	const originalConsole = {
		debug: console.debug,
		info: console.info,
		warn: console.warn,
		error: console.error,
	};

	let captured: Array<{ level: string; message: string }>;

	beforeEach(() => {
		captured = [];
		console.debug = mock((...args: unknown[]) => {
			captured.push({ level: "debug", message: String(args[0]) });
		});
		console.info = mock((...args: unknown[]) => {
			captured.push({ level: "info", message: String(args[0]) });
		});
		console.warn = mock((...args: unknown[]) => {
			captured.push({ level: "warn", message: String(args[0]) });
		});
		console.error = mock((...args: unknown[]) => {
			captured.push({ level: "error", message: String(args[0]) });
		});
		setLogLevel("debug");
	});

	afterEach(() => {
		console.debug = originalConsole.debug;
		console.info = originalConsole.info;
		console.warn = originalConsole.warn;
		console.error = originalConsole.error;
		setLogLevel("info");
	});

	test("logs messages with context and timestamp", () => {
		const log = createLogger("test-ctx");
		log.info("hello world");

		expect(captured).toHaveLength(1);
		expect(captured[0]?.message).toContain("[INFO]");
		expect(captured[0]?.message).toContain("[test-ctx]");
		expect(captured[0]?.message).toContain("hello world");
	});

	test("respects log level filtering", () => {
		setLogLevel("warn");
		const log = createLogger("test");

		log.debug("debug msg");
		log.info("info msg");
		log.warn("warn msg");
		log.error("error msg");

		expect(captured).toHaveLength(2);
		expect(captured[0]?.level).toBe("warn");
		expect(captured[1]?.level).toBe("error");
	});

	test("getLogLevel returns current level", () => {
		setLogLevel("error");
		expect(getLogLevel()).toBe("error");
	});

	test("all log methods output at debug level", () => {
		setLogLevel("debug");
		const log = createLogger("test");

		log.debug("d");
		log.info("i");
		log.warn("w");
		log.error("e");

		expect(captured).toHaveLength(4);
	});
});

describe("redactToken", () => {
	test("keeps only an 8-char prefix of a long token", () => {
		const token = "f86bc0a78386c7661c1a6fec27912767";
		const redacted = redactToken(token);
		expect(redacted).toBe("f86bc0a7…");
		expect(redacted).not.toContain(token);
	});

	test("fully masks short tokens", () => {
		expect(redactToken("12345678")).toBe("…");
		expect(redactToken("")).toBe("…");
	});
});
