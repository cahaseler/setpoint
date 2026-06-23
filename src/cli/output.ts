/** Standardized CLI output and exit codes for agent consumption. */

export const EXIT_OK = 0;
export const EXIT_CLIENT_ERROR = 1;
export const EXIT_SERVER_ERROR = 2;
export const EXIT_CONNECTION_ERROR = 3;
export const EXIT_USAGE_ERROR = 4;
export const EXIT_TIMEOUT_ERROR = 5;

export interface OutputStreams {
	stdout(text: string): void;
	stderr(text: string): void;
	exit(code: number): void;
}

const defaultStreams: OutputStreams = {
	stdout: (text) => process.stdout.write(`${text}\n`),
	stderr: (text) => process.stderr.write(`${text}\n`),
	exit: (code) => {
		// When stdout is a pipe, process.stdout.write() may only flush up to the OS
		// pipe buffer (~64KB on Linux). Excess data is held in Bun's internal stream
		// buffer. Calling process.exit() immediately discards that buffer, causing
		// truncation. Wait for the drain event if the buffer hasn't fully flushed.
		if (process.stdout.writableNeedDrain) {
			process.stdout.once("drain", () => process.exit(code));
		} else {
			process.exit(code);
		}
	},
};

export interface CliOutput {
	/** Print JSON to stdout and exit 0. */
	ok(data: unknown): never;
	/** Print JSON to stdout and exit 1 (HTTP 4xx). */
	clientError(data: unknown): never;
	/** Print JSON to stdout and exit 2 (HTTP 5xx). */
	serverError(data: unknown): never;
	/** Print JSON error to stderr and exit 3 (daemon unreachable). */
	connectionError(message: string): never;
	/** Print JSON error to stderr and exit 5 (daemon did not respond in time). */
	timeoutError(message: string): never;
	/** Print JSON error to stderr and exit 4 (bad CLI arguments). */
	usageError(message: string): never;
	/** Route an HTTP response status to the appropriate exit handler. */
	fromStatus(status: number, data: unknown): never;
	/** Print raw text to stdout and exit 0 (for help output). */
	raw(text: string): never;
}

export function createOutput(streams: OutputStreams = defaultStreams): CliOutput {
	function writeAndExit(stream: "stdout" | "stderr", data: unknown, code: number): never {
		streams[stream](JSON.stringify(data));
		streams.exit(code);
		// TypeScript needs this for the `never` return type
		throw new Error("unreachable");
	}

	return {
		ok(data) {
			return writeAndExit("stdout", data, EXIT_OK);
		},
		clientError(data) {
			return writeAndExit("stdout", data, EXIT_CLIENT_ERROR);
		},
		serverError(data) {
			return writeAndExit("stdout", data, EXIT_SERVER_ERROR);
		},
		connectionError(message) {
			return writeAndExit("stderr", { error: "connection_failed", message }, EXIT_CONNECTION_ERROR);
		},
		timeoutError(message) {
			return writeAndExit("stderr", { error: "timeout", message }, EXIT_TIMEOUT_ERROR);
		},
		usageError(message) {
			return writeAndExit("stderr", { error: "usage_error", message }, EXIT_USAGE_ERROR);
		},
		fromStatus(status, data) {
			if (status >= 200 && status < 300) {
				return writeAndExit("stdout", data, EXIT_OK);
			}
			if (status >= 400 && status < 500) {
				return writeAndExit("stdout", data, EXIT_CLIENT_ERROR);
			}
			return writeAndExit("stdout", data, EXIT_SERVER_ERROR);
		},
		raw(text) {
			streams.stdout(text);
			streams.exit(EXIT_OK);
			throw new Error("unreachable");
		},
	};
}

/** Default output instance using process streams. */
export const output = createOutput();
