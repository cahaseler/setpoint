import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
	currentLevel = level;
}

export function getLogLevel(): LogLevel {
	return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
	return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

/**
 * Redact a bearer token (session id, etc.) for logging — keeps only a short
 * prefix so logs stay diagnosable without exposing a usable credential.
 */
export function redactToken(token: string): string {
	return token.length <= 8 ? "…" : `${token.slice(0, 8)}…`;
}

function formatMessage(level: LogLevel, context: string, message: string): string {
	const timestamp = new Date().toISOString();
	return `${timestamp} [${level.toUpperCase()}] [${context}] ${message}`;
}

// --- File logging ---

/**
 * Retention is sized so an incident reported hours later can still be
 * investigated, while staying hard-bounded.
 *
 * Rotated files are gzipped, which measures ~8:1 on this log, so the 40 kept
 * generations hold ~800 MB of history in ~100 MB on disk. At the observed write
 * rate that is well over a day. Worst-case footprint is the active file plus 40
 * compressed generations — it cannot grow past that, which is the property that
 * matters: an unrotated log here once reached 7 GB in three days.
 *
 * Compressed generations are still greppable with `zgrep`.
 */
const MAX_LOG_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_ROTATED_FILES = 40;

let maxLogSize = MAX_LOG_SIZE;
let maxRotatedFiles = MAX_ROTATED_FILES;
let logFilePath: string | undefined;
let logFileEnabled = false;

/**
 * Enable file logging. Call once at startup.
 * Logs are written to the specified path (default: logs/daemon.log relative to cwd).
 */
export function enableFileLogging(
	path?: string,
	options: { maxSizeBytes?: number; maxFiles?: number } = {},
): void {
	logFilePath = path ?? join(process.cwd(), "logs", "daemon.log");
	maxLogSize = options.maxSizeBytes ?? MAX_LOG_SIZE;
	maxRotatedFiles = options.maxFiles ?? MAX_ROTATED_FILES;
	const dir = dirname(logFilePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	logFileEnabled = true;
}

/**
 * Whether log lines are being appended to a file. Importing a module must never
 * turn this on — only the daemon entry point, when actually run, should.
 */
export function isFileLoggingEnabled(): boolean {
	return logFileEnabled;
}

/** Stop writing to a file. Used by tests to avoid leaking state between cases. */
export function disableFileLogging(): void {
	logFileEnabled = false;
	logFilePath = undefined;
}

/**
 * Move generation `i` up to `i + 1`, whichever form it exists in.
 *
 * Generations written before compression was introduced are plain files; both
 * forms are shifted so an upgrade does not strand or delete existing history.
 */
function shiftGeneration(base: string, i: number): void {
	for (const suffix of [".gz", ""]) {
		const from = `${base}.${i}${suffix}`;
		if (existsSync(from)) {
			renameSync(from, `${base}.${i + 1}${suffix}`);
			return;
		}
	}
}

/** Drop generation `i` in whichever form it exists, so retention stays bounded. */
function dropGeneration(base: string, i: number): void {
	for (const suffix of [".gz", ""]) {
		const path = `${base}.${i}${suffix}`;
		if (existsSync(path)) unlinkSync(path);
	}
}

function rotateIfNeeded(): void {
	if (!logFilePath || !logFileEnabled) return;
	try {
		if (!existsSync(logFilePath)) return;
		const stats = statSync(logFilePath);
		if (stats.size < maxLogSize) return;

		// The oldest generation falls off the end first, so the shift below never
		// pushes a file past the retention limit.
		dropGeneration(logFilePath, maxRotatedFiles);
		for (let i = maxRotatedFiles - 1; i >= 1; i--) {
			shiftGeneration(logFilePath, i);
		}

		// Rename the active file out of the way FIRST, then compress it in place.
		//
		// Several sessions run `tail -n 0 -F` against the active log, watching for
		// server-restart notices. Rename-then-recreate is the exact filesystem
		// sequence they have always seen, and `tail -F` follows it. Compressing
		// the active file and unlinking it would work too, but it is a different
		// event sequence for nine long-running watchers to absorb for no gain.
		renameSync(logFilePath, `${logFilePath}.1`);

		// If compression fails for any reason, the plain generation is simply
		// left in place: keeping the history uncompressed beats losing it, and
		// shiftGeneration handles either form.
		try {
			writeFileSync(`${logFilePath}.1.gz`, gzipSync(readFileSync(`${logFilePath}.1`)));
			unlinkSync(`${logFilePath}.1`);
		} catch {
			// Left as a plain .1 generation.
		}
	} catch {
		// Rotation failed — not critical, keep logging to the current file.
	}
}

function writeToFile(formatted: string): void {
	if (!logFileEnabled || !logFilePath) return;
	try {
		rotateIfNeeded();
		appendFileSync(logFilePath, `${formatted}\n`);
	} catch {
		// File write failed — don't crash the daemon over logging
	}
}

// --- Logger interface ---

export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export function createLogger(context: string): Logger {
	return {
		debug(message: string): void {
			if (shouldLog("debug")) {
				const formatted = formatMessage("debug", context, message);
				console.debug(formatted);
				writeToFile(formatted);
			}
		},
		info(message: string): void {
			if (shouldLog("info")) {
				const formatted = formatMessage("info", context, message);
				console.info(formatted);
				writeToFile(formatted);
			}
		},
		warn(message: string): void {
			if (shouldLog("warn")) {
				const formatted = formatMessage("warn", context, message);
				console.warn(formatted);
				writeToFile(formatted);
			}
		},
		error(message: string): void {
			if (shouldLog("error")) {
				const formatted = formatMessage("error", context, message);
				console.error(formatted);
				writeToFile(formatted);
			}
		},
	};
}
