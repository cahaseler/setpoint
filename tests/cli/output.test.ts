import { describe, expect, test } from "bun:test";
import {
	EXIT_CLIENT_ERROR,
	EXIT_CONNECTION_ERROR,
	EXIT_OK,
	EXIT_SERVER_ERROR,
	EXIT_TIMEOUT_ERROR,
	EXIT_USAGE_ERROR,
	type OutputStreams,
	createOutput,
} from "../../src/cli/output.js";

function createMockStreams(): OutputStreams & {
	stdoutLines: string[];
	stderrLines: string[];
	exitCode: number | undefined;
} {
	const mock = {
		stdoutLines: [] as string[],
		stderrLines: [] as string[],
		exitCode: undefined as number | undefined,
		stdout(text: string) {
			mock.stdoutLines.push(text);
		},
		stderr(text: string) {
			mock.stderrLines.push(text);
		},
		exit(code: number) {
			mock.exitCode = code;
		},
	};
	return mock;
}

describe("CliOutput", () => {
	test("ok writes JSON to stdout and exits 0", () => {
		const streams = createMockStreams();
		const out = createOutput(streams);

		// The `never` return type means it calls exit; our mock doesn't throw,
		// so we suppress the unreachable error by catching
		try {
			out.ok({ hello: "world" });
		} catch {
			// writeAndExit throws "unreachable" after mock exit
		}

		expect(streams.stdoutLines).toHaveLength(1);
		expect(JSON.parse(streams.stdoutLines[0] as string)).toEqual({ hello: "world" });
		expect(streams.exitCode).toBe(EXIT_OK);
		expect(streams.stderrLines).toHaveLength(0);
	});

	test("clientError writes JSON to stdout and exits 1", () => {
		const streams = createMockStreams();
		const out = createOutput(streams);

		try {
			out.clientError({ error: "not found" });
		} catch {
			// unreachable
		}

		expect(streams.exitCode).toBe(EXIT_CLIENT_ERROR);
		expect(JSON.parse(streams.stdoutLines[0] as string)).toEqual({ error: "not found" });
	});

	test("serverError writes JSON to stdout and exits 2", () => {
		const streams = createMockStreams();
		const out = createOutput(streams);

		try {
			out.serverError({ error: "internal" });
		} catch {
			// unreachable
		}

		expect(streams.exitCode).toBe(EXIT_SERVER_ERROR);
		expect(streams.stdoutLines).toHaveLength(1);
	});

	test("connectionError writes to stderr and exits 3", () => {
		const streams = createMockStreams();
		const out = createOutput(streams);

		try {
			out.connectionError("Cannot connect");
		} catch {
			// unreachable
		}

		expect(streams.exitCode).toBe(EXIT_CONNECTION_ERROR);
		expect(streams.stderrLines).toHaveLength(1);
		const parsed = JSON.parse(streams.stderrLines[0] as string) as Record<string, unknown>;
		expect(parsed["error"]).toBe("connection_failed");
		expect(parsed["message"]).toBe("Cannot connect");
		expect(streams.stdoutLines).toHaveLength(0);
	});

	test("timeoutError writes to stderr and exits 5", () => {
		const streams = createMockStreams();
		const out = createOutput(streams);

		try {
			out.timeoutError("Daemon did not respond within 30s for /accounts");
		} catch {
			// unreachable
		}

		expect(streams.exitCode).toBe(EXIT_TIMEOUT_ERROR);
		expect(streams.stderrLines).toHaveLength(1);
		const parsed = JSON.parse(streams.stderrLines[0] as string) as Record<string, unknown>;
		expect(parsed["error"]).toBe("timeout");
		expect(parsed["message"]).toBe("Daemon did not respond within 30s for /accounts");
		expect(streams.stdoutLines).toHaveLength(0);
	});

	test("usageError writes to stderr and exits 4", () => {
		const streams = createMockStreams();
		const out = createOutput(streams);

		try {
			out.usageError("Missing argument");
		} catch {
			// unreachable
		}

		expect(streams.exitCode).toBe(EXIT_USAGE_ERROR);
		expect(streams.stderrLines).toHaveLength(1);
		const parsed = JSON.parse(streams.stderrLines[0] as string) as Record<string, unknown>;
		expect(parsed["error"]).toBe("usage_error");
	});

	test("fromStatus routes 2xx to ok", () => {
		const streams = createMockStreams();
		const out = createOutput(streams);

		try {
			out.fromStatus(200, { status: "ok" });
		} catch {
			// unreachable
		}

		expect(streams.exitCode).toBe(EXIT_OK);
	});

	test("fromStatus routes 4xx to clientError", () => {
		const streams = createMockStreams();
		const out = createOutput(streams);

		try {
			out.fromStatus(404, { error: "not found" });
		} catch {
			// unreachable
		}

		expect(streams.exitCode).toBe(EXIT_CLIENT_ERROR);
	});

	test("fromStatus routes 5xx to serverError", () => {
		const streams = createMockStreams();
		const out = createOutput(streams);

		try {
			out.fromStatus(500, { error: "internal" });
		} catch {
			// unreachable
		}

		expect(streams.exitCode).toBe(EXIT_SERVER_ERROR);
	});
});
