import { ConnectionError, type DaemonClient, TimeoutError } from "./client.js";
import type { CliOutput } from "./output.js";

export interface CommandContext {
	client: DaemonClient;
	output: CliOutput;
	/** Raw JSON body from --json flag or --stdin. */
	jsonBody: unknown | undefined;
	/** Whether --async was passed (for goal command). */
	asyncMode?: boolean;
	/** Whether --force was passed (for abort command). */
	forceMode?: boolean;
}

type CommandHandler = (ctx: CommandContext, args: string[]) => Promise<void>;

/** Timeout for operations that call the game API (goals, raw actions, registration, etc.). No upper bound — goals and loops can run for 20+ minutes. */
const GAME_API_TIMEOUT_MS = 0;

interface Command {
	/** Pattern like "health" or "accounts list" or "accounts get". */
	pattern: string;
	/** Positional arg names after the pattern (e.g., ["playerId"]). */
	positionals: string[];
	handler: CommandHandler;
	usage: string;
	/** Short description shown in help text. */
	description: string;
	/** When true, all remaining args after the first positional are passed through. */
	variadic?: boolean;
}

const commands: Command[] = [
	{
		pattern: "status",
		positionals: [],
		handler: handleStatus,
		usage: "smctl status",
		description:
			"JSON dashboard data for all accounts (state, loop, hasRunningJob, hasExecutingGoal, recentJobs)",
	},
	{
		pattern: "health",
		positionals: [],
		handler: handleHealth,
		usage: "smctl health",
		description: "Check daemon health and uptime",
	},
	{
		pattern: "accounts list",
		positionals: [],
		handler: handleAccountsList,
		usage: "smctl accounts list",
		description: "List all connected accounts",
	},
	{
		pattern: "accounts get",
		positionals: ["playerId"],
		handler: handleAccountsGet,
		usage: "smctl accounts get <playerId>",
		description: "Get account details",
	},
	{
		pattern: "accounts add",
		positionals: [],
		handler: handleAccountsAdd,
		usage: "smctl accounts add --json '<json>' | --stdin",
		description: "Add an existing account",
	},
	{
		pattern: "accounts register",
		positionals: [],
		handler: handleAccountsRegister,
		usage: "smctl accounts register --json '<json>' | --stdin",
		description: "Register a new account",
	},
	{
		pattern: "accounts remove",
		positionals: ["playerId"],
		handler: handleAccountsRemove,
		usage: "smctl accounts remove <playerId>",
		description: "Disconnect and remove an account",
	},
	{
		pattern: "state",
		positionals: ["playerId", "section?"],
		handler: handleState,
		usage: "smctl state <playerId> [section]",
		description: "Get game state or a specific section",
	},
	{
		pattern: "market",
		positionals: ["playerId", "baseId"],
		handler: handleMarket,
		usage: "smctl market <playerId> <baseId>",
		description:
			"Get the cached order book for a base (subscribe first via the HTTP raw passthrough: toolGroup spacemolt_market, action subscribe_market)",
	},
	{
		pattern: "observation",
		positionals: ["playerId"],
		handler: handleObservation,
		usage: "smctl observation <playerId>",
		description:
			"Get the cached observation-watch view (subscribe first via `smctl raw <playerId> subscribe_observation`)",
	},
	{
		pattern: "loop status",
		positionals: ["playerId"],
		handler: handleLoopStatus,
		usage: "smctl loop status <playerId>",
		description: "Check loop status for an account",
	},
	{
		pattern: "loop start",
		positionals: ["playerId"],
		handler: handleLoopStart,
		usage: "smctl loop start <playerId> --json '<json>' | --stdin",
		description: "Start a repeating loop",
	},
	{
		pattern: "loop stop",
		positionals: ["playerId"],
		handler: handleLoopStop,
		usage: "smctl loop stop <playerId>",
		description: "Stop a running loop and delete persisted config",
	},
	{
		pattern: "loop update",
		positionals: ["playerId"],
		handler: handleLoopUpdate,
		usage: "smctl loop update <playerId> --json '<json>' | --stdin",
		description: "Patch options on a running loop (takes effect next iteration, no restart needed)",
	},
	{
		pattern: "combat-mode",
		positionals: ["playerId", "mode?"],
		handler: handleCombatMode,
		usage: "smctl combat-mode <playerId> [flee|external]",
		description:
			"Get or set an account's combat-response mode. \"external\" skips setpoint's automatic flee response (still releases any running loop/goal) so hand-written combat logic can drive the ship instead.",
	},
	{
		pattern: "abort",
		positionals: ["playerId"],
		handler: handleAbort,
		usage: "smctl abort <playerId> [--force]",
		description: "Show status of in-progress work, or stop it with --force",
	},
	{
		pattern: "goal",
		positionals: ["playerId"],
		handler: handleGoal,
		usage: "smctl goal <playerId> [--async] --json '<json>' | --stdin",
		description: "Execute a one-off goal (--async returns job_id immediately)",
	},
	{
		pattern: "job status",
		positionals: ["jobId"],
		handler: handleJobStatus,
		usage: "smctl job status <jobId>",
		description: "Get status of an async goal job",
	},
	{
		pattern: "raw",
		positionals: ["playerId"],
		handler: handleRaw,
		usage: "smctl raw <player> <action> [args...]",
		description: "Raw game API passthrough via the daemon's managed session",
		variadic: true,
	},
	{
		pattern: "log-level",
		positionals: ["level?"],
		handler: handleLogLevel,
		usage: "smctl log-level [debug|info|warn|error]",
		description: "Get or set the log level",
	},
	{
		pattern: "help goals",
		positionals: [],
		handler: handleHelpGoals,
		usage: "smctl help goals",
		description: "List all goal types and their options",
	},
	{
		pattern: "help loops",
		positionals: [],
		handler: handleHelpLoops,
		usage: "smctl help loops",
		description: "List all loop types with example JSON",
	},
	{
		pattern: "help mining",
		positionals: [],
		handler: handleHelpMining,
		usage: "smctl help mining",
		description: "Mining loop detailed reference",
	},
	{
		pattern: "help trading",
		positionals: [],
		handler: handleHelpTrading,
		usage: "smctl help trading",
		description: "Trading loop detailed reference",
	},
	{
		pattern: "help hauling",
		positionals: [],
		handler: handleHelpHauling,
		usage: "smctl help hauling",
		description: "Hauling loop detailed reference",
	},
	{
		pattern: "help storage-transfer",
		positionals: [],
		handler: handleHelpStorageTransfer,
		usage: "smctl help storage-transfer",
		description: "Storage-transfer loop detailed reference",
	},
	{
		pattern: "help exploration",
		positionals: [],
		handler: handleHelpExploration,
		usage: "smctl help exploration",
		description: "Exploration loop detailed reference",
	},
	{
		pattern: "help salvage",
		positionals: [],
		handler: handleHelpSalvage,
		usage: "smctl help salvage",
		description: "Salvage loop detailed reference",
	},
	{
		pattern: "help guard",
		positionals: [],
		handler: handleHelpGuard,
		usage: "smctl help guard",
		description: "Guard loop detailed reference",
	},
	{
		pattern: "help roaming-salvage",
		positionals: [],
		handler: handleHelpRoamingSalvage,
		usage: "smctl help roaming-salvage",
		description: "Roaming salvage loop detailed reference",
	},
	{
		pattern: "help tow-salvage",
		positionals: [],
		handler: handleHelpTowSalvage,
		usage: "smctl help tow-salvage",
		description: "Tow-salvage loop detailed reference",
	},
	{
		pattern: "help fuel-rescue",
		positionals: [],
		handler: handleHelpFuelRescue,
		usage: "smctl help fuel-rescue",
		description: "Fuel rescue goal reference",
	},
	{
		pattern: "help",
		positionals: [],
		handler: handleHelpGeneral,
		usage: "smctl help [topic]",
		description:
			"Show help (topics: goals, loops, mining, trading, hauling, storage-transfer, exploration, salvage, guard, roaming-salvage, tow-salvage, fuel-rescue)",
	},
];

/**
 * Find and execute a matching command.
 *
 * Returns true if a command matched, false if no match found.
 */
export async function dispatch(ctx: CommandContext, args: string[]): Promise<boolean> {
	// Try longest patterns first (e.g., "accounts list" before "accounts")
	for (const cmd of commands) {
		const patternWords = cmd.pattern.split(" ");
		const patternLength = patternWords.length;

		// Check if the args start with the pattern
		const matches = patternWords.every((word, i) => args[i] === word);
		if (!matches) continue;

		const remaining = args.slice(patternLength);

		// Check positional arg count
		const required = cmd.positionals.filter((p) => !p.endsWith("?")).length;
		const maxPositionals = cmd.positionals.length;

		if (remaining.length < required) {
			ctx.output.usageError(`Missing required argument. Usage: ${cmd.usage}`);
		}
		if (!cmd.variadic && remaining.length > maxPositionals) {
			ctx.output.usageError(`Too many arguments. Usage: ${cmd.usage}`);
		}

		await cmd.handler(ctx, remaining);
		return true;
	}

	return false;
}

/** Get usage text for all commands. */
export function getUsageText(): string {
	const lines = ["Usage: smctl <command> [options]", "", "Commands:"];
	for (const cmd of commands) {
		const padding = Math.max(2, 40 - cmd.usage.length);
		lines.push(`  ${cmd.usage}${" ".repeat(padding)}${cmd.description}`);
	}
	lines.push("", "Options:");
	lines.push("  --port <number>   Daemon port (default: 7580, or SM_PORT env)");
	lines.push("  --json <string>   JSON body for POST commands");
	lines.push("  --stdin           Read JSON body from stdin");
	lines.push(
		"  --async           Submit goal in background, return job_id immediately (goal only)",
	);
	lines.push(
		"",
		"Raw command posts to the daemon's /accounts/:playerId/raw passthrough using the account's managed session.",
		"Args after the action are key=value pairs (-> params.key) or a single bare value (-> params.id).",
		"",
		"Run 'smctl help <topic>' for detailed help on goals, loops, mining, salvage, trading, hauling, storage-transfer, exploration, or guard.",
	);
	return lines.join("\n");
}

// ── Command Handlers ────────────────────────────────────────────────

async function sendAndOutput(
	ctx: CommandContext,
	fn: () => Promise<{ status: number; data: unknown }>,
): Promise<void> {
	try {
		const { status, data } = await fn();
		ctx.output.fromStatus(status, data);
	} catch (err) {
		if (err instanceof TimeoutError) {
			ctx.output.timeoutError(err.message);
		}
		if (err instanceof ConnectionError) {
			ctx.output.connectionError(err.message);
		}
		throw err;
	}
}

async function handleHealth(ctx: CommandContext, _args: string[]): Promise<void> {
	await sendAndOutput(ctx, () => ctx.client.get("/health"));
}

async function handleStatus(ctx: CommandContext, _args: string[]): Promise<void> {
	await sendAndOutput(ctx, () => ctx.client.get("/dashboard/data"));
}

async function handleAccountsList(ctx: CommandContext, _args: string[]): Promise<void> {
	await sendAndOutput(ctx, () => ctx.client.get("/accounts"));
}

async function handleAccountsGet(ctx: CommandContext, args: string[]): Promise<void> {
	const playerId = args[0] as string;
	await sendAndOutput(ctx, () => ctx.client.get(`/accounts/${encodeURIComponent(playerId)}`));
}

async function handleAccountsAdd(ctx: CommandContext, _args: string[]): Promise<void> {
	if (ctx.jsonBody === undefined) {
		ctx.output.usageError(
			"--json or --stdin required. Usage: smctl accounts add --json '<json>' | --stdin",
		);
	}
	await sendAndOutput(ctx, () => ctx.client.post("/accounts", ctx.jsonBody));
}

async function handleAccountsRemove(ctx: CommandContext, args: string[]): Promise<void> {
	const playerId = args[0] as string;
	// Removal waits for any running loop to stop, which blocks on the current game API call.
	await sendAndOutput(ctx, () =>
		ctx.client.delete(`/accounts/${encodeURIComponent(playerId)}`, {
			requestTimeoutMs: GAME_API_TIMEOUT_MS,
		}),
	);
}

async function handleState(ctx: CommandContext, args: string[]): Promise<void> {
	const playerId = args[0] as string;
	const section = args[1];
	const path = section
		? `/accounts/${encodeURIComponent(playerId)}/state/${encodeURIComponent(section)}`
		: `/accounts/${encodeURIComponent(playerId)}/state`;
	await sendAndOutput(ctx, () => ctx.client.get(path));
}

async function handleMarket(ctx: CommandContext, args: string[]): Promise<void> {
	const playerId = args[0] as string;
	const baseId = args[1] as string;
	await sendAndOutput(ctx, () =>
		ctx.client.get(
			`/accounts/${encodeURIComponent(playerId)}/market/${encodeURIComponent(baseId)}`,
		),
	);
}

async function handleObservation(ctx: CommandContext, args: string[]): Promise<void> {
	const playerId = args[0] as string;
	await sendAndOutput(ctx, () =>
		ctx.client.get(`/accounts/${encodeURIComponent(playerId)}/observation`),
	);
}

async function handleLoopStatus(ctx: CommandContext, args: string[]): Promise<void> {
	const playerId = args[0] as string;
	await sendAndOutput(ctx, () => ctx.client.get(`/accounts/${encodeURIComponent(playerId)}/loop`));
}

async function handleLoopStart(ctx: CommandContext, args: string[]): Promise<void> {
	const playerId = args[0] as string;
	if (ctx.jsonBody === undefined) {
		ctx.output.usageError(
			"--json or --stdin required. Usage: smctl loop start <playerId> --json '<json>' | --stdin",
		);
	}
	// Replacing a running loop waits for the old one to actually stop, which
	// blocks on its current game API call.
	await sendAndOutput(ctx, () =>
		ctx.client.post(`/accounts/${encodeURIComponent(playerId)}/loop`, ctx.jsonBody, {
			requestTimeoutMs: GAME_API_TIMEOUT_MS,
		}),
	);
}

async function handleLoopStop(ctx: CommandContext, args: string[]): Promise<void> {
	const playerId = args[0] as string;
	await sendAndOutput(ctx, () =>
		ctx.client.delete(`/accounts/${encodeURIComponent(playerId)}/loop`),
	);
}

async function handleLoopUpdate(ctx: CommandContext, args: string[]): Promise<void> {
	const playerId = args[0] as string;
	if (ctx.jsonBody === undefined) {
		ctx.output.usageError(
			"--json or --stdin required. Usage: smctl loop update <playerId> --json '<json>' | --stdin",
		);
		return;
	}
	await sendAndOutput(ctx, () =>
		ctx.client.patch(`/accounts/${encodeURIComponent(playerId)}/loop`, ctx.jsonBody),
	);
}

async function handleCombatMode(ctx: CommandContext, args: string[]): Promise<void> {
	const playerId = args[0] as string;
	const mode = args[1];
	if (mode === undefined) {
		await sendAndOutput(ctx, () =>
			ctx.client.get(`/accounts/${encodeURIComponent(playerId)}/combat-mode`),
		);
		return;
	}
	if (mode !== "flee" && mode !== "external") {
		ctx.output.usageError('mode must be "flee" or "external"');
		return;
	}
	await sendAndOutput(ctx, () =>
		ctx.client.patch(`/accounts/${encodeURIComponent(playerId)}/combat-mode`, { mode }),
	);
}

async function handleAbort(ctx: CommandContext, args: string[]): Promise<void> {
	const playerId = args[0] as string;
	const opts: { body?: unknown; requestTimeoutMs?: number } = {};
	if (ctx.forceMode) {
		opts.body = { force: true };
		opts.requestTimeoutMs = GAME_API_TIMEOUT_MS;
	}
	await sendAndOutput(ctx, () =>
		ctx.client.delete(`/accounts/${encodeURIComponent(playerId)}/abort`, opts),
	);
}

async function handleAccountsRegister(ctx: CommandContext, _args: string[]): Promise<void> {
	if (ctx.jsonBody === undefined) {
		ctx.output.usageError(
			"--json or --stdin required. Usage: smctl accounts register --json '<json>' | --stdin",
		);
	}
	// Registration calls the game API twice (createSession + register).
	await sendAndOutput(ctx, () =>
		ctx.client.post("/accounts/register", ctx.jsonBody, {
			requestTimeoutMs: GAME_API_TIMEOUT_MS,
		}),
	);
}

async function handleGoal(ctx: CommandContext, args: string[]): Promise<void> {
	const playerId = args[0] as string;
	if (ctx.jsonBody === undefined) {
		ctx.output.usageError(
			"--json or --stdin required. Usage: smctl goal <playerId> [--async] --json '<json>' | --stdin",
		);
	}
	if (ctx.asyncMode) {
		const path = `/accounts/${encodeURIComponent(playerId)}/goal/async`;
		await sendAndOutput(ctx, () => ctx.client.post(path, ctx.jsonBody));
	} else {
		// Sync goals block until the goal completes (multi-tick travel, mining runs, etc.).
		const path = `/accounts/${encodeURIComponent(playerId)}/goal`;
		await sendAndOutput(ctx, () =>
			ctx.client.post(path, ctx.jsonBody, { requestTimeoutMs: GAME_API_TIMEOUT_MS }),
		);
	}
}

async function handleJobStatus(ctx: CommandContext, args: string[]): Promise<void> {
	const jobId = args[0] as string;
	await sendAndOutput(ctx, () => ctx.client.get(`/jobs/${encodeURIComponent(jobId)}`));
}

/**
 * Coerce a raw CLI arg value to a number when it looks numeric, matching the
 * old spacemolt CLI's `key=value` parsing behavior. Non-numeric strings pass
 * through unchanged.
 */
function coerceRawValue(value: string): string | number {
	if (value.length > 0 && !Number.isNaN(Number(value))) {
		return Number(value);
	}
	return value;
}

async function handleRaw(ctx: CommandContext, args: string[]): Promise<void> {
	const playerId = args[0] as string;
	const cliArgs = args.slice(1);

	if (cliArgs.length === 0) {
		return ctx.output.usageError("Usage: smctl raw <player> <action> [args...]");
	}

	const action = cliArgs[0] as string;
	const params: Record<string, unknown> = {};
	for (const arg of cliArgs.slice(1)) {
		const eqIndex = arg.indexOf("=");
		if (eqIndex === -1) {
			// Bare positional — the old spacemolt CLI treated this as the target id
			// (e.g. `travel sol_asteroid_belt`).
			params["id"] = coerceRawValue(arg);
		} else {
			const key = arg.slice(0, eqIndex);
			params[key] = coerceRawValue(arg.slice(eqIndex + 1));
		}
	}

	await sendAndOutput(ctx, () =>
		ctx.client.post(
			`/accounts/${encodeURIComponent(playerId)}/raw`,
			{ toolGroup: "spacemolt", action, params },
			{ requestTimeoutMs: GAME_API_TIMEOUT_MS },
		),
	);
}

async function handleLogLevel(ctx: CommandContext, args: string[]): Promise<void> {
	const level = args[0];
	if (level === undefined) {
		// GET current level
		await sendAndOutput(ctx, () => ctx.client.get("/log-level"));
	} else {
		// POST new level
		await sendAndOutput(ctx, () => ctx.client.post("/log-level", { level }));
	}
}

// ── Help Handlers ─────────────────────────────────────────────────

async function handleHelpGeneral(ctx: CommandContext, _args: string[]): Promise<void> {
	ctx.output.raw(getUsageText());
}

async function handleHelpGoals(ctx: CommandContext, _args: string[]): Promise<void> {
	ctx.output.raw(getGoalHelpText());
}

async function handleHelpLoops(ctx: CommandContext, _args: string[]): Promise<void> {
	ctx.output.raw(getLoopHelpText());
}

async function handleHelpMining(ctx: CommandContext, _args: string[]): Promise<void> {
	ctx.output.raw(getMiningHelpText());
}

async function handleHelpTrading(ctx: CommandContext, _args: string[]): Promise<void> {
	ctx.output.raw(getTradingHelpText());
}

async function handleHelpHauling(ctx: CommandContext, _args: string[]): Promise<void> {
	ctx.output.raw(getHaulingHelpText());
}

async function handleHelpStorageTransfer(ctx: CommandContext, _args: string[]): Promise<void> {
	ctx.output.raw(getStorageTransferHelpText());
}

async function handleHelpExploration(ctx: CommandContext, _args: string[]): Promise<void> {
	ctx.output.raw(getExplorationHelpText());
}

async function handleHelpSalvage(ctx: CommandContext, _args: string[]): Promise<void> {
	ctx.output.raw(getSalvageHelpText());
}

async function handleHelpGuard(ctx: CommandContext, _args: string[]): Promise<void> {
	ctx.output.raw(getGuardHelpText());
}

async function handleHelpRoamingSalvage(ctx: CommandContext, _args: string[]): Promise<void> {
	ctx.output.raw(getRoamingSalvageHelpText());
}

async function handleHelpTowSalvage(ctx: CommandContext, _args: string[]): Promise<void> {
	ctx.output.raw(getTowSalvageHelpText());
}

async function handleHelpFuelRescue(ctx: CommandContext, _args: string[]): Promise<void> {
	ctx.output.raw(getFuelRescueHelpText());
}

function getGoalHelpText(): string {
	return [
		'Goal Types — use with: smctl goal <playerId> [--async] --json \'{"type": "<goal>", "options": {...}}\'',
		"  --async: submit in background, returns {job_id}. Poll with: smctl job status <job_id>",
		"",
		"Navigation:",
		"  navigate-to-system    targetSystemId (string), fuelReserve? (number)",
		"                        Does NOT refuel en route — fails before departing if the trip",
		"                        exceeds current fuel. fuelReserve keeps a buffer so the ship",
		"                        arrives with fuel to spare (e.g. for the return trip).",
		"  navigate-via-route    route: string[] (explicit system sequence, no re-planning), fuelReserve? (number)",
		"  go-to-poi             targetPoiId (string)",
		"  dock-at               targetBaseId (string)",
		"  ensure-undocked       (no options)",
		"  ensure-fueled         targetFuel? (number)",
		"  ensure-repaired       (no options)",
		"",
		"Cargo & Market:",
		"  sell-or-deposit-cargo (no options) — sell all cargo, deposit unsold",
		"  ensure-empty-cargo    (no options)",
		"  jettison-cargo        itemId (string), quantity (number)",
		"  load-from-storage     itemId (string), maxQuantity? (number)",
		"  buy-items             items: [{itemId, maxPrice, maxQuantity?}]",
		"  list-cargo-for-sale   items: [{itemId, minPrice}]",
		"  create-buy-order      itemId (string), quantity (number), price (number)",
		"  create-sell-order     itemId (string), quantity (number), price (number)",
		"  cancel-orders         orderIds (string[]) — bulk cancel up to 50 per tick",
		"",
		"Faction Storage:",
		"  deposit-to-faction-storage     itemId (string), quantity (number)",
		"  withdraw-from-faction-storage  itemId (string), quantity? (number)",
		"  load-from-faction-storage      itemId (string), maxQuantity? (number)",
		"  gift-to-player                 targetName, itemId, quantity, message? (string)",
		"",
		"Items:",
		"  use-item              itemId (string)",
		"",
		"Missions:",
		"  accept-mission        missionId (string)",
		"  complete-mission      missionId (string)",
		"  abandon-mission       missionId (string)",
		"",
		"Ship Modules:",
		"  install-mod           moduleId (string)",
		"  uninstall-mod         moduleId (string)",
		"",
		"Scanning:",
		"  scan                  (no options)",
		"",
		"Compound Goals (multi-step sequences):",
		"  prepare-at-station       systemId, poiId, baseId, refuel?, repair?, route?: string[]",
		"  sell-at-station          systemId, stationPoiId, baseId, refuel?",
		"  buy-at-station           systemId, poiId, baseId, items: [{itemId, maxPrice, maxQuantity?}], refuel?",
		"  sell-at-station-priced   systemId, stationPoiId, baseId, items: [{itemId, minPrice}], refuel?",
		"  load-at-station          systemId, poiId, baseId, sourceType, items, refuel?",
		"  unload-at-station        systemId, poiId, baseId, destType, targetPlayer?, items?, refuel?",
		"  mine-until-full          fullThreshold?, maxAttempts?",
		"  mining-run               systemId, beltPoiId, fullThreshold?, maxAttempts?",
		"  enhanced-mining-run      systemId, beltPoiId, junkItemIds: string[], fullThreshold?, maxAttempts?, maxJettisonRounds?",
		"  mine-with-jettison       junkItemIds: string[], fullThreshold?, maxAttempts?, maxJettisonRounds?",
		"  ensure-loadout           systemId, poiId, baseId, modules: string[], ammo?: {weapon_type_id: ammo_item_id}, uninstalledStorage?: (personal|faction|cargo)",
		"  ensure-marketbook        targetOrders [{itemId, side, quantity, price}], priceTolerance? (number), cancelUnmatched? (boolean)",
		"  fuel-rescue              systemId, poiId, targetUsername — travel to POI, confirm player is there, refuel them",
	].join("\n");
}

function getLoopHelpText(): string {
	return [
		'Loop Types — use with: smctl loop start <playerId> --json \'{"type": "<loop>", "options": {...}}\'',
		"",
		"Loops run continuously until stopped or maxIterations reached.",
		"Loop configs persist to disk and auto-resume on daemon restart.",
		"",
		"  mining            Mine ore → sell/deposit at station → repeat",
		"  enhanced-mining   Mine, jettison junk, mine more → sell/deposit → repeat",
		"  salvage           Loot wrecks at a POI → sell/deposit at station → repeat",
		"  roaming-salvage   Sweep empire systems for wrecks → deposit when full → repeat",
		"  tow-salvage       Tow wrecks to a yard, loot to storage, then scrap/sell the husks",
		"  trading           Buy under max price → sell at min price → repeat",
		"  hauling           Load at source → unload at destination → repeat",
		"  storage-transfer  Transfer all personal storage items to faction storage → stop when empty",
		"  exploration       Visit unvisited systems for faction map intel → stop when all visited",
		"  guard             Patrol a POI, attack pirates on sight, return home to repair → repeat",
		"",
		"To stop a loop:    smctl loop stop <playerId>",
		"To update options: smctl loop update <playerId> --json '{\"junkItemIds\":[...]}'",
		"To check status:   smctl abort <playerId>",
		"To stop all work: smctl abort <playerId> --force",
		"",
		"Run 'smctl help <type>' for detailed schemas and examples:",
		"  smctl help mining",
		"  smctl help salvage",
		"  smctl help roaming-salvage",
		"  smctl help tow-salvage",
		"  smctl help trading",
		"  smctl help hauling",
		"  smctl help storage-transfer",
		"  smctl help exploration",
		"  smctl help guard",
	].join("\n");
}

function getMiningHelpText(): string {
	return [
		"Mining / Enhanced-Mining Loop",
		"",
		"Mines ore until cargo is full, then travels to a station to sell or deposit,",
		"then returns to the belt and repeats. Enhanced-mining adds a jettison pass to",
		"discard low-value items and mine again before heading to station.",
		"",
		"Required options (both loop types):",
		"  miningSystemId      System containing the asteroid belt (string)",
		"  beltPoiId           POI ID of the asteroid belt (string)",
		"  sellSystemId        System containing the sell/deposit station (string)",
		"  sellStationPoiId    POI ID of the station (string)",
		"  sellBaseId          Base ID to dock at (string)",
		"",
		"Enhanced-mining only:",
		"  junkItemIds         Item IDs to jettison before re-mining (string[], required)",
		"  maxJettisonRounds   Max jettison passes per iteration (number, default: 3)",
		"",
		"Cargo / mining tuning:",
		"  fullThreshold       Fraction of cargo capacity to consider 'full' (0-1, default: 0.95)",
		"  maxAttempts         Max mine attempts per fill (number, default: 50)",
		"",
		"What to do with cargo at the station:",
		"  repair              Repair ship hull at the sell station each iteration (boolean, default: false)",
		'  depositTarget       Where unsold cargo goes: "personal" | "faction" (default: sell only)',
		"                      Items with active buy orders are always sold first.",
		"                      Items with no buyer are deposited to the specified storage.",
		"                      Omit to jettison unsold items instead of depositing.",
		"  skipMarket          Skip market check and deposit all cargo without selling (boolean, default: false).",
		"                      Use with depositTarget to route all cargo to storage each run.",
		"                      Useful when you want to accumulate items rather than sell them.",
		"  listPrice           List all cargo at this price per unit instead of depositing (number, optional).",
		"                      Any existing buy orders at or above this price fill immediately.",
		"                      Remaining quantity is listed on the market at this price.",
		"                      Use to keep a station market supplied with a minimum price floor.",
		"  listPrices          Per-item sell prices as {item_id: price} (object, optional).",
		"                      Overrides listPrice for specific items. Items not listed fall back",
		"                      to listPrice, then to the normal sell-or-deposit logic.",
		'                      Example: {"iron_ore":50,"copper_ore":30}',
		"",
		"Credits for refueling:",
		'  cashSource          Set to "faction" to withdraw credits from the faction treasury',
		"                      if credits are below minCredits before buying fuel.",
		"  minCredits          Credit balance threshold (number, default: 1000).",
		"                      Only used when cashSource is set.",
		"",
		"Depleted resource handling:",
		"  retryOnDepleted     Retry indefinitely when resources are depleted (boolean, optional).",
		"                      When true, 'Resources depleted' failures are not counted toward",
		"                      the consecutive failure limit. The loop waits 30s between retries,",
		"                      allowing regenerating resources to replenish.",
		"",
		"Loop control:",
		"  maxIterations       Stop after N completed iterations (number, optional)",
		"",
		"Examples:",
		'  smctl loop start <id> --json \'{"type":"mining","options":{',
		'    "miningSystemId":"sol","beltPoiId":"belt-1",',
		'    "sellSystemId":"sol","sellStationPoiId":"station-1","sellBaseId":"base-1"}}\'',
		"",
		"  # Deposit ALL cargo to faction storage without selling (skipMarket mode)",
		'  smctl loop start <id> --json \'{"type":"mining","options":{',
		'    "miningSystemId":"sol","beltPoiId":"belt-1",',
		'    "sellSystemId":"sol","sellStationPoiId":"station-1","sellBaseId":"base-1",',
		'    "depositTarget":"faction","skipMarket":true}}\'',
		"",
		"  # Deposit unsold ore to faction storage, refuel using faction credits",
		'  smctl loop start <id> --json \'{"type":"mining","options":{',
		'    "miningSystemId":"sol","beltPoiId":"belt-1",',
		'    "sellSystemId":"sol","sellStationPoiId":"station-1","sellBaseId":"base-1",',
		'    "depositTarget":"faction","cashSource":"faction","minCredits":2000}}\'',
		"",
		"  # List all ore at 150cr/unit (fills existing orders above 150, lists the rest)",
		'  smctl loop start <id> --json \'{"type":"mining","options":{',
		'    "miningSystemId":"sol","beltPoiId":"belt-1",',
		'    "sellSystemId":"sol","sellStationPoiId":"station-1","sellBaseId":"base-1",',
		'    "listPrice":150}}\'',
		"",
		"  # Enhanced mining with junk jettison",
		'  smctl loop start <id> --json \'{"type":"enhanced-mining","options":{',
		'    "miningSystemId":"sol","beltPoiId":"belt-1",',
		'    "sellSystemId":"sol","sellStationPoiId":"station-1","sellBaseId":"base-1",',
		'    "junkItemIds":["stone","gravel"]}}\'',
	].join("\n");
}

function getTradingHelpText(): string {
	return [
		"Trading Loop",
		"",
		"Buys items at one station under max prices, travels to another station,",
		"lists cargo for sale at min prices, then repeats.",
		"",
		"Options:",
		"  buyStation.systemId      System to buy in (string, required)",
		"  buyStation.poiId         Station POI (string, required)",
		"  buyStation.baseId        Base to dock at (string, required)",
		"  sellStation.systemId     System to sell in (string, required)",
		"  sellStation.stationPoiId Station POI (string, required)",
		"  sellStation.baseId       Base to dock at (string, required)",
		"  items[].itemId           Item to trade (string, required)",
		"  items[].maxBuyPrice      Max price to buy at (number, required)",
		"  items[].minSellPrice     Min price to sell at (number, required)",
		"  items[].maxQuantity      Max quantity per trip (number, optional)",
		"  refuel                   Refuel at each station (boolean, default: true)",
		"  minFuelReserve           Fuel buffer beyond each leg's estimated cost (number, default: 0)",
		"                           A leg fails before departing unless the ship would arrive with",
		"                           at least this much fuel to spare. Guards against stranding when",
		"                           the next station is far — navigation never refuels en route.",
		"  maxIterations            Stop after N iterations (number, optional)",
		"",
		"Example:",
		"  smctl loop start <playerId> --json '{",
		'    "type": "trading",',
		'    "options": {',
		'      "buyStation": { "systemId": "alpha", "poiId": "alpha-station", "baseId": "alpha-base" },',
		'      "sellStation": { "systemId": "beta", "stationPoiId": "beta-station", "baseId": "beta-base" },',
		'      "items": [',
		'        { "itemId": "copper_ore", "maxBuyPrice": 8, "minSellPrice": 15 },',
		'        { "itemId": "iron_ore", "maxBuyPrice": 5, "minSellPrice": 12, "maxQuantity": 50 }',
		"      ],",
		'      "refuel": true,',
		'      "maxIterations": 100',
		"    }",
		"  }'",
	].join("\n");
}

function getHaulingHelpText(): string {
	return [
		"Hauling Loop",
		"",
		"Loads items from a source station, transports to a destination,",
		"unloads, then repeats. Supports multiple source/destination types.",
		"",
		"Source types:  personal-storage, faction-storage, market",
		"Dest types:    personal-storage, faction-storage, gift, market",
		"",
		"Source options:",
		"  source.systemId          System (string, required)",
		"  source.poiId             Station POI (string, required)",
		"  source.baseId            Base (string, required)",
		"  source.type              Source type (string, required)",
		"  source.items[].itemId    Item to load (string, required)",
		"  source.items[].quantity  Max quantity (number, optional)",
		"  source.items[].maxPrice  Max buy price for market source (number, optional)",
		"",
		"Destination options:",
		"  destination.systemId           System (string, required)",
		"  destination.poiId              Station POI (string, required)",
		"  destination.baseId             Base (string, required)",
		"  destination.type               Dest type (string, required)",
		"  destination.targetPlayer       Target for gift type (string, required if gift)",
		"  destination.items[].itemId     Item to sell (string, for market type)",
		"  destination.items[].minPrice   Min sell price (number, for market type)",
		"  refuel                         Refuel at each station (boolean, default: true)",
		"  minFuelReserve                 Fuel buffer beyond each leg's estimated cost (number, default: 0)",
		"                                 A leg fails before departing unless the ship would arrive with",
		"                                 at least this much fuel to spare. Navigation never refuels en route.",
		"  maxIterations                  Stop after N iterations (number, optional)",
		"",
		"Example — storage to faction storage:",
		"  smctl loop start <playerId> --json '{",
		'    "type": "hauling",',
		'    "options": {',
		'      "source": {',
		'        "systemId": "sol", "poiId": "sol-station", "baseId": "sol-base",',
		'        "type": "personal-storage",',
		'        "items": [{ "itemId": "iron_bar", "quantity": 50 }]',
		"      },",
		'      "destination": {',
		'        "systemId": "alpha", "poiId": "alpha-station", "baseId": "alpha-base",',
		'        "type": "faction-storage"',
		"      },",
		'      "refuel": true',
		"    }",
		"  }'",
		"",
		"Example — market buy to gift:",
		"  smctl loop start <playerId> --json '{",
		'    "type": "hauling",',
		'    "options": {',
		'      "source": {',
		'        "systemId": "sol", "poiId": "sol-station", "baseId": "sol-base",',
		'        "type": "market",',
		'        "items": [{ "itemId": "fuel_cell", "maxPrice": 20, "quantity": 10 }]',
		"      },",
		'      "destination": {',
		'        "systemId": "sol", "poiId": "sol-station", "baseId": "sol-base",',
		'        "type": "gift",',
		'        "targetPlayer": "FriendName"',
		"      }",
		"    }",
		"  }'",
	].join("\n");
}

function getStorageTransferHelpText(): string {
	return [
		"Storage-Transfer Loop",
		"",
		"Docks at a station, transfers all personal storage items to faction storage,",
		"then repeats. The loop terminates automatically when personal storage is empty.",
		"",
		"Credits in personal storage are also transferred by default (withdraw to wallet,",
		"then deposit to faction storage).",
		"",
		"Options:",
		"  systemId        System containing the station (string, required)",
		"  stationPoiId    POI ID of the station (string, required)",
		"  baseId          Base ID to dock at (string, required)",
		"  refuel          Refuel after docking (boolean, default: false)",
		"                  Uses faction storage credits to fund refueling if needed.",
		"  excludeCredits  Skip transferring credits to faction storage (boolean, default: false)",
		"  maxIterations   Stop after N iterations (number, optional)",
		"",
		"Example:",
		'  smctl loop start <id> --json \'{"type":"storage-transfer","options":{',
		'    "systemId":"sol","stationPoiId":"sol-station","baseId":"sol-base"}}\'',
		"",
		"  # With refueling enabled, skipping credits",
		'  smctl loop start <id> --json \'{"type":"storage-transfer","options":{',
		'    "systemId":"sol","stationPoiId":"sol-station","baseId":"sol-base",',
		'    "refuel":true,"excludeCredits":true}}\'',
	].join("\n");
}

function getExplorationHelpText(): string {
	return [
		"Exploration Loop",
		"",
		"Navigates to unvisited systems to contribute map intel to the faction.",
		"Uses BFS to find the nearest unvisited system each iteration.",
		"Returns to the home station to refuel and repair when needed.",
		"The loop terminates when all qualifying systems have been visited.",
		"",
		"Requires the faction to have a Level 2 Intel Center. At Level 2, the game",
		"automatically records map data whenever a faction member visits a system.",
		"",
		"Options:",
		"  systemId          Home system ID (string, required)",
		"  stationPoiId      Home station POI ID (string, required)",
		"  baseId            Home base ID to dock at (string, required)",
		"  allowLawless        Also explore lawless space (boolean, default: false)",
		"                      By default, only systems in the home empire are explored.",
		"  minFuelReserve      Fuel buffer beyond round-trip cost (number, default: 10)",
		"                      Returns home when fuel < round-trip cost + reserve.",
		"  repairThreshold     Return home if hull ratio drops below this (number 0-1, default: 0.5)",
		"  survey              Call survey_system after arriving in each new system (boolean, default: false)",
		"                      Requires a scanner module. Reveals hidden POIs and resource data.",
		"  minSubmittedAtTick  Re-explore systems with intel older than this game tick (number, optional)",
		"                      Intel entries with submitted_at_tick < this value are treated as unvisited.",
		"                      Use to do a second pass for updated resource data or newly-added systems.",
		"                      Get the current tick from: smctl state <id> player",
		"  maxIterations       Stop after N iterations (number, optional)",
		"",
		"Example:",
		'  smctl loop start <id> --json \'{"type":"exploration","options":{',
		'    "systemId":"sol","stationPoiId":"sol-station","baseId":"sol-base"}}\'',
		"",
		"  # Survey each system and re-explore intel older than tick 50000",
		'  smctl loop start <id> --json \'{"type":"exploration","options":{',
		'    "systemId":"sol","stationPoiId":"sol-station","baseId":"sol-base",',
		'    "survey":true,"minSubmittedAtTick":50000}}\'',
	].join("\n");
}

function getSalvageHelpText(): string {
	return [
		"Salvage Loop",
		"",
		"Travels to a salvage site, loots cargo from all available wrecks until cargo is full",
		"(or all wrecks are exhausted), then returns to a station to sell or deposit the loot.",
		"Repeats continuously to pick up newly created wrecks (e.g. from jettisoned goods).",
		"",
		"Options:",
		"  salvageSystemId   System containing the salvage site (string, required)",
		"  salvagePoiId      POI ID of the salvage site where wrecks appear (string, required)",
		"  sellSystemId      System containing the sell station (string, required)",
		"  sellStationPoiId  POI ID of the sell station (string, required)",
		"  sellBaseId        Base ID to dock at for selling (string, required)",
		"  fullThreshold     Cargo fill fraction to stop looting (number 0-1, default: 1.0)",
		"  maxAttempts       Max loot calls per run (number, default: 200)",
		"  repair            Repair ship hull at sell station each iteration (boolean, default: false)",
		"  depositTarget     Where to deposit unsold items: personal|faction (default: personal)",
		"  skipMarket        Deposit all cargo without selling (boolean, default: false)",
		'  cashSource        Set to "faction" to withdraw credits from faction treasury if low (string, optional)',
		"  minCredits        Min credit balance before withdrawing from faction (number, optional)",
		"  maxIterations     Stop after N iterations (number, optional)",
		"",
		"Example:",
		'  smctl loop start <id> --json \'{"type":"salvage","options":{',
		'    "salvageSystemId":"sol","salvagePoiId":"belt-1",',
		'    "sellSystemId":"sol","sellStationPoiId":"sol-station","sellBaseId":"sol-base"}}\'',
		"",
		"  # Deposit to faction storage instead of selling",
		'  smctl loop start <id> --json \'{"type":"salvage","options":{',
		'    "salvageSystemId":"sol","salvagePoiId":"belt-1",',
		'    "sellSystemId":"sol","sellStationPoiId":"sol-station","sellBaseId":"sol-base",',
		'    "depositTarget":"faction"}}\'',
	].join("\n");
}

function getFuelRescueHelpText(): string {
	return [
		"Fuel Rescue Goal",
		"",
		"Travels to a POI, confirms the target player is present via get_nearby,",
		"then delivers fuel to them. Fails immediately if the target is not found.",
		"",
		"Options:",
		"  systemId        System containing the rescue POI (string, required)",
		"  poiId           POI ID where the stranded player should be (string, required)",
		"  targetUsername  Username of the player to rescue (string, required)",
		"",
		"Example:",
		"  smctl goal <rescuerId> --json '{",
		'    "type": "fuel-rescue",',
		'    "options": {',
		'      "systemId": "sol",',
		'      "poiId": "sol-belt-1",',
		'      "targetUsername": "StrandedPilot"',
		"    }",
		"  }'",
	].join("\n");
}

function getGuardHelpText(): string {
	return [
		"Guard Loop",
		"",
		"Patrols a target POI and attacks any pirates found. The ship stays on patrol",
		"and only returns home to repair and refuel when hull drops below repairThreshold.",
		"",
		"Each iteration: (if hull < threshold → go home, repair, refuel) →",
		"travel to guard POI (no-op if already there) → attack all pirates until",
		"area is clear → repeat.",
		"",
		"If the ship is destroyed during combat, the loop fails immediately.",
		"",
		"Options:",
		"  homeSystemId       System containing the home base (string, required)",
		"  homeStationPoiId   POI ID of the home station (string, required)",
		"  homeBaseId         Base ID to dock at for refueling and repair (string, required)",
		"  guardSystemId      System containing the POI to guard (string, required)",
		"  guardPoiId         POI ID to patrol for pirates (string, required)",
		'  cashSource         Set to "faction" to withdraw credits from faction treasury if low (string, optional)',
		"  minCredits         Min credit balance before withdrawing from faction (number, optional)",
		"  repairThreshold    Return home to repair below this hull % (number, default: 100)",
		"  maxIterations      Stop after N iterations (number, optional)",
		"",
		"Example:",
		'  smctl loop start <id> --json \'{"type":"guard","options":{',
		'    "homeSystemId":"sol","homeStationPoiId":"sol-station","homeBaseId":"sol-base",',
		'    "guardSystemId":"sol","guardPoiId":"belt-1"}}\'',
		"",
		"  # Guard in a different system with faction credit source",
		'  smctl loop start <id> --json \'{"type":"guard","options":{',
		'    "homeSystemId":"sol","homeStationPoiId":"sol-station","homeBaseId":"sol-base",',
		'    "guardSystemId":"proxima","guardPoiId":"proxima-belt",',
		'    "cashSource":"faction"}}\'',
	].join("\n");
}

function getRoamingSalvageHelpText(): string {
	return [
		"Roaming Salvage Loop",
		"",
		"Sweeps through all systems in the home empire using BFS, visiting every POI",
		"in each system to loot wrecks. Returns home to deposit cargo when full or fuel",
		"is running low. When all qualifying systems are visited, restarts the sweep.",
		"",
		"Station POIs (has_base) are skipped — wrecks do not spawn at stations.",
		"The loop resumes where it left off after a return-home trip (remaining POIs in",
		"the current system are preserved across the round trip).",
		"",
		"Required options:",
		"  homeSystemId        System containing the home deposit station (string)",
		"  homeStationPoiId    POI ID of the home station (string)",
		"  homeBaseId          Base ID to dock at for deposits (string)",
		"",
		"Optional options:",
		"  allowLawless        Also visit lawless systems (boolean, default: false)",
		"  fullThreshold       Cargo fill fraction to trigger return home (number 0-1, default: 1.0)",
		"  minFuelReserve      Fuel buffer beyond estimated return cost (number, default: 10)",
		"  repair              Repair hull when returning home (boolean, default: true)",
		"  depositTarget       Where to deposit cargo: personal|faction (default: personal)",
		'  cashSource          Set to "faction" to withdraw credits from faction treasury if low (string, optional)',
		"  minCredits          Min credit balance before withdrawing from faction (number, optional)",
		"  maxLootAttempts     Max loot calls per POI visit (number, optional, default: 200)",
		"  maxIterations       Stop after N completed iterations (number, optional)",
		"",
		"Example:",
		'  smctl loop start <id> --json \'{"type":"roaming-salvage","options":{',
		'    "homeSystemId":"sol","homeStationPoiId":"sol-station","homeBaseId":"sol-base"}}\'',
		"",
		"  # Deposit to faction storage and visit lawless systems too",
		'  smctl loop start <id> --json \'{"type":"roaming-salvage","options":{',
		'    "homeSystemId":"sol","homeStationPoiId":"sol-station","homeBaseId":"sol-base",',
		'    "depositTarget":"faction","allowLawless":true}}\'',
	].join("\n");
}

function getTowSalvageHelpText(): string {
	return [
		"Tow-Salvage Loop",
		"",
		"Tows wrecks from a wreck field to a salvage yard, drains each wreck's cargo to",
		"storage, then scraps or sells the empty hulk. Repeats until no wrecks remain",
		"(fixed mode) or until stopped.",
		"",
		"Requires a tow rig module and (for scrap disposition) the scrap skill.",
		"The loop halts permanently if either permanent precondition is unmet.",
		"",
		"Required options:",
		"  mode            Wreck-finding strategy: fixed (string, required)",
		"                  fixed — tow from a specific wreck field POI",
		"  disposition     What to do with the empty husk: scrap | sell (string, required)",
		"  yardSystemId    System containing the salvage yard (string, required)",
		"  yardPoiId       POI ID of the salvage yard (string, required)",
		"  yardBaseId      Base ID to dock at in the yard (string, required)",
		"  wreckSystemId   System containing the wreck field (string, required)",
		"  wreckPoiId      POI ID of the wreck field (string, required)",
		"",
		"Optional options:",
		'  storageTarget   Where to deposit looted cargo: "personal" | "faction" (default: personal)',
		"  maxIterations   Stop after N completed wrecks (number, optional)",
		"",
		"Example (scrap husks, deposit loot to personal storage):",
		'  smctl loop start <id> --json \'{"type":"tow-salvage","options":{',
		'    "mode":"fixed","disposition":"scrap",',
		'    "yardSystemId":"sol","yardPoiId":"yard-poi","yardBaseId":"yard-base",',
		'    "wreckSystemId":"sol","wreckPoiId":"belt-1"}}\'',
		"",
		"  # Sell husks, deposit loot to faction storage",
		'  smctl loop start <id> --json \'{"type":"tow-salvage","options":{',
		'    "mode":"fixed","disposition":"sell",',
		'    "yardSystemId":"sol","yardPoiId":"yard-poi","yardBaseId":"yard-base",',
		'    "wreckSystemId":"sol","wreckPoiId":"belt-1",',
		'    "storageTarget":"faction"}}\'',
	].join("\n");
}
