/** Transport core for `@setpoint/client` — fetch-based HTTP with retry/timeout. */

import { ConnectionError, DeprecatedGoalError, SetpointHttpError, TimeoutError } from "./errors.js";

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

export class SetpointClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number | undefined;
	private readonly retryDelayMs: number;

	constructor(options: SetpointClientOptions = {}) {
		this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
		this.timeoutMs = options.timeoutMs;
		this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
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
}
