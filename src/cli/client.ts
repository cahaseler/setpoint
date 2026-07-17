/** Thin HTTP client for communicating with the setpoint daemon. */

/** Thrown when the daemon is not reachable (ECONNREFUSED, ECONNRESET, etc.). */
export class ConnectionError extends Error {
	constructor(
		public readonly port: number,
		cause?: unknown,
	) {
		super(`Could not connect to daemon at http://localhost:${port}`);
		this.name = "ConnectionError";
		if (cause instanceof Error) {
			this.cause = cause;
		}
	}
}

/** Thrown when the daemon accepted the connection but did not respond in time. */
export class TimeoutError extends Error {
	constructor(
		public readonly port: number,
		public readonly timeoutMs: number,
		public readonly path: string,
	) {
		super(`Daemon did not respond within ${Math.round(timeoutMs / 1000)}s for ${path}`);
		this.name = "TimeoutError";
	}
}

export interface DaemonResponse {
	status: number;
	data: unknown;
}

export class DaemonClient {
	private readonly baseUrl: string;
	private readonly retryDelayMs: number;
	private readonly requestTimeoutMs: number;

	constructor(options: { port: number; retryDelayMs?: number; requestTimeoutMs?: number }) {
		this.baseUrl = `http://localhost:${options.port}`;
		this.retryDelayMs = options.retryDelayMs ?? 1000;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
	}

	async get(path: string, options?: { requestTimeoutMs?: number }): Promise<DaemonResponse> {
		return this.request("GET", path, undefined, options?.requestTimeoutMs);
	}

	async post(
		path: string,
		body?: unknown,
		options?: { requestTimeoutMs?: number },
	): Promise<DaemonResponse> {
		return this.request("POST", path, body, options?.requestTimeoutMs);
	}

	async patch(path: string, body?: unknown): Promise<DaemonResponse> {
		return this.request("PATCH", path, body);
	}

	async delete(
		path: string,
		options?: { body?: unknown; requestTimeoutMs?: number },
	): Promise<DaemonResponse> {
		return this.request("DELETE", path, options?.body, options?.requestTimeoutMs);
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
		requestTimeoutMs?: number,
	): Promise<DaemonResponse> {
		const url = `${this.baseUrl}${path}`;
		const port = Number.parseInt(this.baseUrl.split(":").pop() ?? "7580", 10);
		const timeoutMs = requestTimeoutMs ?? this.requestTimeoutMs;

		const init: RequestInit = { method };
		if (body !== undefined) {
			init.headers = { "Content-Type": "application/json" };
			init.body = JSON.stringify(body);
		}

		// Retry on connection errors (daemon not reachable) up to 3 times — but
		// only for GET, which has no side effects. A mutating request (POST/
		// PATCH/DELETE) may have already been processed by the daemon before
		// the connection dropped (e.g. mid-restart, or a dropped socket after
		// the daemon executed the mutation but before the response made it
		// back); blindly resubmitting it risks double-executing a non-
		// idempotent action, like creating a duplicate buy/sell order. Do NOT
		// retry on timeouts either — the daemon is running but busy, retrying
		// just adds load and produces misleading "connection failed" errors.
		const maxAttempts = method === "GET" ? 3 : 1;
		let lastErr: unknown;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (attempt > 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
			}
			const controller = timeoutMs > 0 ? new AbortController() : undefined;
			const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
			try {
				const fetchInit = controller ? { ...init, signal: controller.signal } : init;
				const response = await fetch(url, fetchInit);
				let data: unknown;
				try {
					data = await response.json();
				} catch {
					data = { error: "Invalid response from daemon" };
				}
				return { status: response.status, data };
			} catch (err) {
				if (timeoutId !== undefined) clearTimeout(timeoutId);
				// Timeout: the daemon IS running but didn't respond in time.
				// Report this accurately and do not retry.
				if (err instanceof Error && err.name === "AbortError") {
					throw new TimeoutError(port, timeoutMs, path);
				}
				// Connection error: daemon may not be running. Retry.
				lastErr = err;
			} finally {
				if (timeoutId !== undefined) clearTimeout(timeoutId);
			}
		}

		throw new ConnectionError(port, lastErr);
	}
}
