import type { Logger } from "./logger.js";

/**
 * Bun's default for an unhandled promise rejection is to crash the whole
 * process (exit code 1) — reasonable for a short-lived script, wrong for a
 * daemon supervising up to ~100 concurrent WebSocket connections. A single
 * account's connection dropping (e.g. during a routine game-server update,
 * which closes every open connection near-simultaneously) can reject an
 * in-flight query/mutation promise; if some code path anywhere in the
 * dependency tree ever fails to await/catch one, that must not take down
 * every other account's active goals and loops with it. Logged loudly at
 * ERROR (never swallowed silently) so a real leak still surfaces — this is a
 * safety net, not a substitute for fixing the leak if one is found.
 */
export function installCrashSafetyHandlers(log: Logger): void {
	process.on("unhandledRejection", (reason) => {
		const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
		log.error(`Unhandled promise rejection (daemon continues running): ${detail}`);
	});
	process.on("uncaughtException", (err) => {
		log.error(`Uncaught exception (daemon continues running): ${err.stack ?? err.message}`);
	});
}
