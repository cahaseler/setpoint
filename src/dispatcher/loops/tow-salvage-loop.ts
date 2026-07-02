import { createLogger } from "../../util/logger.js";
import { ProcessTowedWreck } from "../compounds/process-towed-wreck.js";
import {
	type Goal,
	type GoalContext,
	type GoalResult,
	type LoopOptions,
	type LoopResult,
	failed,
} from "../goals.js";
import { runLoop } from "../loops.js";
import { GoToPoi } from "../primitives/go-to-poi.js";
import { NavigateToSystem } from "../primitives/navigate-to-system.js";
import { PERMANENT_PREFIX } from "../primitives/tow-wreck.js";
import { runSequence } from "../sequence.js";

const log = createLogger("loop:tow-salvage");

const NO_WRECKS_MESSAGE = "No wrecks to process";

/** Options for the fixed-site tow-salvage loop. */
export interface TowSalvageLoopOptions {
	/** Salvage mode. Only "fixed" (single wreck POI → single yard) is supported. */
	mode: "fixed";
	/** System containing the wreck POI. */
	wreckSystemId: string;
	/** POI id where wrecks accumulate. */
	wreckPoiId: string;
	/** System containing the salvage yard. */
	yardSystemId: string;
	/** POI id of the salvage yard. */
	yardPoiId: string;
	/** Base id to dock at within the salvage yard. */
	yardBaseId: string;
	/** How to dispose of each wreck after draining. Defaults to "scrap". */
	disposition?: "scrap" | "sell";
	/** Where to deposit looted cargo. Defaults to "personal". */
	storageTarget?: "personal" | "faction";
	/** Loop control options (signal, maxIterations, retryDelayMs, etc.). */
	loopOptions?: LoopOptions;
}

interface WreckSummary {
	id: string;
	towed_by_player_id?: string | null;
}

/**
 * One fixed-site iteration: travel to the wreck POI, pick an un-towed wreck,
 * and process it end-to-end (tow → yard → drain → dispose).
 *
 * If the wreck site is clear, the iteration succeeds with a "no wrecks" result
 * so the loop idles and re-checks on the next pass. If ProcessTowedWreck reports
 * a permanent precondition failure (no tow-rig / no salvage skill), the iteration
 * aborts the loop's stop controller so the loop ends instead of burning retries.
 */
class TowSalvageIteration implements Goal {
	readonly name = "tow-salvage-iteration";
	private readonly options: TowSalvageLoopOptions;
	private readonly stop: AbortController;

	constructor(options: TowSalvageLoopOptions, stop: AbortController) {
		this.options = options;
		this.stop = stop;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		// Get to the wreck site.
		const travel = await runSequence(
			[new NavigateToSystem(this.options.wreckSystemId), new GoToPoi(this.options.wreckPoiId)],
			ctx,
		);
		if (!travel.success) {
			return travel;
		}

		const wrecksResp = await ctx.endpoints.getWrecks();
		const wrecks =
			(wrecksResp.structuredContent as unknown as { wrecks?: WreckSummary[] }).wrecks ?? [];
		const target = wrecks.find((w) => !w.towed_by_player_id);

		if (!target) {
			log.info(`No wrecks at ${this.options.wreckPoiId}; idling`);
			return failed(`${NO_WRECKS_MESSAGE} at ${this.options.wreckPoiId}`, travel.ticksUsed);
		}

		log.info(`Processing wreck ${target.id} from ${this.options.wreckPoiId}`);
		const result = await new ProcessTowedWreck({
			wreckId: target.id,
			yardSystemId: this.options.yardSystemId,
			yardPoiId: this.options.yardPoiId,
			yardBaseId: this.options.yardBaseId,
			disposition: this.options.disposition ?? "scrap",
			...(this.options.storageTarget !== undefined
				? { storageTarget: this.options.storageTarget }
				: {}),
		}).execute(ctx);

		// runSequence wraps a failed step as "Failed at <step>. PERMANENT: ..." — the
		// marker lands in the middle of the message, so match with includes(), not startsWith().
		if (!result.success && result.message.includes(PERMANENT_PREFIX)) {
			log.error(`Permanent precondition — stopping tow-salvage loop: ${result.message}`);
			this.stop.abort();
		}

		return { ...result, ticksUsed: travel.ticksUsed + result.ticksUsed };
	}
}

/**
 * Run a fixed-site tow-salvage loop: travel to the wreck POI, tow the first
 * un-towed wreck back to the yard, drain it, and dispose of it — repeat.
 *
 * Stops cleanly on a permanent precondition failure (no tow-rig module fitted,
 * no salvage skill) instead of retrying it indefinitely.
 */
export function runTowSalvageLoop(
	options: TowSalvageLoopOptions,
	ctx: GoalContext,
): Promise<LoopResult> {
	log.info(
		`Starting tow-salvage loop (fixed): wreck=${options.wreckPoiId} → yard=${options.yardBaseId}, disposition=${options.disposition ?? "scrap"}`,
	);

	const stop = new AbortController();
	const external = options.loopOptions?.signal;
	if (external?.aborted) {
		stop.abort();
	} else {
		external?.addEventListener("abort", () => stop.abort(), { once: true });
	}

	const factory = (): Goal => new TowSalvageIteration(options, stop);

	const baseIgnore = options.loopOptions?.ignoreFailure;
	const ignoreFailure = (r: GoalResult): boolean => {
		if (r.message.includes(NO_WRECKS_MESSAGE)) return true;
		return baseIgnore?.(r) ?? false;
	};

	return runLoop(factory, ctx, { ...options.loopOptions, signal: stop.signal, ignoreFailure });
}
