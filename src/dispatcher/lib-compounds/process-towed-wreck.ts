import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { LibDisposeTowedWreck } from "../lib-primitives/dispose-towed-wreck.js";
import { LibDockAt } from "../lib-primitives/dock-at.js";
import { LibEnsureFueled } from "../lib-primitives/ensure-fueled.js";
import { LibGoToPoi } from "../lib-primitives/go-to-poi.js";
import { LibNavigateToSystem } from "../lib-primitives/navigate-to-system.js";
import { LibTowWreck } from "../lib-primitives/tow-wreck.js";
import { runLibSequence } from "../lib-sequence.js";
import { LibDrainTowedWreck } from "./drain-towed-wreck.js";

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
export class LibProcessTowedWreck implements LibGoal {
	readonly name = "process-towed-wreck";
	private readonly options: ProcessTowedWreckOptions;

	constructor(options: ProcessTowedWreckOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<CompoundGoalResult> {
		const { wreckId, yardSystemId, yardPoiId, yardBaseId, disposition, storageTarget } =
			this.options;

		log.info(
			`Processing wreck ${wreckId}: yard=${yardSystemId}/${yardPoiId}/${yardBaseId}, disposition=${disposition}`,
		);

		const steps: LibGoal[] = [
			new LibTowWreck(wreckId),
			new LibNavigateToSystem(yardSystemId),
			new LibGoToPoi(yardPoiId),
			new LibDockAt(yardBaseId),
			new LibEnsureFueled(),
			new LibDrainTowedWreck({
				wreckId,
				...(storageTarget !== undefined ? { storageTarget } : {}),
			}),
			new LibDisposeTowedWreck({ disposition }),
		];

		return runLibSequence(steps, ctx);
	}
}
