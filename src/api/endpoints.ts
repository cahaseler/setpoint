import type { components } from "../generated/api-types.js";
import type { ApiResponse } from "./client.js";
import type { Session } from "./session.js";

// Re-export response types from generated code for convenience
type V2GameState = components["schemas"]["V2GameState"];
type TravelResponse = components["schemas"]["TravelResponse"];
type PendingActionResponse = components["schemas"]["PendingActionResponse"];
type UndockResponse = components["schemas"]["UndockResponse"];
type RefuelResponse = components["schemas"]["RefuelResponse"];
type RepairResponse = components["schemas"]["RepairResponse"];
type ScanResponse = components["schemas"]["ScanResponse"];
type FindRouteResponse = components["schemas"]["FindRouteResponse"];
type GetNearbyResponse = components["schemas"]["GetNearbyResponse"];
type ListShipsResponse = components["schemas"]["ListShipsResponse"];
type GetMapResponse = components["schemas"]["GetMapResponse"];
type GetSystemResponse = components["schemas"]["GetSystemResponse"];
type GetMissionsResponse = components["schemas"]["GetMissionsResponse"];
type CatalogResponse = components["schemas"]["CatalogResponse"];
type InstallModResponse = components["schemas"]["InstallModResponse"];
type UninstallModResponse = components["schemas"]["UninstallModResponse"];
type GetBaseResponse = components["schemas"]["GetBaseResponse"];
type SearchSystemsResponse = components["schemas"]["SearchSystemsResponse"];
type AnalyzeMarketResponse = components["schemas"]["AnalyzeMarketResponse"];
type BuyListedShipResponse = components["schemas"]["BuyListedShipResponse"];
type SellShipResponse = components["schemas"]["SellShipResponse"];
type SwitchShipResponse = components["schemas"]["SwitchShipResponse"];
type CloakResponse = components["schemas"]["CloakResponse"];
type ReloadResponse = components["schemas"]["ReloadResponse"];
type JettisonResponse = components["schemas"]["JettisonResponse"];
type UseItemResponse = components["schemas"]["UseItemResponse"];
type SurveySystemResponse = components["schemas"]["SurveySystemResponse"];
type AcceptMissionResponse = components["schemas"]["AcceptMissionResponse"];
type CompleteMissionResponse = components["schemas"]["CompleteMissionResponse"];
type FactionIntelStatusResponse = components["schemas"]["FactionIntelStatusResponse"];
type FactionQueryIntelResponse = components["schemas"]["FactionQueryIntelResponse"];
type GetWrecksResponse = components["schemas"]["GetWrecksResponse"];
type LootWreckResponse = components["schemas"]["LootWreckResponse"];

// Direct buy/sell response types (spacemolt tool group)
type BuyResponse = components["schemas"]["BuyResponse"];
type SellResponse = components["schemas"]["SellResponse"];

// Market response types (spacemolt_market tool group)
type CreateBuyOrderResponse = components["schemas"]["CreateBuyOrderResponse"];
type CreateSellOrderResponse = components["schemas"]["CreateSellOrderResponse"];
type CancelOrderResponse = components["schemas"]["CancelOrderResponse"];
type ModifyOrderResponse = components["schemas"]["ModifyOrderResponse"];
type ViewMarketResponse = components["schemas"]["ViewMarketResponse"];
type EstimatePurchaseResponse = components["schemas"]["EstimatePurchaseResponse"];

/**
 * A single order as returned by viewOrders().
 * The generated spec uses `type` but the actual API returns `side` and `order_type`.
 */
export interface OrderEntry {
	order_id: string;
	item_id: string;
	item_name?: string;
	side: "buy" | "sell";
	order_type?: string;
	quantity: number;
	price_each: number;
	remaining: number;
	filled_quantity?: number;
	listing_fee?: number;
	status?: string;
	base_id?: string;
	created_at?: string;
}

/**
 * A single item's market data as returned by viewMarket().
 * ViewMarketResponse.items is typed as unknown in the generated spec,
 * so we define the expected shape here based on the actual API response.
 */
export interface MarketItem {
	item_id: string;
	item_name?: string;
	best_buy?: number;
	best_sell?: number;
	sell_quantity?: number;
	buy_quantity?: number;
	sell_orders?: Array<{ price_each: number; quantity: number }>;
	buy_orders?: Array<{ price_each: number; quantity: number }>;
}

/** A single result within a bulk order API response. */
export interface BulkOrderResult {
	index: number;
	success: boolean;
	order_id?: string;
	error_code?: string;
	error?: string;
	/** If present, items were returned to storage instead of being listed. */
	returned_to_storage?: number;
	message?: string;
}

/** Response shape for bulk order operations (create/cancel with orders array). */
export interface BulkOrderResponse {
	action: string;
	mode: "bulk";
	results: BulkOrderResult[];
	summary: {
		succeeded: number;
		failed: number;
		total: number;
	};
}

/**
 * Storage response shape for deposit/withdraw operations.
 *
 * The OpenAPI spec types these as GenericObjectResponse (Record<string, never>),
 * so we define the expected shape here. Fields may need refinement after
 * testing against the real API.
 */
export interface StorageActionResponse {
	action: string;
	message: string;
	item_id?: string;
	item_name?: string;
	quantity?: number;
	storage_quantity?: number;
	cargo_quantity?: number;
}

/** Per-item outcome in a bulk storage deposit/withdraw. */
export interface BulkStorageResult {
	item_id: string;
	quantity: number;
	success: boolean;
	error?: string;
	message?: string;
}

/**
 * Response shape for bulk storage operations (deposit/withdraw with an
 * `items` array). The server moves all items in a single tick and reports
 * per-item outcomes.
 */
export interface BulkStorageResponse {
	action: string;
	requested: number;
	succeeded: number;
	failed: number;
	results: BulkStorageResult[];
	target?: string;
}

/** Recipe entry returned by catalog lookup (type=recipes, id=recipeId). */
export interface RecipeCatalogEntry {
	id: string;
	name: string;
	category: string;
	description?: string;
	crafting_time?: number;
	inputs: Array<{ item_id: string; quantity: number }>;
	outputs: Array<{ item_id: string; quantity: number }>;
}

/** Storage view response shape. */
export interface StorageViewResponse {
	action: string;
	items: Array<{
		item_id: string;
		item_name: string;
		quantity: number;
		size: number;
	}>;
	credits?: number;
	base_id?: string;
}

/**
 * Typed endpoint wrappers for the SpaceMolt gameplay API.
 *
 * Each method executes through the provided session (handling auth/keepalive)
 * and returns the structuredContent cast to the correct response type.
 *
 * Grouped by gameplay category: navigation, commerce, ship, combat, info, missions.
 */
export class GameEndpoints {
	constructor(private readonly session: Session) {}

	// --- Navigation ---

	async getState(): Promise<ApiResponse<V2GameState>> {
		return this.session.execute<V2GameState>("spacemolt", "get_state");
	}

	async travel(systemId: string): Promise<ApiResponse<TravelResponse>> {
		return this.session.execute<TravelResponse>("spacemolt", "travel", { id: systemId });
	}

	async dock(baseId: string): Promise<ApiResponse<PendingActionResponse>> {
		return this.session.execute<PendingActionResponse>("spacemolt", "dock", { id: baseId });
	}

	async undock(): Promise<ApiResponse<UndockResponse>> {
		return this.session.execute<UndockResponse>("spacemolt", "undock");
	}

	async findRoute(targetSystemId: string): Promise<ApiResponse<FindRouteResponse>> {
		return this.session.execute<FindRouteResponse>("spacemolt", "find_route", {
			id: targetSystemId,
		});
	}

	async jump(systemId: string): Promise<ApiResponse<PendingActionResponse>> {
		return this.session.execute<PendingActionResponse>("spacemolt", "jump", { id: systemId });
	}

	// --- Commerce ---

	async refuel(quantity?: number): Promise<ApiResponse<RefuelResponse>> {
		return this.session.execute<RefuelResponse>("spacemolt", "refuel", {
			quantity: quantity ?? undefined,
		});
	}

	async refuelTarget(targetUsername: string): Promise<ApiResponse<RefuelResponse>> {
		return this.session.execute<RefuelResponse>("spacemolt", "refuel", { target: targetUsername });
	}

	async analyzeMarket(itemId?: string): Promise<ApiResponse<AnalyzeMarketResponse>> {
		return this.session.execute<AnalyzeMarketResponse>("spacemolt_market", "analyze_market", {
			item_id: itemId,
		});
	}

	// --- Ship Management ---

	async getShip(): Promise<ApiResponse<V2GameState>> {
		return this.session.execute<V2GameState>("spacemolt", "get_ship");
	}

	async getCargo(): Promise<ApiResponse<V2GameState>> {
		return this.session.execute<V2GameState>("spacemolt", "get_cargo");
	}

	async repair(): Promise<ApiResponse<RepairResponse>> {
		return this.session.execute<RepairResponse>("spacemolt", "repair");
	}

	async listShips(): Promise<ApiResponse<ListShipsResponse>> {
		return this.session.execute<ListShipsResponse>("spacemolt_ship", "list_ships");
	}

	async buyListedShip(listingId: string): Promise<ApiResponse<BuyListedShipResponse>> {
		return this.session.execute<BuyListedShipResponse>("spacemolt_ship", "buy_listed_ship", {
			id: listingId,
		});
	}

	async sellShip(shipId: string): Promise<ApiResponse<SellShipResponse>> {
		return this.session.execute<SellShipResponse>("spacemolt_ship", "sell_ship", { id: shipId });
	}

	async switchShip(shipId: string): Promise<ApiResponse<SwitchShipResponse>> {
		return this.session.execute<SwitchShipResponse>("spacemolt_ship", "switch_ship", {
			id: shipId,
		});
	}

	async installMod(moduleId: string): Promise<ApiResponse<InstallModResponse>> {
		return this.session.execute<InstallModResponse>("spacemolt", "install_mod", {
			id: moduleId,
		});
	}

	async uninstallMod(moduleId: string): Promise<ApiResponse<UninstallModResponse>> {
		return this.session.execute<UninstallModResponse>("spacemolt", "uninstall_mod", {
			id: moduleId,
		});
	}

	// --- Mining & Resources ---

	async mine(): Promise<ApiResponse<PendingActionResponse>> {
		return this.session.execute<PendingActionResponse>("spacemolt", "mine");
	}

	async scan(): Promise<ApiResponse<ScanResponse>> {
		return this.session.execute<ScanResponse>("spacemolt", "scan");
	}

	async catalog(
		type: "ships" | "skills" | "recipes" | "items",
		id?: string,
	): Promise<ApiResponse<CatalogResponse>> {
		return this.session.execute<CatalogResponse>("spacemolt_catalog", "catalog", {
			type,
			...(id ? { id } : {}),
		});
	}

	async jettison(itemId: string, quantity: number): Promise<ApiResponse<JettisonResponse>> {
		return this.session.execute<JettisonResponse>("spacemolt", "jettison", {
			id: itemId,
			quantity,
		});
	}

	async useItem(itemId: string): Promise<ApiResponse<UseItemResponse>> {
		return this.session.execute<UseItemResponse>("spacemolt", "use_item", { id: itemId });
	}

	// --- Information ---

	async getNearby(): Promise<ApiResponse<GetNearbyResponse>> {
		return this.session.execute<GetNearbyResponse>("spacemolt", "get_nearby");
	}

	async getMap(): Promise<ApiResponse<GetMapResponse>> {
		return this.session.execute<GetMapResponse>("spacemolt", "get_map");
	}

	async getSystem(systemId?: string): Promise<ApiResponse<GetSystemResponse>> {
		return this.session.execute<GetSystemResponse>("spacemolt", "get_system", { id: systemId });
	}

	async searchSystems(query: string): Promise<ApiResponse<SearchSystemsResponse>> {
		return this.session.execute<SearchSystemsResponse>("spacemolt", "search_systems", {
			text: query,
		});
	}

	async getBase(baseId?: string): Promise<ApiResponse<GetBaseResponse>> {
		return this.session.execute<GetBaseResponse>("spacemolt", "get_base", { id: baseId });
	}

	async getPoi(poiId?: string): Promise<ApiResponse<Record<string, unknown>>> {
		return this.session.execute<Record<string, unknown>>("spacemolt", "get_poi", { id: poiId });
	}

	async getSkills(): Promise<ApiResponse<V2GameState>> {
		return this.session.execute<V2GameState>("spacemolt", "get_skills");
	}

	async surveySystem(): Promise<ApiResponse<SurveySystemResponse>> {
		return this.session.execute<SurveySystemResponse>("spacemolt", "survey_system");
	}

	// --- Combat ---

	async attack(targetId: string): Promise<ApiResponse<PendingActionResponse>> {
		return this.session.execute<PendingActionResponse>("spacemolt", "attack", { id: targetId });
	}

	async cloak(): Promise<ApiResponse<CloakResponse>> {
		return this.session.execute<CloakResponse>("spacemolt", "cloak");
	}

	async reload(weaponId: string, ammoId: string): Promise<ApiResponse<ReloadResponse>> {
		return this.session.execute<ReloadResponse>("spacemolt_battle", "reload", {
			id: weaponId,
			target: ammoId,
		});
	}

	// --- Missions ---

	async getMissions(): Promise<ApiResponse<GetMissionsResponse>> {
		return this.session.execute<GetMissionsResponse>("spacemolt", "get_missions");
	}

	async getActiveMissions(): Promise<ApiResponse<V2GameState>> {
		return this.session.execute<V2GameState>("spacemolt", "get_active_missions");
	}

	async acceptMission(missionId: string): Promise<ApiResponse<AcceptMissionResponse>> {
		return this.session.execute<AcceptMissionResponse>("spacemolt", "accept_mission", {
			id: missionId,
		});
	}

	async declineMission(missionId: string): Promise<ApiResponse<Record<string, unknown>>> {
		return this.session.execute<Record<string, unknown>>("spacemolt", "decline_mission", {
			id: missionId,
		});
	}

	async abandonMission(missionId: string): Promise<ApiResponse<Record<string, unknown>>> {
		return this.session.execute<Record<string, unknown>>("spacemolt", "abandon_mission", {
			id: missionId,
		});
	}

	async completeMission(missionId: string): Promise<ApiResponse<CompleteMissionResponse>> {
		return this.session.execute<CompleteMissionResponse>("spacemolt", "complete_mission", {
			id: missionId,
		});
	}

	// --- Market Orders (spacemolt_market) ---

	async createBuyOrder(
		itemId: string,
		quantity: number,
		price: number,
	): Promise<ApiResponse<CreateBuyOrderResponse>> {
		return this.session.execute<CreateBuyOrderResponse>("spacemolt_market", "create_buy_order", {
			item_id: itemId,
			quantity,
			price_each: price,
		});
	}

	async createSellOrder(
		itemId: string,
		quantity: number,
		price: number,
	): Promise<ApiResponse<CreateSellOrderResponse>> {
		return this.session.execute<CreateSellOrderResponse>("spacemolt_market", "create_sell_order", {
			item_id: itemId,
			quantity,
			price_each: price,
		});
	}

	async cancelOrder(orderId: string, itemId: string): Promise<ApiResponse<CancelOrderResponse>> {
		return this.session.execute<CancelOrderResponse>("spacemolt_market", "cancel_order", {
			order_id: orderId,
			item_id: itemId,
		});
	}

	/** Cancel up to 50 orders in a single tick. */
	async cancelOrdersBulk(orderIds: string[]): Promise<ApiResponse<BulkOrderResponse>> {
		return this.session.execute<BulkOrderResponse>("spacemolt_market", "cancel_order", {
			order_ids: orderIds,
		});
	}

	/** Create up to 50 buy orders in a single tick. */
	async createBuyOrdersBulk(
		orders: Array<{ itemId: string; quantity: number; price: number }>,
	): Promise<ApiResponse<BulkOrderResponse>> {
		return this.session.execute<BulkOrderResponse>("spacemolt_market", "create_buy_order", {
			orders: orders.map((o) => ({ item_id: o.itemId, quantity: o.quantity, price_each: o.price })),
		});
	}

	/** Create up to 50 sell orders in a single tick. */
	async createSellOrdersBulk(
		orders: Array<{ itemId: string; quantity: number; price: number }>,
	): Promise<ApiResponse<BulkOrderResponse>> {
		return this.session.execute<BulkOrderResponse>("spacemolt_market", "create_sell_order", {
			orders: orders.map((o) => ({ item_id: o.itemId, quantity: o.quantity, price_each: o.price })),
		});
	}

	async modifyOrder(orderId: string, price: number): Promise<ApiResponse<ModifyOrderResponse>> {
		return this.session.execute<ModifyOrderResponse>("spacemolt_market", "modify_order", {
			order_id: orderId,
			price_each: price,
		});
	}

	async viewMarket(itemId?: string): Promise<ApiResponse<ViewMarketResponse>> {
		return this.session.execute<ViewMarketResponse>("spacemolt_market", "view_market", {
			item_id: itemId,
		});
	}

	async viewOrders(params?: {
		page?: number;
		page_size?: number;
		order_type?: "buy" | "sell";
		item_id?: string;
		search?: string;
		sort_by?: "newest" | "oldest" | "price_asc" | "price_desc";
	}): Promise<
		ApiResponse<{
			action: string;
			base: string;
			orders: OrderEntry[];
			orders_count: number;
			has_more?: boolean;
		}>
	> {
		return this.session.execute("spacemolt_market", "view_orders", params);
	}

	/** Fetch open faction orders (separate call since v0.191.0). */
	async viewFactionOrders(params?: {
		page?: number;
		page_size?: number;
		order_type?: "buy" | "sell";
		item_id?: string;
		search?: string;
		sort_by?: "newest" | "oldest" | "price_asc" | "price_desc";
	}): Promise<
		ApiResponse<{
			action: string;
			base: string;
			orders: OrderEntry[];
			orders_count: number;
			has_more?: boolean;
		}>
	> {
		return this.session.execute("spacemolt_market", "view_orders", {
			...params,
			scope: "faction",
		});
	}

	/**
	 * Fetch ALL personal open orders by paginating through every page.
	 *
	 * Use this (instead of viewOrders) whenever the full order book is needed
	 * for diff/sync operations, since the API now paginates results.
	 */
	async viewAllOrders(): Promise<OrderEntry[]> {
		return this.fetchAllOrderPages();
	}

	/**
	 * Fetch ALL faction open orders by paginating through every page.
	 *
	 * Use this (instead of viewFactionOrders) whenever the full faction order
	 * book is needed for diff/sync operations.
	 */
	async viewAllFactionOrders(): Promise<OrderEntry[]> {
		return this.fetchAllOrderPages("faction");
	}

	private async fetchAllOrderPages(scope?: "faction"): Promise<OrderEntry[]> {
		const PAGE_SIZE = 50;
		const all: OrderEntry[] = [];
		let page = 1;
		while (true) {
			const params: Record<string, unknown> = { page, page_size: PAGE_SIZE };
			if (scope) {
				params["scope"] = scope;
			}
			const response = await this.session.execute<{
				orders: OrderEntry[];
				orders_count: number;
				has_more?: boolean;
			}>("spacemolt_market", "view_orders", params);
			const orders = response.structuredContent.orders ?? [];
			all.push(...orders);
			if (!response.structuredContent.has_more) {
				break;
			}
			page++;
		}
		return all;
	}

	async estimatePurchase(
		itemId: string,
		quantity: number,
	): Promise<ApiResponse<EstimatePurchaseResponse>> {
		return this.session.execute<EstimatePurchaseResponse>("spacemolt_market", "estimate_purchase", {
			item_id: itemId,
			quantity,
		});
	}

	// --- Storage (spacemolt_storage) ---

	async depositToStorage(
		itemId: string,
		quantity: number,
		source?: "cargo" | "faction",
	): Promise<ApiResponse<StorageActionResponse>> {
		return this.session.execute<StorageActionResponse>("spacemolt_storage", "deposit", {
			item_id: itemId,
			quantity,
			target: "self",
			...(source ? { source } : {}),
		});
	}

	/** Deposit up to 50 item types to personal storage in a single tick. */
	async depositToStorageBulk(
		items: Array<{ itemId: string; quantity: number }>,
		source?: "cargo" | "faction",
	): Promise<ApiResponse<BulkStorageResponse>> {
		return this.session.execute<BulkStorageResponse>("spacemolt_storage", "deposit", {
			items: items.map((i) => ({ item_id: i.itemId, quantity: i.quantity })),
			target: "self",
			...(source ? { source } : {}),
		});
	}

	async withdrawFromStorage(
		itemId: string,
		quantity: number,
	): Promise<ApiResponse<StorageActionResponse>> {
		return this.session.execute<StorageActionResponse>("spacemolt_storage", "withdraw", {
			item_id: itemId,
			quantity,
			target: "self",
		});
	}

	/** Withdraw up to 50 item types from personal storage in a single tick. */
	async withdrawFromStorageBulk(
		items: Array<{ itemId: string; quantity: number }>,
	): Promise<ApiResponse<BulkStorageResponse>> {
		return this.session.execute<BulkStorageResponse>("spacemolt_storage", "withdraw", {
			items: items.map((i) => ({ item_id: i.itemId, quantity: i.quantity })),
			target: "self",
		});
	}

	async viewStorage(): Promise<ApiResponse<StorageViewResponse>> {
		return this.session.execute<StorageViewResponse>("spacemolt_storage", "view", {
			target: "self",
		});
	}

	// --- Direct Buy/Sell (spacemolt) ---

	async buy(itemId: string, quantity: number): Promise<ApiResponse<BuyResponse>> {
		return this.session.execute<BuyResponse>("spacemolt", "buy", {
			id: itemId,
			quantity,
		});
	}

	async sell(itemId: string, quantity: number): Promise<ApiResponse<SellResponse>> {
		return this.session.execute<SellResponse>("spacemolt", "sell", {
			id: itemId,
			quantity,
		});
	}

	// --- Faction Storage (spacemolt_storage with target) ---

	async depositToFactionStorage(
		itemId: string,
		quantity: number,
		source?: "cargo" | "storage",
	): Promise<ApiResponse<StorageActionResponse>> {
		return this.session.execute<StorageActionResponse>("spacemolt_storage", "deposit", {
			item_id: itemId,
			quantity,
			target: "faction",
			...(source ? { source } : {}),
		});
	}

	/** Deposit up to 50 item types to faction storage in a single tick. */
	async depositToFactionStorageBulk(
		items: Array<{ itemId: string; quantity: number }>,
		source?: "cargo" | "storage",
	): Promise<ApiResponse<BulkStorageResponse>> {
		return this.session.execute<BulkStorageResponse>("spacemolt_storage", "deposit", {
			items: items.map((i) => ({ item_id: i.itemId, quantity: i.quantity })),
			target: "faction",
			...(source ? { source } : {}),
		});
	}

	async withdrawFromFactionStorage(
		itemId: string,
		quantity: number,
	): Promise<ApiResponse<StorageActionResponse>> {
		return this.session.execute<StorageActionResponse>("spacemolt_storage", "withdraw", {
			item_id: itemId,
			quantity,
			target: "faction",
		});
	}

	/** Withdraw up to 50 item types from faction storage in a single tick. */
	async withdrawFromFactionStorageBulk(
		items: Array<{ itemId: string; quantity: number }>,
	): Promise<ApiResponse<BulkStorageResponse>> {
		return this.session.execute<BulkStorageResponse>("spacemolt_storage", "withdraw", {
			items: items.map((i) => ({ item_id: i.itemId, quantity: i.quantity })),
			target: "faction",
		});
	}

	async viewFactionStorage(): Promise<ApiResponse<StorageViewResponse>> {
		return this.session.execute<StorageViewResponse>("spacemolt_storage", "view", {
			target: "faction",
		});
	}

	// --- Faction Intel (spacemolt_intel tool group) ---

	async intelStatus(): Promise<ApiResponse<FactionIntelStatusResponse>> {
		return this.session.execute<FactionIntelStatusResponse>("spacemolt_intel", "intel_status");
	}

	async queryIntel(): Promise<ApiResponse<FactionQueryIntelResponse>> {
		return this.session.execute<FactionQueryIntelResponse>("spacemolt_intel", "query_intel");
	}

	// --- Salvage (spacemolt_salvage tool group) ---

	async getWrecks(): Promise<ApiResponse<GetWrecksResponse>> {
		return this.session.execute<GetWrecksResponse>("spacemolt_salvage", "wrecks");
	}

	async lootWreck(wreckId: string): Promise<ApiResponse<LootWreckResponse>> {
		return this.session.execute<LootWreckResponse>("spacemolt_salvage", "loot", { id: wreckId });
	}

	// --- Gifting (spacemolt_storage deposit to player) ---

	async giftToPlayer(
		targetName: string,
		itemId: string,
		quantity: number,
		message?: string,
	): Promise<ApiResponse<StorageActionResponse>> {
		return this.session.execute<StorageActionResponse>("spacemolt_storage", "deposit", {
			item_id: itemId,
			quantity,
			target: targetName,
			...(message !== undefined ? { message } : {}),
		});
	}
}
