#!/usr/bin/env bun
/**
 * Validate the live mutation → delta → cache pipeline with a safe, reversible
 * pair: undock, then dock back. Inspects the MutationResult (command/tick/delta
 * sections + delta.details) and the post-mutation account.state.
 *
 * Usage: SPACEMOLT_CLERK_API_KEY=ak_... bun run scripts/live-mutation.ts <username>
 */
import { SpacemoltClient } from "@spacemolt/lib";

async function main(): Promise<void> {
	const clerkApiKey = process.env["SPACEMOLT_CLERK_API_KEY"];
	if (!clerkApiKey) {
		console.error("SPACEMOLT_CLERK_API_KEY required");
		process.exit(2);
	}
	const username = process.argv[2] ?? "KestrelVoss";

	const client = new SpacemoltClient({ clerkApiKey });
	const accounts = await client.connectOwned({
		filter: (p) => p.username.toLowerCase() === username.toLowerCase(),
	});
	const acc = accounts[0];
	if (!acc) {
		console.error(`no owned account matched "${username}"`);
		client.closeAll();
		process.exit(1);
	}

	const describeDelta = (
		label: string,
		r: { command: string; tick: number; delta: Record<string, unknown> },
	): void => {
		const sections = Object.keys(r.delta).filter((k) => k !== "details");
		console.log(`  ${label}: command=${r.command} tick=${r.tick}`);
		console.log(`    delta sections: ${sections.join(", ") || "(none)"}`);
		console.log(
			`    delta.details: ${r.delta["details"] ? JSON.stringify(r.delta["details"]).slice(0, 200) : "(none)"}`,
		);
	};

	console.log(`Start: docked_at=${acc.state.location?.docked_at ?? "(undocked)"}`);

	console.log("Undock (mutation)...");
	const undock = await acc.commands.spacemolt.undock();
	describeDelta("undock result", undock);
	console.log(`  post-mutation cache: docked_at=${acc.state.location?.docked_at ?? "(undocked)"}`);

	console.log("Dock back (mutation)...");
	const dock = await acc.commands.spacemolt.dock();
	describeDelta("dock result", dock);
	console.log(`  post-mutation cache: docked_at=${acc.state.location?.docked_at ?? "(undocked)"}`);

	client.closeAll();
	console.log("Done. Left docked, disconnected.");
}

main().catch((err) => {
	console.error(
		`mutation test failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
	);
	process.exit(1);
});
