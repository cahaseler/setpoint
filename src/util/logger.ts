import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

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

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATED_FILES = 3;
let logFilePath: string | undefined;
let logFileEnabled = false;

/**
 * Enable file logging. Call once at startup.
 * Logs are written to the specified path (default: logs/daemon.log relative to cwd).
 */
export function enableFileLogging(path?: string): void {
	logFilePath = path ?? join(process.cwd(), "logs", "daemon.log");
	const dir = dirname(logFilePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	logFileEnabled = true;
}

function rotateIfNeeded(): void {
	if (!logFilePath || !logFileEnabled) return;
	try {
		if (!existsSync(logFilePath)) return;
		const stats = statSync(logFilePath);
		if (stats.size < MAX_LOG_SIZE) return;

		// Rotate: daemon.log.2 → daemon.log.3, daemon.log.1 → daemon.log.2, daemon.log → daemon.log.1
		for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
			const from = `${logFilePath}.${i}`;
			const to = `${logFilePath}.${i + 1}`;
			if (existsSync(from)) {
				renameSync(from, to);
			}
		}
		renameSync(logFilePath, `${logFilePath}.1`);
	} catch {
		// Rotation failed — not critical, keep logging to current file
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
