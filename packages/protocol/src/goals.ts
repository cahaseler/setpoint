import { z } from "zod";

/**
 * Zod schema per goal type, mirrored field-for-field from the daemon's
 * `src/server/goal-registry.ts` factory closures (the authoritative source
 * for every goal's options — NOT the design doc summary). These schemas
 * double as the client's compile-time types (`z.infer`) and the daemon's
 * runtime validators.
 */
export const goalSchemas = {
	// --- Primitives ---
	"navigate-to-system": z.object({
		targetSystemId: z.string(),
		fuelReserve: z.number().optional(),
	}),
	"navigate-via-route": z.object({
		route: z.array(z.string()),
		fuelReserve: z.number().optional(),
	}),
	"go-to-poi": z.object({ targetPoiId: z.string() }),
	"dock-at": z.object({ targetBaseId: z.string() }),
	"ensure-undocked": z.object({}),
	"ensure-fueled": z.object({ targetFuel: z.number().optional() }),
	"ensure-repaired": z.object({}),
	"sell-or-deposit-cargo": z.object({
		depositTarget: z.enum(["personal", "faction"]).optional(),
	}),
	"ensure-empty-cargo": z.object({
		depositTarget: z.enum(["personal", "faction"]).optional(),
	}),
	"jettison-cargo": z.object({
		itemId: z.string(),
		quantity: z.number(),
	}),
	"load-from-storage": z.object({
		itemId: z.string(),
		maxQuantity: z.number().optional(),
	}),
	scan: z.object({}),
	"use-item": z.object({ itemId: z.string() }),
	"create-buy-order": z.object({
		itemId: z.string(),
		quantity: z.number(),
		price: z.number(),
	}),
	"create-sell-order": z.object({
		itemId: z.string(),
		quantity: z.number(),
		price: z.number(),
	}),
	"cancel-orders": z.object({ orderIds: z.array(z.string()) }),
	"accept-mission": z.object({ missionId: z.string() }),
	"complete-mission": z.object({ missionId: z.string() }),
	"abandon-mission": z.object({ missionId: z.string() }),
	"install-mod": z.object({ moduleId: z.string() }),
	"uninstall-mod": z.object({ moduleId: z.string() }),
	"buy-items": z.object({
		items: z
			.array(
				z.object({
					itemId: z.string(),
					maxPrice: z.number(),
					maxQuantity: z.number().optional(),
				}),
			)
			.min(1),
	}),
	"list-cargo-for-sale": z.object({
		items: z
			.array(
				z.object({
					itemId: z.string(),
					minPrice: z.number(),
				}),
			)
			.min(1),
	}),
	"deposit-to-faction-storage": z.object({
		itemId: z.string(),
		quantity: z.number(),
	}),
	"withdraw-from-faction-storage": z.object({
		itemId: z.string(),
		quantity: z.number().optional(),
	}),
	"gift-to-player": z.object({
		targetName: z.string(),
		itemId: z.string(),
		quantity: z.number(),
		message: z.string().optional(),
	}),
	"load-from-faction-storage": z.object({
		itemId: z.string(),
		maxQuantity: z.number().optional(),
	}),
	"ensure-credits-from-faction": z.object({
		minCredits: z.number().optional(),
	}),

	// --- Compounds ---
	"mine-until-full": z.object({
		fullThreshold: z.number().optional(),
		maxAttempts: z.number().optional(),
	}),
	"prepare-at-station": z.object({
		systemId: z.string(),
		poiId: z.string(),
		baseId: z.string(),
		refuel: z.boolean().optional(),
		repair: z.boolean().optional(),
		cashSource: z.literal("faction").optional(),
		minCredits: z.number().optional(),
		route: z.array(z.string()).optional(),
	}),
	"sell-at-station": z.object({
		systemId: z.string(),
		stationPoiId: z.string(),
		baseId: z.string(),
		refuel: z.boolean().optional(),
		depositTarget: z.enum(["personal", "faction"]).optional(),
		cashSource: z.literal("faction").optional(),
		minCredits: z.number().optional(),
	}),
	"mining-run": z.object({
		systemId: z.string(),
		beltPoiId: z.string(),
		fullThreshold: z.number().optional(),
		maxAttempts: z.number().optional(),
	}),
	"enhanced-mining-run": z.object({
		systemId: z.string(),
		beltPoiId: z.string(),
		junkItemIds: z.array(z.string()),
		fullThreshold: z.number().optional(),
		maxAttempts: z.number().optional(),
		maxJettisonRounds: z.number().optional(),
	}),
	"mine-with-jettison": z.object({
		junkItemIds: z.array(z.string()),
		fullThreshold: z.number().optional(),
		maxAttempts: z.number().optional(),
		maxJettisonRounds: z.number().optional(),
	}),
	"buy-at-station": z.object({
		systemId: z.string(),
		poiId: z.string(),
		baseId: z.string(),
		items: z
			.array(
				z.object({
					itemId: z.string(),
					maxPrice: z.number(),
					maxQuantity: z.number().optional(),
				}),
			)
			.min(1),
		refuel: z.boolean().optional(),
	}),
	"sell-at-station-priced": z.object({
		systemId: z.string(),
		stationPoiId: z.string(),
		baseId: z.string(),
		items: z
			.array(
				z.object({
					itemId: z.string(),
					minPrice: z.number(),
				}),
			)
			.min(1),
		refuel: z.boolean().optional(),
	}),
	"load-at-station": z.object({
		systemId: z.string(),
		poiId: z.string(),
		baseId: z.string(),
		sourceType: z.enum(["personal-storage", "faction-storage", "market"]),
		items: z
			.array(
				z.object({
					itemId: z.string(),
					quantity: z.number().optional(),
					maxPrice: z.number().optional(),
				}),
			)
			.min(1),
		refuel: z.boolean().optional(),
	}),
	"unload-at-station": z.object({
		systemId: z.string(),
		poiId: z.string(),
		baseId: z.string(),
		destType: z.enum(["personal-storage", "faction-storage", "gift", "market"]),
		targetPlayer: z.string().optional(),
		items: z
			.array(
				z.object({
					itemId: z.string(),
					minPrice: z.number().optional(),
				}),
			)
			.optional(),
		refuel: z.boolean().optional(),
	}),
	"ensure-loadout": z.object({
		systemId: z.string(),
		poiId: z.string(),
		baseId: z.string(),
		modules: z.array(z.string()),
		ammo: z.record(z.string(), z.string()).optional(),
		uninstalledStorage: z.enum(["personal", "faction", "cargo"]).optional(),
	}),
	"ensure-marketbook": z.object({
		targetOrders: z
			.array(
				z.object({
					itemId: z.string(),
					side: z.enum(["buy", "sell"]),
					quantity: z.number(),
					price: z.number(),
				}),
			)
			.min(1),
		priceTolerance: z.number().min(0).max(1).optional(),
		cancelUnmatched: z.boolean().optional(),
	}),
	"transfer-storage-to-faction": z.object({}),
	"fuel-rescue": z.object({
		systemId: z.string(),
		poiId: z.string(),
		targetUsername: z.string(),
	}),
	"transfer-storage": z.object({
		source: z.enum(["self", "faction"]),
		target: z.enum(["self", "faction"]),
		itemId: z.string(),
		quantity: z.number().optional(),
	}),
} as const satisfies Record<string, z.ZodType>;

export type GoalType = keyof typeof goalSchemas;
export type GoalOptionsMap = { [T in GoalType]: z.infer<(typeof goalSchemas)[T]> };

/** Goal/loop types that have been removed in favour of the raw passthrough. */
export const DEPRECATED_GOAL_TYPES = [
	"craft",
	"craft-batch",
	"craft-from-faction",
	"crafting",
] as const;
export type DeprecatedGoalType = (typeof DEPRECATED_GOAL_TYPES)[number];

/**
 * Guidance returned for the removed managed crafting goals/loops. Verbatim
 * copy of `CRAFTING_DEPRECATION_MESSAGE` in the daemon's `goal-registry.ts`.
 */
const CRAFTING_DEPRECATION_MESSAGE =
	"DEPRECATED: managed crafting goals/loops were removed. Crafting is now an async job " +
	"queue on the game server — submit jobs directly through the raw passthrough: " +
	'POST /accounts/:id/raw {"toolGroup":"spacemolt","action":"craft","params":{"id":"<recipe>","quantity":<n>}} ' +
	"(or `smctl raw <acct> craft id=<recipe> quantity=<n>`). Manage and inspect jobs with the " +
	"spacemolt_facility job_add/job_list/job_cancel actions, and watch 'crafting_update' " +
	"notifications for completion.";

/**
 * Returns the deprecation guidance for a removed goal/loop type, or undefined
 * if the type is not deprecated.
 */
export function deprecatedGoalMessage(type: string): string | undefined {
	return (DEPRECATED_GOAL_TYPES as readonly string[]).includes(type)
		? CRAFTING_DEPRECATION_MESSAGE
		: undefined;
}
