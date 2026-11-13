/**
 * Taking over from a running setpoint without taking the fleet down.
 *
 * Since game v0.707 an account may hold several WebSocket connections at once,
 * and a new one no longer closes the old. So a successor release can connect
 * every account while the incumbent keeps serving — the minutes a fleet
 * connect takes under the per-IP connection cap become invisible — and only
 * then ask it to hand over. The visible gap is the cutover itself: the
 * incumbent stops its loops and in-flight work and releases the port; the
 * successor binds it and resumes everything from persisted state.
 *
 * An incumbent too old to know about handover answers the request with 404.
 * The successor then waits for it to be stopped the ordinary way (SIGTERM)
 * and takes the port the moment it is free, so even that deploy gets the
 * pre-connected fast cutover.
 */

import { createLogger } from "../util/logger.js";
import type { LifecycleStatus } from "./lifecycle.js";

const log = createLogger("handover");

/** A setpoint already serving on the API port. `pid` is unknown for one that predates handover. */
export interface Incumbent {
	pid: number | undefined;
}

/** The git commit the code runs from, for the lifecycle notices. Undefined outside a checkout. */
export function readRelease(codeDir: string): string | undefined {
	try {
		const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: codeDir });
		const sha = result.stdout.toString().trim();
		return result.exitCode === 0 && sha !== "" ? sha : undefined;
	} catch {
		return undefined;
	}
}

/** Is a setpoint answering on this port? */
export async function findIncumbent(
	port: number,
	fetchImpl: typeof fetch = fetch,
): Promise<Incumbent | undefined> {
	try {
		const res = await fetchImpl(`http://127.0.0.1:${port}/health`, {
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) return undefined;
		const body = (await res.json()) as { lifecycle?: LifecycleStatus };
		return { pid: body.lifecycle?.pid };
	} catch {
		return undefined;
	}
}

/**
 * A minimal server on a spare port while in standby, so the handover can be
 * watched (`curl :7581/health`) while the main port still belongs to the
 * incumbent.
 */
export function startStandbyControl(
	port: number,
	status: () => Record<string, unknown>,
): ReturnType<typeof Bun.serve> {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		fetch: (req) =>
			new URL(req.url).pathname === "/health"
				? Response.json({ status: "standby", ...status() })
				: Response.json({ error: "standby: only /health is served here" }, { status: 404 }),
	});
	log.info(`Standby status on http://127.0.0.1:${server.port}/health`);
	return server;
}

export interface TakeOverOptions {
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	isAlive?: (pid: number) => boolean;
	pollMs?: number;
}

const defaultIsAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/**
 * Ask the incumbent to hand over, then wait until it has released the API
 * port and exited. Never gives up: the incumbent is serving the whole time,
 * so waiting costs nothing, and starting while it still runs would put two
 * drivers on every ship.
 */
export async function takeOverFrom(
	port: number,
	incumbent: Incumbent,
	{
		fetchImpl = fetch,
		sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		isAlive = defaultIsAlive,
		pollMs = 250,
	}: TakeOverOptions = {},
): Promise<void> {
	let pid = incumbent.pid;
	let asked = false;
	let warnedLegacy = false;
	for (;;) {
		if (!asked) {
			try {
				const res = await fetchImpl(`http://127.0.0.1:${port}/lifecycle/handover`, {
					method: "POST",
					signal: AbortSignal.timeout(5000),
				});
				if (res.status === 202) {
					const body = (await res.json()) as { pid?: number };
					pid = body.pid ?? pid;
					asked = true;
					log.info(`Incumbent (pid ${pid ?? "?"}) is handing over`);
				} else if (res.status === 404 || res.status === 405) {
					// Predates handover. It keeps serving until stopped by hand.
					if (!warnedLegacy) {
						log.warn(
							`The running setpoint predates handover. Stop it the usual way (kill -TERM <its pid>); this process holds every account and takes over the moment port ${port} is free.`,
						);
						warnedLegacy = true;
					}
					asked = true;
				} else {
					// 409: not ready to hand over (still starting, already draining).
					await sleep(2000);
					continue;
				}
			} catch {
				// The port went quiet between checks — the incumbent is already gone.
				asked = true;
			}
		}
		const stillServing = (await findIncumbent(port, fetchImpl)) !== undefined;
		const stillRunning = pid !== undefined && isAlive(pid);
		if (!stillServing && !stillRunning) return;
		await sleep(pollMs);
	}
}

/**
 * Run `bind` until the port accepts it. The incumbent can stop answering a
 * moment before the kernel releases its socket.
 */
export async function bindWithRetry<T>(
	bind: () => T,
	{
		attempts = 40,
		sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	}: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return bind();
		} catch (err) {
			const inUse = err instanceof Error && /EADDRINUSE|in use/i.test(err.message);
			if (!inUse || attempt >= attempts) throw err;
			await sleep(250);
		}
	}
}
