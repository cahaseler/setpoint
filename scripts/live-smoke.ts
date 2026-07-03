#!/usr/bin/env bun
/**
 * Read-only connectivity smoke test for the lib cutover. Lists owned players,
 * connects them all via connectOwned (exercising the real connect/auth/seed
 * path), prints each account's seeded state, runs a raw get_status query, and
 * disconnects. No mutations — safe against any account.
 *
 * Usage: SPACEMOLT_CLERK_API_KEY=ak_... bun run scripts/live-smoke.ts
 */
import { SpacemoltClient } from "@spacemolt/lib";

async function main(): Promise<void> {
	const clerkApiKey = process.env["SPACEMOLT_CLERK_API_KEY"];
	if (!clerkApiKey) {
		console.error("SPACEMOLT_CLERK_API_KEY required");
		process.exit(2);
	}

	const client = new SpacemoltClient({ clerkApiKey });

	console.log("Listing owned players...");
	const owned = await client.listOwnedPlayers();
	console.log(
		`Owned: ${owned.map((p) => `${p.username} (id=${p.id}, ${p.empire})`).join(", ") || "(none)"}`,
	);

	console.log("Connecting all owned (connectOwned)...");
	const accounts = await client.connectOwned({});
	console.log(`Connected ${accounts.length} account(s).`);

	for (const acc of accounts) {
		console.log(`\n=== ${acc.id} (player_id=${acc.player?.id}) ===`);
		const st = acc.state;
		console.log(`  location: ${JSON.stringify(st.location ?? {})}`);
		console.log(
			`  ship: fuel ${st.ship?.fuel ?? "?"}/${st.ship?.max_fuel ?? "?"}, hull ${st.ship?.hull ?? "?"}/${st.ship?.max_hull ?? "?"}`,
		);
		console.log(`  credits: ${st.player?.credits ?? "?"}`);
		console.log(`  cargo items: ${st.cargo?.items?.length ?? "?"}`);
		try {
			const res = await acc.query("spacemolt", "get_status");
			const keys = Object.keys((res.structuredContent as Record<string, unknown>) ?? {});
			console.log(`  get_status query OK — structuredContent keys: ${keys.join(", ")}`);
		} catch (e) {
			console.log(`  get_status query FAILED: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	client.closeAll();
	console.log("\nDone. Disconnected cleanly.");
}

main().catch((err) => {
	console.error(`smoke failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
	process.exit(1);
});
