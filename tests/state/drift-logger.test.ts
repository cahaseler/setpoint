import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { logDrift } from "../../src/state/drift-logger.js";

describe("logDrift", () => {
	afterEach(() => {
		(console.info as unknown as { mockRestore?: () => void }).mockRestore?.();
	});

	test("logs nothing when there are no drifts", () => {
		const spy = spyOn(console, "info");
		logDrift({ playerId: "p1", username: "Alpha", drifts: [] });
		expect(spy).not.toHaveBeenCalled();
	});

	test("logs one line naming the account and every drifted path", () => {
		const spy = spyOn(console, "info");
		logDrift({
			playerId: "p1",
			username: "Alpha",
			drifts: [{ section: "player", path: "credits", before: 100, after: 150 }],
		});

		expect(spy).toHaveBeenCalledTimes(1);
		const line = spy.mock.calls[0]?.[0] as string;
		expect(line).toContain("[Alpha]");
		expect(line).toContain("player.credits");
	});

	test("falls back to playerId when username is unavailable", () => {
		const spy = spyOn(console, "info");
		logDrift({
			playerId: "p1",
			username: undefined,
			drifts: [{ section: "ship", path: "hull", before: 40, after: 35 }],
		});

		const line = spy.mock.calls[0]?.[0] as string;
		expect(line).toContain("[p1]");
	});
});
