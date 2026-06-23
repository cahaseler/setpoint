import { type Logger, createLogger } from "./logger.js";

interface WindowAccumulator {
	startMs: number;
	requests: number;
	bytes: number;
	byAccount: Map<string, number>;
	byEndpoint: Map<string, number>;
}

interface BandwidthTrackerOptions {
	logger?: Logger;
}

const DEFAULT_ROLLUP_INTERVAL_MS = 5 * 60 * 1000;
const TOP_N = 5;

function formatBytes(n: number): string {
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)}MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${n}B`;
}

function newWindow(): WindowAccumulator {
	return {
		startMs: Date.now(),
		requests: 0,
		bytes: 0,
		byAccount: new Map(),
		byEndpoint: new Map(),
	};
}

export class BandwidthTracker {
	private window: WindowAccumulator = newWindow();
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly log: Logger;

	constructor(options: BandwidthTrackerOptions = {}) {
		this.log = options.logger ?? createLogger("bandwidth");
	}

	record(accountId: string, endpoint: string, bytes: number): void {
		this.log.debug(`${accountId} ${endpoint} ${bytes}B`);
		this.window.requests++;
		this.window.bytes += bytes;
		this.window.byAccount.set(accountId, (this.window.byAccount.get(accountId) ?? 0) + bytes);
		this.window.byEndpoint.set(endpoint, (this.window.byEndpoint.get(endpoint) ?? 0) + bytes);
	}

	flush(): void {
		const w = this.window;
		this.window = newWindow();
		if (w.requests === 0) return;

		const elapsedMs = Date.now() - w.startMs;
		const elapsedMin = (elapsedMs / 60_000).toFixed(1);
		const avgBytes = Math.round(w.bytes / w.requests);

		const topAccounts = [...w.byAccount.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, TOP_N)
			.map(([id, b]) => `${id} ${formatBytes(b)}`)
			.join(", ");

		const topEndpoints = [...w.byEndpoint.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, TOP_N)
			.map(([ep, b]) => `${ep} ${formatBytes(b)}`)
			.join(", ");

		this.log.info(
			`${elapsedMin}min window: ${formatBytes(w.bytes)} in ${w.requests} requests (${avgBytes}B/req)${topAccounts ? ` — accounts: ${topAccounts}` : ""}${topEndpoints ? ` — endpoints: ${topEndpoints}` : ""}`,
		);
	}

	start(intervalMs = DEFAULT_ROLLUP_INTERVAL_MS): void {
		this.stop();
		this.timer = setInterval(() => this.flush(), intervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	getStats(): {
		requests: number;
		bytes: number;
		byAccount: Map<string, number>;
		byEndpoint: Map<string, number>;
	} {
		return {
			requests: this.window.requests,
			bytes: this.window.bytes,
			byAccount: this.window.byAccount,
			byEndpoint: this.window.byEndpoint,
		};
	}
}

export const bandwidthTracker = new BandwidthTracker();
