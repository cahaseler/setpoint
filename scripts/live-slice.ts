#!/usr/bin/env bun
/**
 * Live-test harness for the Phase 3 vertical slice. Connects a real owned account
 * via the Clerk API key and runs one ported goal against the live game — the first
 * real @spacemolt/lib pressure test.
 *
 * Usage:
 *   SPACEMOLT_CLERK_API_KEY=... bun run scripts/live-slice.ts <username> ensure-fueled
 *   SPACEMOLT_CLERK_API_KEY=... bun run scripts/live-slice.ts <username> navigate <systemId>
 *   SPACEMOLT_CLERK_API_KEY=... bun run scripts/live-slice.ts <username> go-to-poi <poiId>
 *   SPACEMOLT_CLERK_API_KEY=... bun run scripts/live-slice.ts <username> patrol <sysA> <sysB>
 *
 * WARNING: navigate/go-to-poi/patrol MOVE the ship. Run only against a low-stakes
 * account you intend to move. ensure-fueled is safe (idempotent, docked-only).
 */
import type { StateSection } from "@spacemolt/lib";
import { SpacemoltClient } from "@spacemolt/lib";
import type { GoalResult } from "../src/dispatcher/goals.js";
import { makeLibGoalContext } from "../src/dispatcher/lib-goal-context.js";
import { formatSliceReport, libPatrolLoop } from "../src/dispatcher/lib-patrol-loop.js";
import { LibEnsureFueled } from "../src/dispatcher/lib-primitives/ensure-fueled.js";
import { LibGoToPoi } from "../src/dispatcher/lib-primitives/go-to-poi.js";
import { LibNavigateToSystem } from "../src/dispatcher/lib-primitives/navigate-to-system.js";

async function main(): Promise<void> {
	const clerkApiKey = process.env["SPACEMOLT_CLERK_API_KEY"];
	if (!clerkApiKey) {
		console.error("SPACEMOLT_CLERK_API_KEY is required");
		process.exit(2);
	}
	const [username, kind, arg1, arg2] = process.argv.slice(2);
	if (!username || !kind) {
		console.error(
			"Usage: bun run scripts/live-slice.ts <username> <ensure-fueled|navigate|go-to-poi|patrol> [arg]",
		);
		process.exit(2);
	}

	const client = new SpacemoltClient({ clerkApiKey });
	const accounts = await client.connectOwned({
		filter: (p) => p.username.toLowerCase() === username.toLowerCase(),
	});
	const account = accounts[0];
	if (!account) {
		console.error(`No owned account matched "${username}"`);
		client.closeAll();
		process.exit(1);
	}

	// Observe which state sections change during the run (the live signal for
	// "does a mutation's delta carry location/ship?").
	const observed = new Set<StateSection>();
	account.onStateChange((changed) => {
		for (const s of changed) observed.add(s);
	});

	const ctx = makeLibGoalContext(account);
	const started = performance.now();
	let result: GoalResult;
	try {
		if (kind === "ensure-fueled") {
			result = await new LibEnsureFueled().execute(ctx);
		} else if (kind === "navigate") {
			if (!arg1) throw new Error("navigate requires a target system id");
			result = await new LibNavigateToSystem(arg1).execute(ctx);
		} else if (kind === "go-to-poi") {
			if (!arg1) throw new Error("go-to-poi requires a POI id");
			result = await new LibGoToPoi(arg1).execute(ctx);
		} else if (kind === "patrol") {
			if (!arg1 || !arg2) throw new Error("patrol requires two system ids");
			result = await libPatrolLoop(ctx, [arg1, arg2], { maxIterations: 2 });
		} else {
			throw new Error(`unknown goal kind: ${kind}`);
		}
	} finally {
		// Report is printed after; keep the connection until we've read final state.
	}
	const elapsedMs = Math.round(performance.now() - started);

	console.log(formatSliceReport(`${kind}${arg1 ? ` ${arg1}` : ""}`, result, [...observed]));
	console.log(`elapsed: ${elapsedMs}ms`);
	console.log(`final location: ${JSON.stringify(account.state.location ?? {})}`);
	console.log(
		`final ship fuel: ${account.state.ship?.fuel ?? "?"}/${account.state.ship?.max_fuel ?? "?"}`,
	);

	client.closeAll();
}

main().catch((err) => {
	console.error(
		`live-slice failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
	);
	process.exit(1);
});
