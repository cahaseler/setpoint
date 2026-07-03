import { z } from "zod";

/**
 * Zod schema per loop type, mirrored field-for-field from the daemon's
 * `src/server/handlers.ts` loop validators (`validateMiningOptions`,
 * `validateTradingOptions`, etc. — NOT the README's "Loop Types Reference"
 * summary, which omits several optional fields). These schemas double as
 * the client's compile-time types (`z.infer`) and the daemon's runtime
 * validators. Cross-checked against the `*LoopApiOptions` interfaces in
 * `src/server/loop-manager.ts`.
 */

const maxIterations = z.number().optional();
const depositTarget = z.enum(["personal", "faction"]).optional();
const cashSource = z.literal("faction").optional();
const minCredits = z.number().optional();
/** Accepts an object of item_id -> price, or a JSON string of the same (parsed by the handler). */
const listPrices = z.union([z.record(z.string(), z.number()), z.string()]).optional();

export const loopSchemas = {
	mining: z.object({
		miningSystemId: z.string(),
		beltPoiId: z.string(),
		sellSystemId: z.string(),
		sellStationPoiId: z.string(),
		sellBaseId: z.string(),
		fullThreshold: z.number().optional(),
		maxAttempts: z.number().optional(),
		repair: z.boolean().optional(),
		depositTarget,
		skipMarket: z.boolean().optional(),
		cashSource,
		minCredits,
		listPrice: z.number().optional(),
		listPrices,
		retryOnDepleted: z.boolean().optional(),
		maxIterations,
	}),

	"enhanced-mining": z.object({
		miningSystemId: z.string(),
		beltPoiId: z.string(),
		sellSystemId: z.string(),
		sellStationPoiId: z.string(),
		sellBaseId: z.string(),
		junkItemIds: z.array(z.string()),
		fullThreshold: z.number().optional(),
		maxAttempts: z.number().optional(),
		maxJettisonRounds: z.number().optional(),
		repair: z.boolean().optional(),
		depositTarget,
		skipMarket: z.boolean().optional(),
		cashSource,
		minCredits,
		listPrice: z.number().optional(),
		listPrices,
		retryOnDepleted: z.boolean().optional(),
		maxIterations,
	}),

	salvage: z.object({
		salvageSystemId: z.string(),
		salvagePoiId: z.string(),
		sellSystemId: z.string(),
		sellStationPoiId: z.string(),
		sellBaseId: z.string(),
		fullThreshold: z.number().optional(),
		maxAttempts: z.number().optional(),
		repair: z.boolean().optional(),
		depositTarget,
		skipMarket: z.boolean().optional(),
		cashSource,
		minCredits,
		maxIterations,
	}),

	"roaming-salvage": z.object({
		homeSystemId: z.string(),
		homeStationPoiId: z.string(),
		homeBaseId: z.string(),
		allowLawless: z.boolean().optional(),
		fullThreshold: z.number().optional(),
		minFuelReserve: z.number().optional(),
		repair: z.boolean().optional(),
		depositTarget,
		cashSource,
		minCredits,
		maxLootAttempts: z.number().optional(),
		maxIterations,
	}),

	"tow-salvage": z.object({
		mode: z.literal("fixed"),
		yardSystemId: z.string(),
		yardPoiId: z.string(),
		yardBaseId: z.string(),
		wreckSystemId: z.string(),
		wreckPoiId: z.string(),
		disposition: z.enum(["scrap", "sell"]).optional(),
		storageTarget: z.enum(["personal", "faction"]).optional(),
		maxIterations,
	}),

	trading: z.object({
		buyStation: z.object({
			systemId: z.string(),
			poiId: z.string(),
			baseId: z.string(),
		}),
		sellStation: z.object({
			systemId: z.string(),
			stationPoiId: z.string(),
			baseId: z.string(),
		}),
		items: z
			.array(
				z.object({
					itemId: z.string(),
					maxBuyPrice: z.number(),
					minSellPrice: z.number(),
					maxQuantity: z.number().optional(),
				}),
			)
			.min(1),
		refuel: z.boolean().optional(),
		maxIterations,
	}),

	hauling: z.object({
		source: z.object({
			systemId: z.string(),
			poiId: z.string(),
			baseId: z.string(),
			type: z.enum(["personal-storage", "faction-storage", "market"]),
			items: z
				.array(
					z.object({
						itemId: z.string(),
						quantity: z.number().optional(),
						maxPrice: z.number().optional(),
					}),
				)
				.min(1),
		}),
		destination: z
			.object({
				systemId: z.string(),
				poiId: z.string(),
				baseId: z.string(),
				type: z.enum(["personal-storage", "faction-storage", "gift", "market"]),
				targetPlayer: z.string().optional(),
				items: z
					.array(
						z.object({
							itemId: z.string(),
							minPrice: z.number().optional(),
						}),
					)
					.optional(),
			})
			.refine((d) => d.type !== "gift" || typeof d.targetPlayer === "string", {
				message: "destination.targetPlayer is required when destination.type is 'gift'",
				path: ["targetPlayer"],
			}),
		refuel: z.boolean().optional(),
		maxIterations,
	}),

	"storage-transfer": z.object({
		systemId: z.string(),
		stationPoiId: z.string(),
		baseId: z.string(),
		refuel: z.boolean().optional(),
		excludeCredits: z.boolean().optional(),
		maxIterations,
	}),

	exploration: z.object({
		systemId: z.string(),
		stationPoiId: z.string(),
		baseId: z.string(),
		allowLawless: z.boolean().optional(),
		minFuelReserve: z.number().optional(),
		repairThreshold: z.number().optional(),
		survey: z.boolean().optional(),
		minSubmittedAtTick: z.number().optional(),
		maxIterations,
	}),

	guard: z.object({
		homeSystemId: z.string(),
		homeStationPoiId: z.string(),
		homeBaseId: z.string(),
		guardSystemId: z.string(),
		guardPoiId: z.string(),
		cashSource,
		minCredits,
		repairThreshold: z.number().optional(),
		maxIterations,
	}),
} as const satisfies Record<string, z.ZodType>;

export type LoopType = keyof typeof loopSchemas;
export type LoopOptionsMap = { [T in LoopType]: z.infer<(typeof loopSchemas)[T]> };

/**
 * Flat PATCH partials, one per loop type — matches `PATCH /accounts/:id/loop`,
 * which patches the live options object in place without restarting the loop.
 * Only the top-level object is made partial (nested objects like `hauling`'s
 * `source`/`destination` remain fully-shaped if provided at all).
 */
export const loopPatchSchemas = Object.fromEntries(
	Object.entries(loopSchemas).map(([k, s]) => [k, (s as z.AnyZodObject).partial()]),
) as { [T in LoopType]: ReturnType<(typeof loopSchemas)[T]["partial"]> };
