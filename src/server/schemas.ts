/**
 * Goal and loop form schemas, served at /schemas/goals and /schemas/loops.
 *
 * Each schema describes the fields needed to build a dynamic form for
 * submitting goals or starting loops via the dispatcher API.
 */

export interface FieldSchema {
	name: string;
	label: string;
	type: "string" | "number" | "boolean" | "select" | "array" | "object";
	required: boolean;
	options?: Array<{ value: string; label: string }>;
	default?: unknown;
	advanced?: boolean;
	help?: string;
	min?: number;
	max?: number;
	itemFields?: FieldSchema[];
	fields?: FieldSchema[];
}

export interface GoalSchema {
	type: string;
	label: string;
	description: string;
	category: string;
	fields: FieldSchema[];
}

// ── Helper builders ──────────────────────────────────────────────────

function str(
	name: string,
	label: string,
	opts?: { required?: boolean; advanced?: boolean; help?: string },
): FieldSchema {
	return {
		name,
		label,
		type: "string",
		required: opts?.required ?? true,
		...(opts?.advanced ? { advanced: true } : {}),
		...(opts?.help ? { help: opts.help } : {}),
	};
}

function num(
	name: string,
	label: string,
	opts?: {
		required?: boolean;
		advanced?: boolean;
		help?: string;
		min?: number;
		max?: number;
		default?: number;
	},
): FieldSchema {
	return {
		name,
		label,
		type: "number",
		required: opts?.required ?? false,
		...(opts?.advanced ? { advanced: true } : {}),
		...(opts?.help ? { help: opts.help } : {}),
		...(opts?.min !== undefined ? { min: opts.min } : {}),
		...(opts?.max !== undefined ? { max: opts.max } : {}),
		...(opts?.default !== undefined ? { default: opts.default } : {}),
	};
}

function bool(
	name: string,
	label: string,
	opts?: { advanced?: boolean; help?: string; default?: boolean },
): FieldSchema {
	return {
		name,
		label,
		type: "boolean",
		required: false,
		...(opts?.advanced ? { advanced: true } : {}),
		...(opts?.help ? { help: opts.help } : {}),
		...(opts?.default !== undefined ? { default: opts.default } : {}),
	};
}

function select(
	name: string,
	label: string,
	options: Array<{ value: string; label: string }>,
	opts?: { required?: boolean; advanced?: boolean; help?: string },
): FieldSchema {
	return {
		name,
		label,
		type: "select",
		required: opts?.required ?? false,
		options,
		...(opts?.advanced ? { advanced: true } : {}),
		...(opts?.help ? { help: opts.help } : {}),
	};
}

function arr(
	name: string,
	label: string,
	itemFields: FieldSchema[],
	opts?: { required?: boolean; advanced?: boolean; help?: string },
): FieldSchema {
	return {
		name,
		label,
		type: "array",
		required: opts?.required ?? true,
		itemFields,
		...(opts?.advanced ? { advanced: true } : {}),
		...(opts?.help ? { help: opts.help } : {}),
	};
}

function obj(
	name: string,
	label: string,
	fields: FieldSchema[],
	opts?: { required?: boolean; advanced?: boolean; help?: string },
): FieldSchema {
	return {
		name,
		label,
		type: "object",
		required: opts?.required ?? true,
		fields,
		...(opts?.advanced ? { advanced: true } : {}),
		...(opts?.help ? { help: opts.help } : {}),
	};
}

function strArr(
	name: string,
	label: string,
	opts?: { required?: boolean; advanced?: boolean; help?: string },
): FieldSchema {
	return {
		name,
		label,
		type: "array",
		required: opts?.required ?? true,
		itemFields: [{ name: "value", label: "Value", type: "string", required: true }],
		...(opts?.advanced ? { advanced: true } : {}),
		...(opts?.help ? { help: opts.help } : {}),
	};
}

// ── Reusable field sets ──────────────────────────────────────────────

const depositTargetSelect = (opts?: { advanced?: boolean }): FieldSchema =>
	select(
		"depositTarget",
		"Deposit Target",
		[
			{ value: "personal", label: "Personal Storage" },
			{ value: "faction", label: "Faction Storage" },
		],
		opts?.advanced ? { advanced: true } : {},
	);

const cashSourceSelect = (opts?: { advanced?: boolean }): FieldSchema =>
	select(
		"cashSource",
		"Cash Source",
		[{ value: "faction", label: "Faction Treasury" }],
		opts?.advanced ? { advanced: true } : {},
	);

const maxIterationsField = (): FieldSchema =>
	num("maxIterations", "Max Iterations", {
		advanced: true,
		help: "Stop the loop after this many iterations",
		min: 1,
	});

// ── Goal Schemas ─────────────────────────────────────────────────────

export const goalSchemas: GoalSchema[] = [
	// --- Navigation ---
	{
		type: "navigate-to-system",
		label: "Navigate to System",
		description:
			"Travel to a target star system via multi-hop jumps. Does NOT refuel en route — " +
			"fails before departing if the trip exceeds current fuel. Refuel separately first.",
		category: "navigation",
		fields: [
			str("targetSystemId", "Target System ID"),
			num("fuelReserve", "Fuel Reserve", {
				advanced: true,
				min: 0,
				help: "Fuel to keep beyond the trip's estimated cost; fails before departing unless the ship would arrive with at least this much to spare (e.g. for the return trip or in-system travel).",
			}),
		],
	},
	{
		type: "go-to-poi",
		label: "Go to POI",
		description: "Fly to a point of interest within the current system.",
		category: "navigation",
		fields: [str("targetPoiId", "Target POI ID")],
	},
	{
		type: "dock-at",
		label: "Dock at Base",
		description: "Dock at a station or base.",
		category: "navigation",
		fields: [str("targetBaseId", "Target Base ID")],
	},
	{
		type: "ensure-undocked",
		label: "Ensure Undocked",
		description: "Undock from the current station if docked.",
		category: "navigation",
		fields: [],
	},

	// --- Ship ---
	{
		type: "ensure-fueled",
		label: "Ensure Fueled",
		description: "Refuel the ship to a target fuel level.",
		category: "ship",
		fields: [num("targetFuel", "Target Fuel", { help: "Target fuel amount; omit for full tank" })],
	},
	{
		type: "ensure-repaired",
		label: "Ensure Repaired",
		description: "Repair the ship to full hull integrity.",
		category: "ship",
		fields: [],
	},
	{
		type: "scan",
		label: "Scan",
		description: "Scan the current location for points of interest.",
		category: "ship",
		fields: [],
	},

	// --- Cargo ---
	{
		type: "sell-or-deposit-cargo",
		label: "Sell or Deposit Cargo",
		description: "Sell all cargo at the market or deposit into storage.",
		category: "cargo",
		fields: [depositTargetSelect()],
	},
	{
		type: "ensure-empty-cargo",
		label: "Ensure Empty Cargo",
		description: "Empty cargo by selling or depositing all items.",
		category: "cargo",
		fields: [depositTargetSelect()],
	},
	{
		type: "jettison-cargo",
		label: "Jettison Cargo",
		description: "Jettison a specific item from cargo into space.",
		category: "cargo",
		fields: [str("itemId", "Item ID"), num("quantity", "Quantity", { required: true, min: 1 })],
	},
	{
		type: "load-from-storage",
		label: "Load from Storage",
		description: "Load an item from personal storage into cargo.",
		category: "cargo",
		fields: [
			str("itemId", "Item ID"),
			num("maxQuantity", "Max Quantity", { help: "Limit how many to load" }),
		],
	},
	{
		type: "load-from-faction-storage",
		label: "Load from Faction Storage",
		description: "Load an item from faction storage into cargo.",
		category: "cargo",
		fields: [
			str("itemId", "Item ID"),
			num("maxQuantity", "Max Quantity", { help: "Limit how many to load" }),
		],
	},

	// --- Commerce ---
	{
		type: "buy-items",
		label: "Buy Items",
		description: "Buy items from the market with price limits.",
		category: "commerce",
		fields: [
			arr("items", "Items", [
				str("itemId", "Item ID"),
				num("maxPrice", "Max Price", { required: true, min: 0 }),
				num("maxQuantity", "Max Quantity"),
			]),
		],
	},
	{
		type: "list-cargo-for-sale",
		label: "List Cargo for Sale",
		description: "List cargo items for sale on the market.",
		category: "commerce",
		fields: [
			arr("items", "Items", [
				str("itemId", "Item ID"),
				num("minPrice", "Min Price", { required: true, min: 0 }),
			]),
		],
	},
	{
		type: "create-buy-order",
		label: "Create Buy Order",
		description: "Place a buy order on the market.",
		category: "commerce",
		fields: [
			str("itemId", "Item ID"),
			num("quantity", "Quantity", { required: true, min: 1 }),
			num("price", "Price", { required: true, min: 0 }),
		],
	},
	{
		type: "create-sell-order",
		label: "Create Sell Order",
		description: "Place a sell order on the market.",
		category: "commerce",
		fields: [
			str("itemId", "Item ID"),
			num("quantity", "Quantity", { required: true, min: 1 }),
			num("price", "Price", { required: true, min: 0 }),
		],
	},
	{
		type: "cancel-orders",
		label: "Cancel Orders",
		description: "Cancel one or more active market orders.",
		category: "commerce",
		fields: [strArr("orderIds", "Order IDs", { help: "IDs of orders to cancel" })],
	},

	// --- Crafting ---
	{
		type: "use-item",
		label: "Use Item",
		description: "Use a consumable item from cargo.",
		category: "crafting",
		fields: [str("itemId", "Item ID")],
	},

	// --- Missions ---
	{
		type: "accept-mission",
		label: "Accept Mission",
		description: "Accept an available mission.",
		category: "missions",
		fields: [str("missionId", "Mission ID")],
	},
	{
		type: "complete-mission",
		label: "Complete Mission",
		description: "Turn in a completed mission for rewards.",
		category: "missions",
		fields: [str("missionId", "Mission ID")],
	},
	{
		type: "abandon-mission",
		label: "Abandon Mission",
		description: "Abandon an active mission.",
		category: "missions",
		fields: [str("missionId", "Mission ID")],
	},

	// --- Modules ---
	{
		type: "install-mod",
		label: "Install Module",
		description: "Install a module onto the ship.",
		category: "modules",
		fields: [str("moduleId", "Module ID")],
	},
	{
		type: "uninstall-mod",
		label: "Uninstall Module",
		description: "Remove a module from the ship.",
		category: "modules",
		fields: [str("moduleId", "Module ID")],
	},

	// --- Faction ---
	{
		type: "deposit-to-faction-storage",
		label: "Deposit to Faction Storage",
		description: "Deposit an item from cargo into faction storage.",
		category: "faction",
		fields: [str("itemId", "Item ID"), num("quantity", "Quantity", { required: true, min: 1 })],
	},
	{
		type: "withdraw-from-faction-storage",
		label: "Withdraw from Faction Storage",
		description: "Withdraw an item from faction storage into cargo.",
		category: "faction",
		fields: [str("itemId", "Item ID"), num("quantity", "Quantity")],
	},
	{
		type: "gift-to-player",
		label: "Gift to Player",
		description: "Send an item from cargo to another player.",
		category: "faction",
		fields: [
			str("targetName", "Target Player"),
			str("itemId", "Item ID"),
			num("quantity", "Quantity", { required: true, min: 1 }),
			str("message", "Message", { required: false, help: "Optional gift message" }),
		],
	},
	{
		type: "ensure-credits-from-faction",
		label: "Ensure Credits from Faction",
		description: "Withdraw credits from the faction treasury if below a threshold.",
		category: "faction",
		fields: [
			num("minCredits", "Min Credits", { help: "Withdraw until you have at least this many" }),
		],
	},
	{
		type: "transfer-storage-to-faction",
		label: "Transfer Storage to Faction",
		description: "Transfer all personal storage items to faction storage.",
		category: "faction",
		fields: [],
	},
	{
		type: "transfer-storage",
		label: "Transfer Storage",
		description: "Transfer an item between personal and faction storage.",
		category: "faction",
		fields: [
			select(
				"source",
				"Source",
				[
					{ value: "self", label: "Personal Storage" },
					{ value: "faction", label: "Faction Storage" },
				],
				{ required: true },
			),
			select(
				"target",
				"Target",
				[
					{ value: "self", label: "Personal Storage" },
					{ value: "faction", label: "Faction Storage" },
				],
				{ required: true },
			),
			str("itemId", "Item ID"),
			num("quantity", "Quantity", { help: "Omit to transfer all" }),
		],
	},

	// --- Mining Compounds ---
	{
		type: "mine-until-full",
		label: "Mine Until Full",
		description: "Mine at the current asteroid belt until cargo is full.",
		category: "mining",
		fields: [
			num("fullThreshold", "Full Threshold", {
				advanced: true,
				help: "Cargo fraction (0-1) considered full",
				min: 0,
				max: 1,
			}),
			num("maxAttempts", "Max Attempts", { advanced: true, min: 1 }),
		],
	},
	{
		type: "mining-run",
		label: "Mining Run",
		description: "Fly to a belt and mine until cargo is full.",
		category: "mining",
		fields: [
			str("systemId", "System ID"),
			str("beltPoiId", "Belt POI ID"),
			num("fullThreshold", "Full Threshold", {
				advanced: true,
				min: 0,
				max: 1,
			}),
			num("maxAttempts", "Max Attempts", { advanced: true, min: 1 }),
		],
	},
	{
		type: "enhanced-mining-run",
		label: "Enhanced Mining Run",
		description: "Mine and jettison junk items to maximize valuable ore.",
		category: "mining",
		fields: [
			str("systemId", "System ID"),
			str("beltPoiId", "Belt POI ID"),
			strArr("junkItemIds", "Junk Item IDs", { help: "Items to jettison while mining" }),
			num("fullThreshold", "Full Threshold", {
				advanced: true,
				min: 0,
				max: 1,
			}),
			num("maxAttempts", "Max Attempts", { advanced: true, min: 1 }),
			num("maxJettisonRounds", "Max Jettison Rounds", { advanced: true, min: 1 }),
		],
	},
	{
		type: "mine-with-jettison",
		label: "Mine with Jettison",
		description: "Mine at the current belt, jettisoning junk items to keep valuable ore.",
		category: "mining",
		fields: [
			strArr("junkItemIds", "Junk Item IDs", { help: "Items to jettison while mining" }),
			num("fullThreshold", "Full Threshold", {
				advanced: true,
				min: 0,
				max: 1,
			}),
			num("maxAttempts", "Max Attempts", { advanced: true, min: 1 }),
			num("maxJettisonRounds", "Max Jettison Rounds", { advanced: true, min: 1 }),
		],
	},

	// --- Station Compounds ---
	{
		type: "prepare-at-station",
		label: "Prepare at Station",
		description: "Travel to a station, dock, refuel, and repair.",
		category: "station",
		fields: [
			str("systemId", "System ID"),
			str("poiId", "Station POI ID"),
			str("baseId", "Base ID"),
			bool("refuel", "Refuel", { advanced: true, default: true }),
			bool("repair", "Repair", { advanced: true, default: true }),
			cashSourceSelect({ advanced: true }),
			num("minCredits", "Min Credits", {
				advanced: true,
				help: "Ensure this many credits from faction before docking",
			}),
		],
	},
	{
		type: "sell-at-station",
		label: "Sell at Station",
		description: "Travel to a station and sell all cargo.",
		category: "station",
		fields: [
			str("systemId", "System ID"),
			str("stationPoiId", "Station POI ID"),
			str("baseId", "Base ID"),
			bool("refuel", "Refuel", { advanced: true }),
			depositTargetSelect({ advanced: true }),
			cashSourceSelect({ advanced: true }),
			num("minCredits", "Min Credits", { advanced: true }),
		],
	},
	{
		type: "buy-at-station",
		label: "Buy at Station",
		description: "Travel to a station and buy items from the market.",
		category: "station",
		fields: [
			str("systemId", "System ID"),
			str("poiId", "Station POI ID"),
			str("baseId", "Base ID"),
			arr("items", "Items", [
				str("itemId", "Item ID"),
				num("maxPrice", "Max Price", { required: true, min: 0 }),
				num("maxQuantity", "Max Quantity"),
			]),
			bool("refuel", "Refuel", { advanced: true }),
		],
	},
	{
		type: "sell-at-station-priced",
		label: "Sell at Station (Priced)",
		description: "Travel to a station and list cargo for sale at minimum prices.",
		category: "station",
		fields: [
			str("systemId", "System ID"),
			str("stationPoiId", "Station POI ID"),
			str("baseId", "Base ID"),
			arr("items", "Items", [
				str("itemId", "Item ID"),
				num("minPrice", "Min Price", { required: true, min: 0 }),
			]),
			bool("refuel", "Refuel", { advanced: true }),
		],
	},
	{
		type: "load-at-station",
		label: "Load at Station",
		description: "Travel to a station and load items from storage or market.",
		category: "station",
		fields: [
			str("systemId", "System ID"),
			str("poiId", "Station POI ID"),
			str("baseId", "Base ID"),
			select(
				"sourceType",
				"Source Type",
				[
					{ value: "personal-storage", label: "Personal Storage" },
					{ value: "faction-storage", label: "Faction Storage" },
					{ value: "market", label: "Market" },
				],
				{ required: true },
			),
			arr("items", "Items", [
				str("itemId", "Item ID"),
				num("quantity", "Quantity"),
				num("maxPrice", "Max Price", { help: "Only used when source is market" }),
			]),
			bool("refuel", "Refuel", { advanced: true }),
		],
	},
	{
		type: "unload-at-station",
		label: "Unload at Station",
		description: "Travel to a station and unload cargo to storage, market, or gift.",
		category: "station",
		fields: [
			str("systemId", "System ID"),
			str("poiId", "Station POI ID"),
			str("baseId", "Base ID"),
			select(
				"destType",
				"Destination Type",
				[
					{ value: "personal-storage", label: "Personal Storage" },
					{ value: "faction-storage", label: "Faction Storage" },
					{ value: "gift", label: "Gift to Player" },
					{ value: "market", label: "Market" },
				],
				{ required: true },
			),
			str("targetPlayer", "Target Player", {
				required: false,
				help: "Required when destination is gift",
			}),
			arr(
				"items",
				"Items",
				[
					str("itemId", "Item ID"),
					num("minPrice", "Min Price", { help: "Only used when destination is market" }),
				],
				{ required: false },
			),
			bool("refuel", "Refuel", { advanced: true }),
		],
	},
	{
		type: "ensure-loadout",
		label: "Ensure Loadout",
		description: "Travel to a station and equip a specific set of modules.",
		category: "station",
		fields: [
			str("systemId", "System ID"),
			str("poiId", "Station POI ID"),
			str("baseId", "Base ID"),
			strArr("modules", "Module IDs", { help: "Module type_ids to install" }),
			str("ammo", "Ammo Mapping", {
				required: false,
				advanced: true,
				help: "JSON object mapping weapon type_id to ammo item_id",
			}),
			select(
				"uninstalledStorage",
				"Uninstalled Module Storage",
				[
					{ value: "personal", label: "Personal Storage" },
					{ value: "faction", label: "Faction Storage" },
					{ value: "cargo", label: "Keep in Cargo" },
				],
				{ advanced: true },
			),
		],
	},
	{
		type: "ensure-marketbook",
		label: "Ensure Marketbook",
		description: "Ensure a set of market orders exist with the correct prices and quantities.",
		category: "commerce",
		fields: [
			arr("targetOrders", "Target Orders", [
				str("itemId", "Item ID"),
				select(
					"side",
					"Side",
					[
						{ value: "buy", label: "Buy" },
						{ value: "sell", label: "Sell" },
					],
					{ required: true },
				),
				num("quantity", "Quantity", { required: true, min: 1 }),
				num("price", "Price", { required: true, min: 0 }),
				num("priceTolerance", "Price Tolerance", {
					advanced: true,
					help: "Acceptable deviation (0-1 range)",
					min: 0,
					max: 1,
				}),
			]),
			bool("cancelUnmatched", "Cancel Unmatched Orders", {
				advanced: true,
				help: "Cancel existing orders that do not match any target",
			}),
		],
	},
	{
		type: "fuel-rescue",
		label: "Fuel Rescue",
		description: "Fly to a system and gift fuel to a stranded player.",
		category: "combat",
		fields: [
			str("systemId", "System ID"),
			str("poiId", "POI ID"),
			str("targetUsername", "Target Player"),
		],
	},
];

// ── Loop Schemas ─────────────────────────────────────────────────────

export const loopSchemas: GoalSchema[] = [
	{
		type: "mining",
		label: "Mining Loop",
		description: "Mine ore at an asteroid belt, sell at a station, and repeat.",
		category: "mining",
		fields: [
			str("miningSystemId", "Mining System ID"),
			str("beltPoiId", "Belt POI ID"),
			str("sellSystemId", "Sell System ID"),
			str("sellStationPoiId", "Sell Station POI ID"),
			str("sellBaseId", "Sell Base ID"),
			num("fullThreshold", "Full Threshold", {
				advanced: true,
				min: 0,
				max: 1,
				help: "Cargo fraction (0-1) considered full",
			}),
			num("maxAttempts", "Max Mine Attempts", { advanced: true, min: 1 }),
			bool("repair", "Repair at Station", { advanced: true }),
			depositTargetSelect({ advanced: true }),
			bool("skipMarket", "Skip Market", {
				advanced: true,
				help: "Deposit to storage instead of selling",
			}),
			cashSourceSelect({ advanced: true }),
			num("minCredits", "Min Credits", { advanced: true }),
			num("listPrice", "List Price", {
				advanced: true,
				help: "List all cargo at this flat price instead of selling instantly",
			}),
			str("listPrices", "Per-Item List Prices (JSON)", {
				advanced: true,
				required: false,
				help: 'JSON object of item_id → price, e.g. {"iron_ore": 50, "copper_ore": 30}. Overrides listPrice per item.',
			}),
			bool("retryOnDepleted", "Retry on Depleted", {
				advanced: true,
				help: "Retry mining if the belt is depleted",
			}),
			maxIterationsField(),
		],
	},
	{
		type: "enhanced-mining",
		label: "Enhanced Mining Loop",
		description:
			"Mine with junk-item jettison for higher-value cargo, sell at station, and repeat.",
		category: "mining",
		fields: [
			str("miningSystemId", "Mining System ID"),
			str("beltPoiId", "Belt POI ID"),
			str("sellSystemId", "Sell System ID"),
			str("sellStationPoiId", "Sell Station POI ID"),
			str("sellBaseId", "Sell Base ID"),
			strArr("junkItemIds", "Junk Item IDs", { help: "Items to jettison while mining" }),
			num("fullThreshold", "Full Threshold", {
				advanced: true,
				min: 0,
				max: 1,
			}),
			num("maxAttempts", "Max Mine Attempts", { advanced: true, min: 1 }),
			num("maxJettisonRounds", "Max Jettison Rounds", { advanced: true, min: 1 }),
			bool("repair", "Repair at Station", { advanced: true }),
			depositTargetSelect({ advanced: true }),
			bool("skipMarket", "Skip Market", {
				advanced: true,
				help: "Deposit to storage instead of selling",
			}),
			cashSourceSelect({ advanced: true }),
			num("minCredits", "Min Credits", { advanced: true }),
			num("listPrice", "List Price", {
				advanced: true,
				help: "List all cargo at this flat price instead of selling instantly",
			}),
			str("listPrices", "Per-Item List Prices (JSON)", {
				advanced: true,
				required: false,
				help: 'JSON object of item_id → price, e.g. {"iron_ore": 50, "copper_ore": 30}. Overrides listPrice per item.',
			}),
			bool("retryOnDepleted", "Retry on Depleted", { advanced: true }),
			maxIterationsField(),
		],
	},
	{
		type: "salvage",
		label: "Salvage Loop",
		description: "Loot wrecks at a salvage site, sell at station, and repeat.",
		category: "mining",
		fields: [
			str("salvageSystemId", "Salvage System ID"),
			str("salvagePoiId", "Salvage POI ID"),
			str("sellSystemId", "Sell System ID"),
			str("sellStationPoiId", "Sell Station POI ID"),
			str("sellBaseId", "Sell Base ID"),
			num("fullThreshold", "Full Threshold", {
				advanced: true,
				min: 0,
				max: 1,
			}),
			num("maxAttempts", "Max Loot Attempts", { advanced: true, min: 1 }),
			bool("repair", "Repair at Station", { advanced: true }),
			depositTargetSelect({ advanced: true }),
			bool("skipMarket", "Skip Market", { advanced: true }),
			cashSourceSelect({ advanced: true }),
			num("minCredits", "Min Credits", { advanced: true }),
			maxIterationsField(),
		],
	},
	{
		type: "roaming-salvage",
		label: "Roaming Salvage Loop",
		description:
			"Sweep through systems via BFS, looting wrecks at each POI and returning home when full.",
		category: "mining",
		fields: [
			str("homeSystemId", "Home System ID"),
			str("homeStationPoiId", "Home Station POI ID"),
			str("homeBaseId", "Home Base ID"),
			bool("allowLawless", "Allow Lawless Systems", { advanced: true }),
			num("fullThreshold", "Full Threshold", {
				advanced: true,
				min: 0,
				max: 1,
			}),
			num("minFuelReserve", "Min Fuel Reserve", {
				advanced: true,
				help: "Return home when fuel drops below this level",
			}),
			bool("repair", "Repair at Home", { advanced: true }),
			depositTargetSelect({ advanced: true }),
			cashSourceSelect({ advanced: true }),
			num("minCredits", "Min Credits", { advanced: true }),
			num("maxLootAttempts", "Max Loot Attempts per POI", { advanced: true, min: 1 }),
			maxIterationsField(),
		],
	},
	{
		type: "trading",
		label: "Trading Loop",
		description: "Buy items at one station, sell at another, and repeat.",
		category: "commerce",
		fields: [
			obj("buyStation", "Buy Station", [
				str("systemId", "System ID"),
				str("poiId", "Station POI ID"),
				str("baseId", "Base ID"),
			]),
			obj("sellStation", "Sell Station", [
				str("systemId", "System ID"),
				str("stationPoiId", "Station POI ID"),
				str("baseId", "Base ID"),
			]),
			arr("items", "Trade Items", [
				str("itemId", "Item ID"),
				num("maxBuyPrice", "Max Buy Price", { required: true, min: 0 }),
				num("minSellPrice", "Min Sell Price", { required: true, min: 0 }),
				num("maxQuantity", "Max Quantity"),
			]),
			bool("refuel", "Refuel", { advanced: true }),
			maxIterationsField(),
		],
	},
	{
		type: "hauling",
		label: "Hauling Loop",
		description: "Load items at a source station, deliver to a destination, and repeat.",
		category: "commerce",
		fields: [
			obj("source", "Source", [
				str("systemId", "System ID"),
				str("poiId", "Station POI ID"),
				str("baseId", "Base ID"),
				select(
					"type",
					"Source Type",
					[
						{ value: "personal-storage", label: "Personal Storage" },
						{ value: "faction-storage", label: "Faction Storage" },
						{ value: "market", label: "Market" },
					],
					{ required: true },
				),
				arr("items", "Items to Load", [
					str("itemId", "Item ID"),
					num("quantity", "Quantity"),
					num("maxPrice", "Max Price", { help: "Only used when source is market" }),
				]),
			]),
			obj("destination", "Destination", [
				str("systemId", "System ID"),
				str("poiId", "Station POI ID"),
				str("baseId", "Base ID"),
				select(
					"type",
					"Destination Type",
					[
						{ value: "personal-storage", label: "Personal Storage" },
						{ value: "faction-storage", label: "Faction Storage" },
						{ value: "gift", label: "Gift to Player" },
						{ value: "market", label: "Market" },
					],
					{ required: true },
				),
				str("targetPlayer", "Target Player", {
					required: false,
					help: "Required when destination is gift",
				}),
				arr(
					"items",
					"Items to Unload",
					[
						str("itemId", "Item ID"),
						num("minPrice", "Min Price", {
							help: "Only used when destination is market",
						}),
					],
					{ required: false },
				),
			]),
			bool("refuel", "Refuel", { advanced: true }),
			maxIterationsField(),
		],
	},
	{
		type: "storage-transfer",
		label: "Storage Transfer Loop",
		description: "Transfer all personal storage items to faction storage at a station.",
		category: "faction",
		fields: [
			str("systemId", "System ID"),
			str("stationPoiId", "Station POI ID"),
			str("baseId", "Base ID"),
			bool("refuel", "Refuel", { advanced: true }),
			bool("excludeCredits", "Exclude Credits", {
				advanced: true,
				help: "Skip transferring credits",
			}),
			maxIterationsField(),
		],
	},
	{
		type: "exploration",
		label: "Exploration Loop",
		description: "Explore unvisited systems and contribute map intel to the faction.",
		category: "navigation",
		fields: [
			str("systemId", "Home System ID"),
			str("stationPoiId", "Home Station POI ID"),
			str("baseId", "Home Base ID"),
			bool("allowLawless", "Allow Lawless Systems", { advanced: true }),
			num("minFuelReserve", "Min Fuel Reserve", { advanced: true }),
			num("repairThreshold", "Repair Threshold", {
				advanced: true,
				help: "Hull fraction (0-1) below which to return for repairs",
				min: 0,
				max: 1,
			}),
			bool("survey", "Survey Systems", {
				advanced: true,
				help: "Perform survey scans at each system",
			}),
			num("minSubmittedAtTick", "Min Submitted at Tick", {
				advanced: true,
				help: "Only visit systems last submitted before this tick",
			}),
			maxIterationsField(),
		],
	},
	{
		type: "guard",
		label: "Guard Loop",
		description: "Patrol a target POI, attacking hostiles and returning home to resupply.",
		category: "combat",
		fields: [
			str("homeSystemId", "Home System ID"),
			str("homeStationPoiId", "Home Station POI ID"),
			str("homeBaseId", "Home Base ID"),
			str("guardSystemId", "Guard System ID"),
			str("guardPoiId", "Guard POI ID"),
			cashSourceSelect({ advanced: true }),
			num("minCredits", "Min Credits", { advanced: true }),
			num("repairThreshold", "Repair Threshold", {
				advanced: true,
				help: "Hull fraction (0-1) below which to return for repairs",
				min: 0,
				max: 1,
			}),
			maxIterationsField(),
		],
	},
];

/** Get all goal form schemas. */
export function getGoalSchemas(): GoalSchema[] {
	return goalSchemas;
}

/** Get all loop form schemas. */
export function getLoopSchemas(): GoalSchema[] {
	return loopSchemas;
}
