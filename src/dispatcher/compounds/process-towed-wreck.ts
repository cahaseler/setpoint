import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult, Goal, GoalContext } from "../goals.js";
import {
	DisposeTowedWreck,
	DockAt,
	EnsureFueled,
	GoToPoi,
	NavigateToSystem,
	TowWreck,
} from "../primitives/index.js";
import { runSequence } from "../sequence.js";
import { DrainTowedWreck } from "./drain-towed-wreck.js";

const log = createLogger("goal:process-towed-wreck");

export interface ProcessTowedWreckOptions {
	/** Id of the wreck to tow and process. */
	wreckId: string;
	/** System containing the salvage yard. */
	yardSystemId: string;
	/** POI id of the salvage yard. */
	yardPoiId: string;
	/** Base id to dock at within the salvage yard. */
	yardBaseId: string;
	/** How to dispose of the wreck after draining: scrap for materials or sell for credits. */
	disposition: "scrap" | "sell";
	/** Where to deposit looted cargo. Defaults to "personal". */
	storageTarget?: "personal" | "faction";
}

/**
 * Process a single towed wreck end-to-end.
 *
 * Steps:
 * 1. TowWreck — attach the tow rig to the wreck
 * 2. NavigateToSystem — jump to the salvage yard system
 * 3. GoToPoi — travel to the yard POI
 * 4. DockAt — dock at the yard base
 * 5. EnsureFueled — refuel to max while docked at the yard
 * 6. DrainTowedWreck — loot the wreck dry into storage
 * 7. DisposeTowedWreck — scrap or sell the emptied wreck
 *
 * A PERMANENT:-prefixed failure from TowWreck or DisposeTowedWreck propagates
 * unchanged so the tow-salvage loop can stop instead of retrying.
 */
export class ProcessTowedWreck implements Goal {
	readonly name = "process-towed-wreck";
	private readonly options: ProcessTowedWreckOptions;

	constructor(options: ProcessTowedWreckOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<CompoundGoalResult> {
		const { wreckId, yardSystemId, yardPoiId, yardBaseId, disposition, storageTarget } =
			this.options;

		log.info(
			`Processing wreck ${wreckId}: yard=${yardSystemId}/${yardPoiId}/${yardBaseId}, disposition=${disposition}`,
		);

		const steps: Goal[] = [
			new TowWreck(wreckId),
			new NavigateToSystem(yardSystemId),
			new GoToPoi(yardPoiId),
			new DockAt(yardBaseId),
			new EnsureFueled(),
			new DrainTowedWreck({
				wreckId,
				...(storageTarget !== undefined ? { storageTarget } : {}),
			}),
			new DisposeTowedWreck({ disposition }),
		];

		return runSequence(steps, ctx);
	}
}
