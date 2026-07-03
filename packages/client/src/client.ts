/** Transport core for `@setpoint/client` — fetch-based HTTP with retry/timeout. */

import type { JobRecord, LoopStatus, V2GameState } from "@setpoint/protocol";
import { AccountApi, AccountsApi } from "./account.js";
import { ConnectionError, DeprecatedGoalError, SetpointHttpError, TimeoutError } from "./errors.js";
import { JobApi } from "./jobs.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:7580";
const DEFAULT_RETRY_DELAY_MS = 1000;
const RETRY_ATTEMPTS = 3;

export interface SetpointClientOptions {
	baseUrl?: string;
	timeoutMs?: number;
	retryDelayMs?: number;
}

export interface RequestOptions {
	body?: unknown;
	timeoutMs?: number;
}

/** Daemon health, as returned by `GET /health` (`handleHealth`). */
export interface HealthStatus {
	status: "ok";
	uptime: number;
	startedAt: string;
	accounts: number;
}

/** A single account's dashboard entry, as returned by `GET /dashboard/data` (`handleDashboardData`). */
export interface DashboardAccountEntry {
	player_id: string;
	username: string;
	state: V2GameState | null;
	loop: LoopStatus | null;
	hasRunningJob: boolean;
	runningJob: unknown;
	hasExecutingGoal: boolean;
	executingGoal: unknown;
	recentJobs: JobRecord[];
}

/** Dashboard data, as returned by `GET /dashboard/data` (`handleDashboardData`). */
export interface DashboardData {
	startedAt: string;
	uptimeMs: number;
	accounts: DashboardAccountEntry[];
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Response shape shared by `GET /log-level` and `POST /log-level` (`handleGetLogLevel`/`handleSetLogLevel`). */
export interface LogLevelResult {
	level: LogLevel;
	previous?: LogLevel;
}

export class SetpointClient {
	readonly baseUrl: string;
	private readonly timeoutMs: number | undefined;
	private readonly retryDelayMs: number;

	/** Top-level accounts collection API (`sp.accounts`). */
	readonly accounts: AccountsApi;

	constructor(options: SetpointClientOptions = {}) {
		this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		this.timeoutMs = options.timeoutMs;
		this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
		this.accounts = new AccountsApi(this);
	}

	/**
	 * Issues an HTTP request and returns the parsed JSON body.
	 *
	 * Retries connection failures (server unreachable) up to `RETRY_ATTEMPTS` times.
	 * Does NOT retry timeouts — the server is running but slow/busy, and retrying
	 * just adds load and produces misleading "connection failed" errors.
	 *
	 * A `timeoutMs` of 0 (or leaving both this and the constructor default unset)
	 * disables the per-request abort timeout entirely — used for long-running sync
	 * goals that can legitimately take minutes.
	 */
	async request(method: string, path: string, opts?: RequestOptions): Promise<unknown> {
		const url = `${this.baseUrl}${path}`;
		const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;

		const init: RequestInit = { method };
		if (opts?.body !== undefined) {
			init.headers = { "Content-Type": "application/json" };
			init.body = JSON.stringify(opts.body);
		}

		let lastErr: unknown;
		for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
			if (attempt > 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
			}

			const controller = timeoutMs ? new AbortController() : undefined;
			const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
			try {
				const fetchInit = controller ? { ...init, signal: controller.signal } : init;
				const response = await fetch(url, fetchInit);

				let data: unknown;
				try {
					data = await response.json();
				} catch {
					data = {};
				}

				if (response.status === 410) {
					throw new DeprecatedGoalError(data as { error?: string });
				}
				if (!response.ok) {
					throw new SetpointHttpError(response.status, data as { error?: string });
				}
				return data;
			} catch (err) {
				// Non-2xx responses throw from inside this try (above) — let them escape
				// rather than being swallowed as a retryable connection failure.
				if (err instanceof SetpointHttpError) {
					throw err;
				}
				// Timeout: the server IS running but didn't respond in time.
				// Report this accurately and do not retry.
				if (err instanceof Error && err.name === "AbortError") {
					throw new TimeoutError(this.baseUrl, timeoutMs ?? 0, path);
				}
				// Connection error: server may not be running. Retry.
				lastErr = err;
			} finally {
				if (timeoutId !== undefined) clearTimeout(timeoutId);
			}
		}

		throw new ConnectionError(this.baseUrl, lastErr);
	}

	/** Returns the account-scoped goal API for the given account id (player_id or username). */
	account(id: string): AccountApi {
		return new AccountApi(this, id);
	}

	/** Returns the direct job lookup/wait API for the given async job id. */
	job(jobId: string): JobApi {
		return new JobApi(this, jobId);
	}

	/** Daemon health and uptime. */
	async health(): Promise<HealthStatus> {
		const result = await this.request("GET", "/health");
		return result as HealthStatus;
	}

	/** Full dashboard data for all accounts. */
	async dashboard(): Promise<DashboardData> {
		const result = await this.request("GET", "/dashboard/data");
		return result as DashboardData;
	}

	/** Gets the daemon's current log level. */
	async logLevel(): Promise<LogLevelResult>;
	/** Sets the daemon's log level. */
	async logLevel(level: LogLevel): Promise<LogLevelResult>;
	async logLevel(level?: LogLevel): Promise<LogLevelResult> {
		const result =
			level === undefined
				? await this.request("GET", "/log-level")
				: await this.request("POST", "/log-level", { body: { level } });
		return result as LogLevelResult;
	}
}
