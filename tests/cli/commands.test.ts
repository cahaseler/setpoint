import { describe, expect, mock, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import type { DaemonClient, DaemonResponse } from "../../src/cli/client.js";
import { type CommandContext, dispatch, getUsageText } from "../../src/cli/commands.js";
import type { CliOutput } from "../../src/cli/output.js";

// ── Mock Factories ──────────────────────────────────────────────────

interface MockClient {
	get: ReturnType<typeof mock>;
	post: ReturnType<typeof mock>;
	patch: ReturnType<typeof mock>;
	delete: ReturnType<typeof mock>;
}

function createMockClient(response: DaemonResponse = { status: 200, data: {} }): MockClient {
	return {
		get: mock(() => Promise.resolve(response)),
		post: mock(() => Promise.resolve(response)),
		patch: mock(() => Promise.resolve(response)),
		delete: mock(() => Promise.resolve(response)),
	};
}

interface MockOutput {
	ok: ReturnType<typeof mock>;
	clientError: ReturnType<typeof mock>;
	serverError: ReturnType<typeof mock>;
	connectionError: ReturnType<typeof mock>;
	timeoutError: ReturnType<typeof mock>;
	usageError: ReturnType<typeof mock>;
	fromStatus: ReturnType<typeof mock>;
	raw: ReturnType<typeof mock>;
	lastFromStatus: { status: number; data: unknown } | undefined;
	lastRaw: string | undefined;
}

function createMockOutput(): MockOutput {
	const mockOut: MockOutput = {
		ok: mock(() => {}),
		clientError: mock(() => {}),
		serverError: mock(() => {}),
		connectionError: mock(() => {}),
		timeoutError: mock(() => {}),
		usageError: mock(() => {
			throw new Error("usage_error");
		}),
		fromStatus: mock((status: number, data: unknown) => {
			mockOut.lastFromStatus = { status, data };
		}),
		raw: mock((text: string) => {
			mockOut.lastRaw = text;
		}),
		lastFromStatus: undefined,
		lastRaw: undefined,
	};
	return mockOut;
}

function makeCtx(
	clientResponse?: DaemonResponse,
	jsonBody?: unknown,
): { ctx: CommandContext; client: MockClient; output: MockOutput } {
	const client = createMockClient(clientResponse);
	const output = createMockOutput();
	return {
		ctx: {
			client: client as unknown as DaemonClient,
			output: output as unknown as CliOutput,
			jsonBody,
		},
		client,
		output,
	};
}

// ── Tests ───────────────────────────────────────────────────────────

describe("dispatch", () => {
	test("returns false for unknown command", async () => {
		const { ctx } = makeCtx();
		const matched = await dispatch(ctx, ["unknown"]);
		expect(matched).toBe(false);
	});

	test("status calls GET /dashboard/data", async () => {
		const { ctx, client } = makeCtx({ status: 200, data: { accounts: [] } });
		await dispatch(ctx, ["status"]);

		expect(client.get).toHaveBeenCalledWith("/dashboard/data");
	});

	test("health calls GET /health", async () => {
		const { ctx, client, output } = makeCtx({ status: 200, data: { status: "ok" } });
		await dispatch(ctx, ["health"]);

		expect(client.get).toHaveBeenCalledWith("/health");
		expect(output.fromStatus).toHaveBeenCalled();
	});

	test("accounts list calls GET /accounts", async () => {
		const { ctx, client } = makeCtx();
		await dispatch(ctx, ["accounts", "list"]);

		expect(client.get).toHaveBeenCalledWith("/accounts");
	});

	test("accounts get calls GET /accounts/:playerId", async () => {
		const { ctx, client } = makeCtx();
		await dispatch(ctx, ["accounts", "get", "player-123"]);

		expect(client.get).toHaveBeenCalledWith("/accounts/player-123");
	});

	test("accounts get without playerId triggers usage error", async () => {
		const { ctx, output } = makeCtx();

		await expect(dispatch(ctx, ["accounts", "get"])).rejects.toThrow("usage_error");
		expect(output.usageError).toHaveBeenCalled();
	});

	test("accounts add calls POST /accounts with JSON body", async () => {
		const body = { username: "test", password: "pass", player_id: "p1" };
		const { ctx, client } = makeCtx({ status: 201, data: {} }, body);
		await dispatch(ctx, ["accounts", "add"]);

		expect(client.post).toHaveBeenCalledWith("/accounts", body);
	});

	test("accounts add without body triggers usage error", async () => {
		const { ctx, output } = makeCtx();

		await expect(dispatch(ctx, ["accounts", "add"])).rejects.toThrow("usage_error");
		expect(output.usageError).toHaveBeenCalled();
	});

	test("accounts remove calls DELETE /accounts/:playerId", async () => {
		const { ctx, client } = makeCtx();
		await dispatch(ctx, ["accounts", "remove", "player-123"]);

		expect(client.delete).toHaveBeenCalledWith("/accounts/player-123", {
			requestTimeoutMs: 0,
		});
	});

	test("state calls GET /accounts/:playerId/state", async () => {
		const { ctx, client } = makeCtx();
		await dispatch(ctx, ["state", "player-123"]);

		expect(client.get).toHaveBeenCalledWith("/accounts/player-123/state");
	});

	test("state with section calls GET /accounts/:playerId/state/:section", async () => {
		const { ctx, client } = makeCtx();
		await dispatch(ctx, ["state", "player-123", "ship"]);

		expect(client.get).toHaveBeenCalledWith("/accounts/player-123/state/ship");
	});

	test("loop status calls GET /accounts/:playerId/loop", async () => {
		const { ctx, client } = makeCtx();
		await dispatch(ctx, ["loop", "status", "player-123"]);

		expect(client.get).toHaveBeenCalledWith("/accounts/player-123/loop");
	});

	test("loop start calls POST /accounts/:playerId/loop with body", async () => {
		const body = { type: "mining", options: { miningSystemId: "sol" } };
		const { ctx, client } = makeCtx({ status: 201, data: {} }, body);
		await dispatch(ctx, ["loop", "start", "player-123"]);

		expect(client.post).toHaveBeenCalledWith("/accounts/player-123/loop", body);
	});

	test("loop start tow-salvage POSTs /accounts/:playerId/loop with the body", async () => {
		const body = {
			type: "tow-salvage",
			options: {
				mode: "fixed",
				disposition: "scrap",
				yardSystemId: "sol",
				yardPoiId: "yard",
				yardBaseId: "yard-base",
				wreckSystemId: "sol",
				wreckPoiId: "belt",
			},
		};
		const { ctx, client } = makeCtx({ status: 201, data: {} }, body);
		await dispatch(ctx, ["loop", "start", "player-123"]);
		expect(client.post).toHaveBeenCalledWith("/accounts/player-123/loop", body);
	});

	test("loop stop calls DELETE /accounts/:playerId/loop", async () => {
		const { ctx, client } = makeCtx();
		await dispatch(ctx, ["loop", "stop", "player-123"]);

		expect(client.delete).toHaveBeenCalledWith("/accounts/player-123/loop");
	});

	test("loop update calls PATCH /accounts/:playerId/loop with body", async () => {
		const patch = { junkItemIds: ["rock_dust", "metal_fragment"] };
		const { ctx, client } = makeCtx({ status: 200, data: {} }, patch);
		await dispatch(ctx, ["loop", "update", "player-123"]);

		expect(client.patch).toHaveBeenCalledWith("/accounts/player-123/loop", patch);
	});

	test("abort calls DELETE /accounts/:playerId/abort", async () => {
		const { ctx, client } = makeCtx();
		await dispatch(ctx, ["abort", "player-123"]);

		expect(client.delete).toHaveBeenCalledWith("/accounts/player-123/abort", {});
	});

	test("log-level without arg calls GET /log-level", async () => {
		const { ctx, client } = makeCtx();
		await dispatch(ctx, ["log-level"]);

		expect(client.get).toHaveBeenCalledWith("/log-level");
	});

	test("log-level with arg calls POST /log-level", async () => {
		const { ctx, client } = makeCtx();
		await dispatch(ctx, ["log-level", "debug"]);

		expect(client.post).toHaveBeenCalledWith("/log-level", { level: "debug" });
	});

	// --- New commands ---

	test("accounts register calls POST /accounts/register with body", async () => {
		const body = { username: "NewBot", empire: "solarian" };
		const { ctx, client } = makeCtx({ status: 201, data: {} }, body);
		await dispatch(ctx, ["accounts", "register"]);

		expect(client.post).toHaveBeenCalledWith("/accounts/register", body, {
			requestTimeoutMs: 0,
		});
	});

	test("accounts register without body triggers usage error", async () => {
		const { ctx, output } = makeCtx();

		await expect(dispatch(ctx, ["accounts", "register"])).rejects.toThrow("usage_error");
		expect(output.usageError).toHaveBeenCalled();
	});

	test("goal calls POST /accounts/:playerId/goal with body and long timeout", async () => {
		const body = { type: "ensure-undocked" };
		const { ctx, client } = makeCtx({ status: 200, data: {} }, body);
		await dispatch(ctx, ["goal", "player-123"]);

		expect(client.post).toHaveBeenCalledWith("/accounts/player-123/goal", body, {
			requestTimeoutMs: 0,
		});
	});

	test("goal without body triggers usage error", async () => {
		const { ctx, output } = makeCtx();

		await expect(dispatch(ctx, ["goal", "player-123"])).rejects.toThrow("usage_error");
		expect(output.usageError).toHaveBeenCalled();
	});

	test("goal --async POSTs to /goal/async without timeout override", async () => {
		const body = { type: "ensure-undocked" };
		const { ctx, client } = makeCtx({ status: 202, data: { job_id: "abc123" } }, body);
		ctx.asyncMode = true;
		await dispatch(ctx, ["goal", "player-123"]);

		// Async goals return immediately with a job_id — no long timeout needed.
		expect(client.post).toHaveBeenCalledWith("/accounts/player-123/goal/async", body);
	});

	test("job status calls GET /jobs/:jobId", async () => {
		const { ctx, client } = makeCtx({ status: 200, data: { status: "completed" } });
		await dispatch(ctx, ["job", "status", "abc123"]);

		expect(client.get).toHaveBeenCalledWith("/jobs/abc123");
	});

	test("job status without jobId triggers usage error", async () => {
		const { ctx, output } = makeCtx();

		await expect(dispatch(ctx, ["job", "status"])).rejects.toThrow("usage_error");
		expect(output.usageError).toHaveBeenCalled();
	});

	test("raw without command args triggers usage error", async () => {
		const { ctx, output } = makeCtx();

		await expect(dispatch(ctx, ["raw", "player-123"])).rejects.toThrow("usage_error");
		expect(output.usageError).toHaveBeenCalled();
	});

	test("raw without playerId triggers usage error", async () => {
		const { ctx, output } = makeCtx();

		await expect(dispatch(ctx, ["raw"])).rejects.toThrow("usage_error");
		expect(output.usageError).toHaveBeenCalled();
	});

	test("raw with command args but no binary reports not-found", async () => {
		// In test env, process.execPath is the bun runtime — spacemolt won't be
		// found next to it. Verifies variadic args are accepted and the handler
		// produces a clear error instead of "too many arguments".
		const { ctx, output } = makeCtx();

		await expect(dispatch(ctx, ["raw", "player-123", "help", "market"])).rejects.toThrow(
			"usage_error",
		);
		const callArgs = output.usageError.mock.calls[0];
		expect(callArgs?.[0] as string).toContain("spacemolt CLI not found");
	});

	test("fromStatus is called with response status and data", async () => {
		const { ctx, output } = makeCtx({ status: 404, data: { error: "not found" } });
		await dispatch(ctx, ["health"]);

		expect(output.fromStatus).toHaveBeenCalledWith(404, { error: "not found" });
	});

	test("encodes playerId with special characters", async () => {
		const { ctx, client } = makeCtx();
		await dispatch(ctx, ["accounts", "get", "player with spaces"]);

		expect(client.get).toHaveBeenCalledWith("/accounts/player%20with%20spaces");
	});
});

describe("getUsageText", () => {
	test("includes all command names", () => {
		const usage = getUsageText();
		expect(usage).toContain("status");
		expect(usage).toContain("health");
		expect(usage).toContain("accounts list");
		expect(usage).toContain("accounts get");
		expect(usage).toContain("accounts add");
		expect(usage).toContain("accounts register");
		expect(usage).toContain("accounts remove");
		expect(usage).toContain("state");
		expect(usage).toContain("loop status");
		expect(usage).toContain("loop start");
		expect(usage).toContain("abort");
		expect(usage).toContain("goal");
		expect(usage).toContain("raw");
		expect(usage).toContain("log-level");
		expect(usage).toContain("--port");
	});

	test("includes descriptions for commands", () => {
		const usage = getUsageText();
		expect(usage).toContain("Check daemon health");
		expect(usage).toContain("List all connected accounts");
		expect(usage).toContain("Start a repeating loop");
	});

	test("includes help topic hint", () => {
		const usage = getUsageText();
		expect(usage).toContain("smctl help");
	});
});

describe("help commands", () => {
	test("help outputs usage text", async () => {
		const { ctx, output } = makeCtx();
		await dispatch(ctx, ["help"]);

		expect(output.raw).toHaveBeenCalled();
	});

	test("help goals lists goal types", async () => {
		const { ctx, output } = makeCtx();
		await dispatch(ctx, ["help", "goals"]);

		expect(output.raw).toHaveBeenCalled();
		const text = output.lastRaw as string;
		expect(text).toContain("navigate-to-system");
		expect(text).toContain("buy-items");
		expect(text).toContain("deposit-to-faction-storage");
		expect(text).toContain("unload-at-station");
		expect(text).toContain("Compound Goals");
	});

	test("help loops lists loop types", async () => {
		const { ctx, output } = makeCtx();
		await dispatch(ctx, ["help", "loops"]);

		expect(output.raw).toHaveBeenCalled();
		const text = output.lastRaw as string;
		expect(text).toContain("mining");
		expect(text).toContain("trading");
		expect(text).toContain("hauling");
	});

	test("help mining shows mining loop details including all options", async () => {
		const { ctx, output } = makeCtx();
		await dispatch(ctx, ["help", "mining"]);

		expect(output.raw).toHaveBeenCalled();
		const text = output.lastRaw as string;
		expect(text).toContain("Mining");
		expect(text).toContain("miningSystemId");
		expect(text).toContain("beltPoiId");
		expect(text).toContain("depositTarget");
		expect(text).toContain("cashSource");
		expect(text).toContain("minCredits");
		expect(text).toContain("personal");
		expect(text).toContain("faction");
	});

	test("help trading shows trading loop details", async () => {
		const { ctx, output } = makeCtx();
		await dispatch(ctx, ["help", "trading"]);

		expect(output.raw).toHaveBeenCalled();
		const text = output.lastRaw as string;
		expect(text).toContain("Trading Loop");
		expect(text).toContain("buyStation");
		expect(text).toContain("sellStation");
		expect(text).toContain("maxBuyPrice");
		expect(text).toContain("minSellPrice");
	});

	test("help hauling shows hauling loop details", async () => {
		const { ctx, output } = makeCtx();
		await dispatch(ctx, ["help", "hauling"]);

		expect(output.raw).toHaveBeenCalled();
		const text = output.lastRaw as string;
		expect(text).toContain("Hauling Loop");
		expect(text).toContain("personal-storage");
		expect(text).toContain("faction-storage");
		expect(text).toContain("gift");
		expect(text).toContain("market");
		expect(text).toContain("targetPlayer");
	});

	test("help storage-transfer shows storage transfer loop details", async () => {
		const { ctx, output } = makeCtx();
		await dispatch(ctx, ["help", "storage-transfer"]);

		expect(output.raw).toHaveBeenCalled();
		const text = output.lastRaw as string;
		expect(text).toContain("Storage-Transfer Loop");
		expect(text).toContain("stationPoiId");
		expect(text).toContain("baseId");
		expect(text).toContain("excludeCredits");
		expect(text).toContain("faction storage");
	});

	test("help exploration shows exploration loop details", async () => {
		const { ctx, output } = makeCtx();
		await dispatch(ctx, ["help", "exploration"]);

		expect(output.raw).toHaveBeenCalled();
		const text = output.lastRaw as string;
		expect(text).toContain("Exploration Loop");
		expect(text).toContain("systemId");
		expect(text).toContain("stationPoiId");
		expect(text).toContain("allowLawless");
		expect(text).toContain("minFuelReserve");
		expect(text).toContain("repairThreshold");
		expect(text).toContain("Intel Center");
	});

	test("help salvage shows salvage loop details", async () => {
		const { ctx, output } = makeCtx();
		await dispatch(ctx, ["help", "salvage"]);

		expect(output.raw).toHaveBeenCalled();
		const text = output.lastRaw as string;
		expect(text).toContain("Salvage Loop");
		expect(text).toContain("salvageSystemId");
		expect(text).toContain("salvagePoiId");
		expect(text).toContain("sellSystemId");
		expect(text).toContain("sellStationPoiId");
		expect(text).toContain("sellBaseId");
		expect(text).toContain("fullThreshold");
	});

	test("help guard shows guard loop details", async () => {
		const { ctx, output } = makeCtx();
		await dispatch(ctx, ["help", "guard"]);

		expect(output.raw).toHaveBeenCalled();
		const text = output.lastRaw as string;
		expect(text).toContain("Guard Loop");
		expect(text).toContain("homeSystemId");
		expect(text).toContain("guardSystemId");
		expect(text).toContain("guardPoiId");
		expect(text).toContain("repairThreshold");
	});

	test("help fuel-rescue shows fuel rescue goal details", async () => {
		const { ctx, output } = makeCtx();
		await dispatch(ctx, ["help", "fuel-rescue"]);

		expect(output.raw).toHaveBeenCalled();
		const text = output.lastRaw as string;
		expect(text).toContain("Fuel Rescue");
		expect(text).toContain("systemId");
		expect(text).toContain("poiId");
		expect(text).toContain("targetUsername");
	});

	test("help roaming-salvage shows roaming salvage loop details", async () => {
		const { ctx, output } = makeCtx();
		await dispatch(ctx, ["help", "roaming-salvage"]);

		expect(output.raw).toHaveBeenCalled();
		const text = output.lastRaw as string;
		expect(text).toContain("Roaming Salvage Loop");
		expect(text).toContain("homeSystemId");
		expect(text).toContain("depositTarget");
		expect(text).toContain("allowLawless");
	});

	test("help tow-salvage shows tow salvage loop details", async () => {
		const { ctx, output } = makeCtx();
		await dispatch(ctx, ["help", "tow-salvage"]);

		expect(output.raw).toHaveBeenCalled();
		const text = output.lastRaw as string;
		expect(text).toContain("Tow-Salvage Loop");
		expect(text).toContain("yardSystemId");
		expect(text).toContain("wreckPoiId");
		expect(text).toContain("disposition");
		expect(text).toContain("storageTarget");
	});
});

describe("migrate-ids", () => {
	const tmpFile = "test-id-migration-tmp.json";

	test("reads mapping file and calls POST /migrate-ids", async () => {
		const mapping = { systems: { sol: "sol_prime" }, items: { ore_iron: "iron_ore" } };
		writeFileSync(tmpFile, JSON.stringify(mapping));
		try {
			const { ctx, client } = makeCtx();
			await dispatch(ctx, ["migrate-ids", tmpFile]);
			expect(client.post).toHaveBeenCalledWith("/migrate-ids", mapping);
		} finally {
			unlinkSync(tmpFile);
		}
	});

	test("shows usage error when no file path provided", async () => {
		const { ctx } = makeCtx();
		await expect(dispatch(ctx, ["migrate-ids"])).rejects.toThrow();
	});
});
