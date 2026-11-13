import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	CombatEnvelope,
	CombatNotificationType,
	CraftingUpdateEvent,
	MarketUpdateEnvelope,
	MarketUpdateEvent,
	ObservationUpdateEnvelope,
	ObservationUpdateEvent,
	PirateRadioEnvelope,
	PirateRadioEvent,
} from "@setpoint/protocol";
import {
	type GameState,
	type NotificationPayloads,
	STATE_SECTIONS,
	SpacemoltClient,
	type StateSection,
} from "@spacemolt/lib";
import { GameCallGate } from "./accounts/game-call-gate.js";
import { parseLibConfig } from "./accounts/lib-config.js";
import { LibAccountManager } from "./accounts/lib-manager.js";
import { type LibManagedAccount, playerId as playerIdOf } from "./accounts/lib-types.js";
import { withAccountLogging } from "./accounts/log-subject.js";
import { CombatHeartbeatStore } from "./combat/combat-heartbeat.js";
import { CombatModeStore } from "./combat/combat-mode-store.js";
import { CombatReactor } from "./combat/combat-reactor.js";
import { HazardModeStore } from "./combat/hazard-mode-store.js";
import { HazardReactor } from "./combat/hazard-reactor.js";
import { makeLibGoalContext } from "./dispatcher/lib-goal-context.js";
import {
	bindWithRetry,
	findIncumbent,
	readRelease,
	startStandbyControl,
	takeOverFrom,
} from "./lifecycle/handover.js";
import { Lifecycle } from "./lifecycle/lifecycle.js";
import type { ExecutingGoalEntry } from "./server/account-release.js";
import { createGoal } from "./server/goal-registry.js";
import { startServer } from "./server/index.js";
import type { JobManager } from "./server/job-manager.js";
import { startJobPruner } from "./server/job-pruner.js";
import { LoopManager } from "./server/loop-manager.js";
import { makeProjectingOnStateChange } from "./state/attach-projector.js";
import { CraftingEventsStore } from "./state/crafting-events-store.js";
import { createDatabase } from "./state/database.js";
import { logDrift } from "./state/drift-logger.js";
import { type DriftSweep, startDriftSweep } from "./state/drift-sweep.js";
import { createEventBuffer } from "./state/event-buffer.js";
import { MarketSubscriptionKeeper } from "./state/market-subscription.js";
import { ObservationSubscriptionKeeper } from "./state/observation-subscription.js";
import { StateProjector } from "./state/projector.js";
import { diffGameState } from "./state/state-diff.js";
import { StateStore } from "./state/store.js";
import { errorMessage } from "./util/errors.js";
import { type LogLevel, createLogger, enableFileLogging, setLogLevel } from "./util/logger.js";
import { installCrashSafetyHandlers } from "./util/process-safety.js";

const VALID_LOG_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);
const envLogLevel = process.env["SM_LOG_LEVEL"];
if (envLogLevel && VALID_LOG_LEVELS.has(envLogLevel)) {
	setLogLevel(envLogLevel as LogLevel);
}

const log = createLogger("main");

/**
 * Where the daemon keeps its state: `config/`, `data/` and `logs/`.
 *
 * Defaults to the checkout the code runs from. Set `SETPOINT_HOME` to run the
 * code from one directory and keep state in another — a deploy runs each
 * release from its own checkout while every release shares one home, so the
 * database, loop configs and the `daemon.log` that monitors watch stay put
 * across releases and through a handover between two of them.
 */
const SETPOINT_HOME = process.env["SETPOINT_HOME"] || join(import.meta.dir, "..");
const CONFIG_DIR = join(SETPOINT_HOME, "config");
const DB_PATH = join(SETPOINT_HOME, "data", "dispatcher.db");
const LOG_PATH = join(SETPOINT_HOME, "logs", "daemon.log");
const API_PORT = Number(process.env["SM_PORT"]) || 7580;

/** Read config/dispatcher.json, returning `{}` if it is missing or unreadable. */
async function readDispatcherConfig(): Promise<unknown> {
	try {
		return JSON.parse(await readFile(join(CONFIG_DIR, "dispatcher.json"), "utf-8"));
	} catch {
		return {};
	}
}

async function main(): Promise<void> {
	log.info("setpoint starting...");

	// Is another setpoint already serving? If so this process is its successor:
	// it connects every account in standby while the incumbent keeps working,
	// then asks it to hand over. See lifecycle/handover.ts.
	const lifecycle = new Lifecycle(readRelease(import.meta.dir));
	const incumbent = await findIncumbent(API_PORT);

	// Load config: Clerk API key (env wins) + optional owned-player filter.
	log.info(`Loading config from ${CONFIG_DIR}`);
	const libConfig = parseLibConfig(process.env, await readDispatcherConfig());

	// Initialize database and state
	const db = createDatabase(DB_PATH);
	const store = new StateStore(db);
	const projector = new StateProjector(store);

	// Keeps an observation watch alive for accounts with a live event-stream
	// subscriber. Declared before onStateChange, which re-establishes a watch the
	// server dropped on a move.
	const observationSubscriptions = new ObservationSubscriptionKeeper();
	// The same for market subscriptions, which the server drops on every undock.
	const marketSubscriptions = new MarketSubscriptionKeeper();

	// Project every lib state change into SQLite, then log the changed sections.
	const projectOnChange = makeProjectingOnStateChange(projector);
	const onStateChange = (
		playerId: string,
		changed: StateSection[],
		account: LibManagedAccount,
	): void => {
		// In standby the incumbent still owns the mirror and the log; writing both
		// from two processes for the length of the overlap only doubles them.
		if (lifecycle.phase === "standby") return;
		projectOnChange(playerId, changed, account);
		// A move silently voids the account's observation watch server-side. Only
		// accounts with a live event-stream subscriber are affected; the keeper
		// returns immediately for everyone else.
		if (changed.includes("location")) {
			observationSubscriptions.resubscribeIfDropped(playerId, account);
			marketSubscriptions.resubscribeIfDropped(playerId, account);
		}
		log.info(`[${playerId}] State updated: ${changed.join(", ")}`);
	};

	// Log server-side state drift a refresh() reveals that no push notification
	// already applied — diagnostic data for deciding which lib notification
	// types need wiring. See state/state-diff.ts and state/drift-logger.ts.
	const onDrift = (
		playerId: string,
		before: Readonly<GameState>,
		after: Readonly<GameState>,
		account: LibManagedAccount,
	): void => {
		logDrift({ playerId, username: account.id, drifts: diffGameState(before, after) });
	};

	// Buffers crafting_update pushes per account for GET /accounts/:id/crafting/events (SSE).
	const craftingEventsStore = new CraftingEventsStore();
	const onCraftingUpdate = (playerId: string, event: CraftingUpdateEvent): void => {
		craftingEventsStore.record(playerId, event);
	};

	// Buffers pirate_radio pushes per account for
	// GET /accounts/:id/pirate-radio/events (SSE). Like crafting, the server
	// sends these unprompted, so there is no subscription side to manage.
	const pirateRadioStore = createEventBuffer<PirateRadioEnvelope>();
	const onPirateRadio = (playerId: string, event: PirateRadioEvent): void => {
		pirateRadioStore.record(playerId, { receivedAt: new Date().toISOString(), event });
	};

	// Buffers observation_update pushes per account for
	// GET /accounts/:id/observation/events (SSE). Unlike the two above, the
	// server only sends these while a watch is subscribed, so the keeper
	// establishes one when a stream opens and re-establishes it after each move.
	// Buffers market_update pushes per account for
	// GET /accounts/:id/market/events (SSE), serialized once on receipt.
	// A push can carry a whole station's book — up to ~19KB of JSON — so
	// these are stored as the JSON the stream sends rather than as object
	// graphs several times that size, and the backlog keeps the default 50.
	// It was 500 at first: by 2026-10-25 that held 280MB of JSON across 36
	// accounts and was most of the daemon's 720MB resident memory.
	const marketEventsStore = createEventBuffer<string>();
	const onMarketUpdate = (playerId: string, event: MarketUpdateEvent): void => {
		const envelope: MarketUpdateEnvelope = { receivedAt: new Date().toISOString(), event };
		marketEventsStore.record(playerId, JSON.stringify(envelope));
	};

	const observationEventsStore = createEventBuffer<ObservationUpdateEnvelope>();
	const onObservationUpdate = (playerId: string, event: ObservationUpdateEvent): void => {
		observationEventsStore.record(playerId, { receivedAt: new Date().toISOString(), event });
	};

	// Per-account combat-response override (flee vs. externally-driven combat
	// logic) — loaded before the reactor and server both need it.
	const combatModeStore = await CombatModeStore.load(CONFIG_DIR);
	// Per-account response to POI hazards (game v0.687.0). See
	// combat/hazard-reactor.ts; built late, like the combat reactor.
	const hazardModeStore = await HazardModeStore.load(CONFIG_DIR);
	const hazardRef: { current: HazardReactor | undefined } = { current: undefined };
	// In memory only: a heartbeat asserts a driver process is alive right now,
	// so a value surviving a restart would be a lie about one that isn't.
	const combatHeartbeats = new CombatHeartbeatStore();

	// Combat detection (src/combat/) needs executingGoals/claimedAccounts —
	// otherwise built privately inside startServer() — and loopManager/
	// jobManager, which don't exist until startServer() returns. Constructed
	// here, up front, and shared into both startServer() and the CombatReactor
	// built just below it, rather than each building its own copy.
	const executingGoals: Map<string, ExecutingGoalEntry> = new Map();
	const claimedAccounts = new Set<string>();
	const combatEventsStore = createEventBuffer<CombatEnvelope>();

	// Late-bound: CombatReactor can't be constructed until after startServer()
	// returns (it needs loopManager/jobManager), but LibAccountManager's
	// onCombatUpdate callback must be registered before that — same ordering
	// already established for onStateChange/onCraftingUpdate above. Safe
	// because onCombatUpdate only ever *fires* during manager.connect(), which
	// runs after both startServer() and the reactorRef assignment below
	// complete. A mutable ref object (rather than a reassigned `let`) so
	// `onCombatUpdate`'s captured binding stays a plain `const`.
	const reactorRef: { current: CombatReactor | undefined } = { current: undefined };
	const onCombatUpdate = (
		playerId: string,
		type: CombatNotificationType,
		payload: NotificationPayloads[CombatNotificationType],
	): void => {
		reactorRef.current?.handle(playerId, type, payload);
	};

	// Create the lib client and account manager.
	//
	// connectRetry: a routine, recurring game-server restart or transient
	// network blip must not permanently strand an account — confirmed live on
	// 2026-07-14, when 5 accounts all dropped with an abnormal-closure (code
	// 1006) within the same ~30-minute window and were abandoned under the
	// lib's then-default of 8 retries (~8 minutes worst case), requiring a
	// manual reconnect. Set to a large-but-bounded budget (~3+ hours worst
	// case at the 60s backoff cap) rather than Number.POSITIVE_INFINITY (the
	// lib's own default as of @spacemolt/lib 7.x) — SpacemoltClient's remove()
	// doesn't cancel an in-flight reconnect retry for that id, so an account
	// removed in the narrow window it's actively retrying would keep retrying
	// in the background; a large bound self-resolves that instead of running
	// forever. Terminal closes (session_replaced, auth_timeout) are unaffected
	// — the client never retries those regardless of this budget.
	const client = new SpacemoltClient({
		clerkApiKey: libConfig.clerkApiKey,
		connectRetry: { maxRetries: 200, baseDelayMs: 2000, maxDelayMs: 60_000 },
	});
	// Holds game calls while the game has said to stop: an account
	// rate-limited, or the whole IP blocked. See accounts/game-call-gate.ts.
	const gameCallGate = new GameCallGate();
	const manager = new LibAccountManager(client, libConfig, {
		onStateChange,
		onDrift,
		onCraftingUpdate,
		onCombatUpdate,
		onPirateRadio,
		onObservationUpdate,
		onMarketUpdate,
		gate: gameCallGate,
		onHazardWarning: (playerId, warning) => hazardRef.current?.handle(playerId, warning),
	});

	// Periodically force a refresh() across the whole fleet so idle accounts
	// (no goals/loops running) still get checked for drift, not just ones that
	// happen to trigger an opportunistic refresh. Started on activation: a
	// standby successor must not double the incumbent's traffic.
	let driftSweep: DriftSweep | undefined;
	let jobPruner: { stop: () => void } | undefined;
	let server: ReturnType<typeof startServer> | undefined;
	let standbyControl: ReturnType<typeof Bun.serve> | undefined;

	/**
	 * Take over serving: bind the API port, recover jobs the previous process
	 * left running, and start the reactors, pruner and drift sweep. Everything
	 * here must run after any incumbent is gone — `startServer` builds the job
	 * manager, whose orphaned-job sweep would otherwise fail the incumbent's
	 * live jobs.
	 */
	const activate = async (): Promise<NonNullable<typeof server>> => {
		// Late-bound through reactorRef: the reactor cannot exist until the
		// server has produced the loop and job managers it depends on.
		const started = await bindWithRetry(() =>
			startServer({
				combatHeartbeats,
				isInCombat: (playerId: string) => reactorRef.current?.isInCombat(playerId) ?? false,
				port: API_PORT,
				manager,
				store,
				db,
				client,
				configDir: CONFIG_DIR,
				craftingEventsStore,
				combatEventsStore,
				pirateRadioStore,
				observationEventsStore,
				observationSubscriptions,
				marketEventsStore,
				marketSubscriptions,
				gameCallGate,
				hazardModeStore,
				combatModeStore,
				executingGoals,
				claimedAccounts,
				lifecycle,
			}),
		);
		server = started;
		log.info(`Dispatcher running on port ${started.port}. Press Ctrl+C to stop.`);

		// Bound job history: finished jobs past the retention window are deleted
		// in the background. See server/job-pruner.ts.
		jobPruner = startJobPruner(started.jobManager);
		driftSweep = startDriftSweep(manager);

		hazardRef.current = new HazardReactor({
			manager,
			loopManager: started.loopManager,
			jobManager: started.jobManager,
			executingGoals,
			configDir: CONFIG_DIR,
			combatEventsStore,
			hazardModeStore,
			isInCombat: (playerId: string) => reactorRef.current?.isInCombat(playerId) ?? false,
		});

		reactorRef.current = new CombatReactor({
			manager,
			loopManager: started.loopManager,
			jobManager: started.jobManager,
			executingGoals,
			configDir: CONFIG_DIR,
			combatEventsStore,
			combatModeStore,
			heartbeats: combatHeartbeats,
		});

		// A handover hands over: when a successor asks, stop and exit.
		lifecycle.onHandoverRequested(() => void shutdown({ handover: true }));
		return started;
	};

	// Graceful shutdown: stop loops and let in-flight HTTP requests drain
	// (bounded — see stopServerWithGracePeriod) BEFORE disconnecting accounts,
	// so a sync goal mid-request doesn't have its account's socket pulled out
	// from under it while still trying to finish normally.
	let shuttingDown = false;
	const shutdown = async ({ handover = false }: { handover?: boolean } = {}): Promise<void> => {
		// A second SIGINT/SIGTERM while the first shutdown is still draining must
		// not call server.stop() again — verified live that calling it while an
		// earlier unresolved call is pending never resolves (see
		// stopServerWithGracePeriod's doc comment), which would hang this second
		// call forever even though the first is still on track to exit.
		if (shuttingDown) return;
		shuttingDown = true;
		if (!handover) lifecycle.enterStopping();
		log.info(handover ? "Handing over to the successor..." : "Shutting down...");
		driftSweep?.stop();
		jobPruner?.stop();
		reactorRef.current?.stop();
		standbyControl?.stop(true);
		if (server) {
			try {
				await server.stop();
			} catch (err) {
				log.error(`Error while stopping the server: ${errorMessage(err)}`);
			}
		}
		manager.disconnectAll();
		db.close();
		log.info("Goodbye.");
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	if (incumbent === undefined) {
		// Nobody else is serving: start as today. The HTTP server comes up BEFORE
		// accounts connect, so health checks and state queries are live
		// immediately; each account's loops and jobs resume as soon as it
		// connects, not after the whole fleet does.
		const started = await activate();
		log.info("Connecting accounts in the background...");
		connectAccounts(manager, store, started, CONFIG_DIR)
			.then(() => {
				lifecycle.enterActive(manager.size);
				// Run one drift sweep pass as soon as the fleet is connected, instead
				// of waiting up to a full interval for the first scheduled pass.
				void driftSweep?.runOnce();
			})
			.catch((err) => {
				log.error(`Background account connection failed: ${errorMessage(err)}`);
			});
		return;
	}

	// Successor: connect every account alongside the incumbent (the game allows
	// several connections per account since v0.707), then take over. The
	// incumbent keeps serving throughout, so the visible gap is the cutover
	// itself — seconds — rather than the minutes a fleet connect takes.
	lifecycle.enterStandby(incumbent.pid);
	standbyControl = startStandbyControl(API_PORT + 1, () => ({
		...lifecycle.status(),
		accounts: manager.size,
	}));
	try {
		await connectAccounts(manager, store, undefined, CONFIG_DIR);
	} catch (err) {
		log.error(`Standby connect failed: ${errorMessage(err)} — the incumbent keeps serving`);
		void shutdown();
		return;
	}
	log.info(`Standby holds ${manager.size} account(s); asking the incumbent to hand over`);
	await takeOverFrom(API_PORT, incumbent);
	standbyControl.stop(true);
	standbyControl = undefined;

	const started = await activate();
	await resumeConnectedAccounts(manager, store, started, CONFIG_DIR);
	projectAll(manager, projectOnChange);
	lifecycle.enterActive(manager.size);
	void driftSweep?.runOnce();
}

type LoopConfigEntry = Awaited<ReturnType<typeof LoopManager.loadLoopConfigs>>[number];

/**
 * Connect all owned accounts, resuming each one's persisted loop and any
 * interrupted async jobs as soon as THAT account finishes connecting — not
 * after the whole fleet does. A large fleet's connect is rate-limited by the
 * server's per-IP WS-connection cap and can take minutes; gating resume on
 * the entire batch left an already-connected account idle for the rest of
 * that window for no reason. Runs in the background so the HTTP server can
 * serve health/queries while accounts come online.
 */
/**
 * How the startup connect retries when the fleet-wide connect fails before a
 * single account came up. Exported for tests, which pass a no-op sleep.
 */
export interface ConnectRetryOptions {
	initialDelayMs?: number;
	maxDelayMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export async function connectAccounts(
	manager: LibAccountManager,
	store: StateStore,
	server: { loopManager: LoopManager; jobManager: JobManager } | undefined,
	configDir: string,
	{
		initialDelayMs = 15_000,
		maxDelayMs = 300_000,
		sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	}: ConnectRetryOptions = {},
): Promise<void> {
	// No server means standby: connect, but resume nothing — the incumbent is
	// still running every loop and job. They are resumed at cutover by
	// resumeConnectedAccounts.
	const resumer = server ? await makeResumer(manager, store, server, configDir) : undefined;

	let connectedCount = 0;
	const onAccountReady = (account: LibManagedAccount): void => {
		connectedCount++;
		resumer?.resume(account);
	};

	// The fleet-wide connect starts by listing owned accounts over HTTP, and that
	// fails outright while the game is restarting for a deploy. A daemon that
	// gave up there would serve no accounts until someone restarted it — which
	// happened on 2026-10-13, when setpoint started inside a game deploy window.
	// Retry with backoff for as long as it takes, but only while nothing has
	// connected: a failure after some accounts came up is not a "game is down"
	// failure, and re-running the fleet connect over live sessions would fight
	// them.
	for (let delayMs = initialDelayMs; ; delayMs = Math.min(delayMs * 2, maxDelayMs)) {
		try {
			await manager.connect(onAccountReady);
			break;
		} catch (err) {
			if (connectedCount > 0) throw err;
			log.warn(
				`Fleet connect failed before any account connected (${errorMessage(err)}); retrying in ${Math.round(delayMs / 1000)}s`,
			);
			await sleep(delayMs);
		}
	}

	if (connectedCount === 0) {
		log.warn("No accounts connected at startup. The server is up; add accounts via the API.");
		return;
	}
	resumer?.finish();
}

/**
 * Resume persisted loops and interrupted jobs for every account a standby
 * successor already holds, at the moment it takes over.
 */
export async function resumeConnectedAccounts(
	manager: LibAccountManager,
	store: StateStore,
	server: { loopManager: LoopManager; jobManager: JobManager },
	configDir: string,
): Promise<void> {
	const resumer = await makeResumer(manager, store, server, configDir);
	for (const account of manager.getAll()) resumer.resume(account);
	resumer.finish();
}

/**
 * Per-account resume of persisted loops and interrupted async jobs, shared by
 * a cold start (resume each account as it connects) and a handover (resume
 * them all at cutover).
 */
async function makeResumer(
	manager: LibAccountManager,
	store: StateStore,
	server: { loopManager: LoopManager; jobManager: JobManager },
	configDir: string,
): Promise<{ resume: (account: LibManagedAccount) => void; finish: () => void }> {
	const loopConfigs = await LoopManager.loadLoopConfigs(configDir);
	const pendingLoopConfigs = new Map(loopConfigs.map((config) => [config.playerId, config]));
	if (pendingLoopConfigs.size > 0) {
		log.info(`Found ${pendingLoopConfigs.size} persisted loop config(s), resuming...`);
	}
	return {
		resume: (account) => {
			if (!account.player?.id) {
				// The client's own onAccountConnected listener already warns and
				// skips indexing for this case (see LibAccountManager's constructor)
				// — nothing to resume for an account that was never indexed.
				return;
			}
			const playerId = playerIdOf(account);
			logAccountState(account, store);
			void resumeJobsForAccount(server.jobManager, manager, playerId);
			const loopConfig = pendingLoopConfigs.get(playerId);
			if (loopConfig) {
				pendingLoopConfigs.delete(playerId);
				resumeLoopConfig(server.loopManager, manager, loopConfig);
			}
		},
		// Any remaining config's account never connected, so nothing resumed it.
		finish: () => {
			for (const config of pendingLoopConfigs.values()) {
				log.warn(`[${config.playerId}] Account not connected, skipping loop resume`);
			}
		},
	};
}

/**
 * Write every account's full state to the SQLite mirror. A successor skips
 * projection in standby, so at cutover the mirror is refreshed in one pass.
 */
function projectAll(
	manager: LibAccountManager,
	project: (playerId: string, changed: StateSection[], account: LibManagedAccount) => void,
): void {
	for (const account of manager.getAll()) {
		if (account.player?.id) project(playerIdOf(account), [...STATE_SECTIONS], account);
	}
}

/** Log a one-line summary of an account's state as soon as it connects. */
function logAccountState(account: LibManagedAccount, store: StateStore): void {
	const state = store.getState(playerIdOf(account));
	if (!state) {
		log.warn(`[${account.id ?? "?"}] No state available`);
		return;
	}
	const player = state.player;
	const ship = state.ship;
	const location = state.location;
	log.info(
		`[${account.id ?? "?"}] ` +
			`Credits: ${player?.credits ?? "?"} | ` +
			`Ship: ${ship?.class_name ?? ship?.class_id ?? "?"} ` +
			`(Hull: ${ship?.hull ?? "?"}/${ship?.max_hull ?? "?"}, ` +
			`Fuel: ${ship?.fuel ?? "?"}/${ship?.max_fuel ?? "?"}) | ` +
			`Location: ${location?.system_name ?? "?"} - ${location?.poi_name ?? "space"} ` +
			`${location?.docked_at ? "(docked)" : "(undocked)"}`,
	);
}

/**
 * Re-queue any pending jobs for a single account.
 */
async function resumeJobsForAccount(
	jobManager: JobManager,
	manager: LibAccountManager,
	playerId: string,
): Promise<void> {
	const pendingJobs = jobManager.listPendingForAccount(playerId);
	if (pendingJobs.length === 0) return;

	const account = manager.getByPlayerId(playerId);
	if (!account) return;

	for (const job of pendingJobs) {
		if (!job.goalType || job.goalOptions === undefined) {
			jobManager.fail(job.jobId, "Daemon restarted before job completed");
			continue;
		}

		let goal: ReturnType<typeof createGoal>;
		try {
			goal = createGoal(job.goalType, job.goalOptions as Record<string, unknown>);
		} catch {
			jobManager.fail(job.jobId, "Failed to reconstruct goal for resumption");
			continue;
		}

		jobManager.requeue(job.jobId);
		// Resolve fresh from the manager on every access rather than closing over
		// `account` — a resumed job can outlive the connection it was resumed on.
		const goalCtx = makeLibGoalContext(() => {
			const live = manager.getByPlayerId(playerId);
			if (!live) {
				throw new Error(`Account ${playerId} is no longer connected`);
			}
			return live;
		});

		withAccountLogging(
			() => goalCtx.account as LibManagedAccount,
			() => goal.execute(goalCtx),
		)
			.then((result) => jobManager.complete(job.jobId, result))
			.catch((err: unknown) => jobManager.fail(job.jobId, errorMessage(err)));

		log.info(`[${playerId}] Resumed async job ${job.jobId} (${job.goalType})`);
	}
}

/**
 * Start one persisted loop config on its (already-connected) account.
 * Shared by `connectAccounts`'s per-account resume and, directly, by tests.
 */
export function resumeLoopConfig(
	loopManager: LoopManager,
	manager: LibAccountManager,
	config: LoopConfigEntry,
): void {
	type StartFn = (
		playerId: string,
		options: never,
		resolveAccount: () => LibManagedAccount,
	) => unknown;

	const startMethodMap: Record<string, StartFn | undefined> = {
		mining: loopManager.startMiningLoop.bind(loopManager) as StartFn,
		"enhanced-mining": loopManager.startEnhancedMiningLoop.bind(loopManager) as StartFn,
		trading: loopManager.startTradingLoop.bind(loopManager) as StartFn,
		hauling: loopManager.startHaulingLoop.bind(loopManager) as StartFn,
		"storage-transfer": loopManager.startStorageTransferLoop.bind(loopManager) as StartFn,
		salvage: loopManager.startSalvageLoop.bind(loopManager) as StartFn,
		"tow-salvage": loopManager.startTowSalvageLoop.bind(loopManager) as StartFn,
		exploration: loopManager.startExplorationLoop.bind(loopManager) as StartFn,
		guard: loopManager.startGuardLoop.bind(loopManager) as StartFn,
		"roaming-salvage": loopManager.startRoamingSalvageLoop.bind(loopManager) as StartFn,
	};

	const startFn = startMethodMap[config.type];
	if (!startFn) {
		log.warn(`[${config.playerId}] Unknown loop type '${config.type}', skipping`);
		return;
	}

	try {
		(
			startFn as (
				pid: string,
				opts: Record<string, unknown>,
				resolveAccount: () => LibManagedAccount,
			) => unknown
		)(config.playerId, config.options, () => {
			const live = manager.getByPlayerId(config.playerId);
			if (!live) {
				throw new Error(`Account ${config.playerId} is no longer connected`);
			}
			return live;
		});
		log.info(`[${config.playerId}] Resumed ${config.type} loop`);
	} catch (err) {
		log.warn(`[${config.playerId}] Failed to resume ${config.type} loop: ${errorMessage(err)}`);
	}
}

// Side effects that belong to RUNNING the daemon, not to importing this module.
// `connectAccounts`/`resumeLoopConfig` are imported from here by tests; before
// this guard, that import turned on file logging for the whole test process and
// every subsequent test line was appended to the live logs/daemon.log that the
// operational sessions grep — fabricated goal activity in the real log.
if (import.meta.main) {
	// Writes to logs/daemon.log alongside stdout.
	enableFileLogging(LOG_PATH);
	installCrashSafetyHandlers(log);

	main().catch((err) => {
		log.error(`Fatal error: ${errorMessage(err)}`);
		process.exit(1);
	});
}
