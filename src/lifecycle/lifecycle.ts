/**
 * Where this setpoint process is in its life, and the notices other sessions
 * watch for.
 *
 * Every phase change is logged at warn under `[setpoint-lifecycle]` in the
 * same `daemon.log` the client sessions already monitor, with an upper-case
 * keyword they can filter on:
 *
 * - `RESTART PENDING` — an operator announced a restart (`smctl
 *   announce-restart`). Scripts that need setpoint to answer should hold.
 * - `HANDOVER STARTING` — a new release is connecting every account in
 *   standby. The running daemon keeps working; nothing to do yet.
 * - `HANDOVER CUTOVER` — the running daemon is handing over. For a few
 *   seconds, mutating requests get 503 with `retry_after`; event streams drop
 *   and should reconnect.
 * - `READY` — this process is serving every account and has resumed loops and
 *   jobs. Normal service.
 * - `STOPPING` — this process is shutting down without a successor.
 *
 * The same state is on `GET /health` as `lifecycle`.
 */

import { createLogger } from "../util/logger.js";

const log = createLogger("setpoint-lifecycle");

export type LifecyclePhase = "starting" | "standby" | "active" | "draining" | "stopping";

export interface LifecycleStatus {
	phase: LifecyclePhase;
	pid: number;
	/** The release this process runs, when known (a git commit). */
	release?: string | undefined;
	/** Set while an announced restart is pending. */
	restartPending?: { at: string; reason: string } | undefined;
}

export class Lifecycle {
	private phaseValue: LifecyclePhase = "starting";
	private restartPending: { at: string; reason: string } | undefined;
	private handoverListener: (() => void) | undefined;

	constructor(
		private readonly release: string | undefined = undefined,
		private readonly now: () => Date = () => new Date(),
	) {}

	get phase(): LifecyclePhase {
		return this.phaseValue;
	}

	status(): LifecycleStatus {
		return {
			phase: this.phaseValue,
			pid: process.pid,
			...(this.release !== undefined ? { release: this.release } : {}),
			...(this.restartPending !== undefined ? { restartPending: this.restartPending } : {}),
		};
	}

	/** Tell everyone watching that a restart is coming, and why. */
	announceRestart(inSeconds: number, reason: string): { at: string; reason: string } {
		const at = new Date(this.now().getTime() + inSeconds * 1000).toISOString();
		this.restartPending = { at, reason };
		log.warn(
			`RESTART PENDING: setpoint restarts at ${at} (in ${inSeconds}s) — ${reason}. Expect a pause of a few seconds at cutover; hold anything that cannot tolerate one.`,
		);
		return this.restartPending;
	}

	/** This process is connecting accounts while another setpoint still serves. */
	enterStandby(activePid: number | undefined): void {
		this.phaseValue = "standby";
		log.warn(
			`HANDOVER STARTING: a new setpoint (pid ${process.pid}${this.release ? `, release ${this.release}` : ""}) is connecting every account in standby. The running daemon${activePid ? ` (pid ${activePid})` : ""} keeps working; nothing to do yet.`,
		);
	}

	/** This (outgoing) process is handing over: stop taking new work. */
	enterDraining(): void {
		this.phaseValue = "draining";
		log.warn(
			"HANDOVER CUTOVER: handing over to the new setpoint. Mutating requests get 503 with retry_after for a few seconds; event streams will drop and should reconnect.",
		);
	}

	/** Serving every account, with loops and jobs resumed. */
	enterActive(accounts: number): void {
		this.phaseValue = "active";
		this.restartPending = undefined;
		log.warn(
			`READY: setpoint pid ${process.pid}${this.release ? ` (release ${this.release})` : ""} is serving ${accounts} account(s); loops and jobs resumed.`,
		);
	}

	/** Shutting down with no successor lined up. */
	enterStopping(): void {
		if (this.phaseValue === "draining") return;
		this.phaseValue = "stopping";
		log.warn("STOPPING: setpoint is shutting down. Requests will fail until it is started again.");
	}

	/**
	 * Mutating requests are refused while draining, so nothing new starts on a
	 * ship the successor is about to take over. Reads stay available.
	 */
	refusesRequest(method: string, pathname: string): boolean {
		if (this.phaseValue !== "draining") return false;
		if (method === "GET" || method === "HEAD") return false;
		return !pathname.startsWith("/lifecycle/");
	}

	/** Register what runs when a successor asks this process to hand over. */
	onHandoverRequested(listener: () => void): void {
		this.handoverListener = listener;
	}

	/**
	 * A successor in standby asks this process to hand over. Returns false if
	 * this process is not in a state to (already draining, or no listener).
	 */
	requestHandover(): boolean {
		if (this.phaseValue !== "active" || !this.handoverListener) return false;
		this.enterDraining();
		const listener = this.handoverListener;
		queueMicrotask(listener);
		return true;
	}
}
