import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { accountLogLabel, withAccountLogging } from "../../src/accounts/log-subject.js";
import { createLogger, setLogLevel, withLogSubject } from "../../src/util/logger.js";

describe("log subject", () => {
	const originalWarn = console.warn;
	let lines: string[];

	beforeEach(() => {
		lines = [];
		console.warn = mock((...args: unknown[]) => {
			lines.push(String(args[0]));
		});
		setLogLevel("debug");
	});

	afterEach(() => {
		console.warn = originalWarn;
		setLogLevel("info");
	});

	const log = createLogger("goal:ensure-fueled");

	test("a line logged inside a subject carries it after the module tag", () => {
		withLogSubject(
			() => "ILC Anneal / Crucible",
			() => log.warn("Refuel skipped"),
		);

		expect(lines[0]).toMatch(
			/\[WARN\] \[goal:ensure-fueled\] \[ILC Anneal \/ Crucible\] Refuel skipped$/,
		);
	});

	test("a line logged outside any subject is unchanged", () => {
		log.warn("Refuel skipped");

		expect(lines[0]).toMatch(/\[WARN\] \[goal:ensure-fueled\] Refuel skipped$/);
	});

	test("the subject follows the work through awaits and timers", async () => {
		await withLogSubject(
			() => "Walter Davis / Lantern",
			async () => {
				await Promise.resolve();
				await new Promise<void>((resolve) => setTimeout(resolve, 1));
				log.warn("deep inside a goal");
			},
		);

		expect(lines[0]).toContain("[Walter Davis / Lantern] deep inside a goal");
	});

	test("concurrent work for two accounts stays separately labelled", async () => {
		const run = (label: string, delayMs: number): Promise<void> =>
			withLogSubject(
				() => label,
				async () => {
					await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
					log.warn(`done ${label}`);
				},
			);

		await Promise.all([run("A / one", 5), run("B / two", 1)]);

		expect(lines.find((l) => l.endsWith("done A / one"))).toContain("[A / one]");
		expect(lines.find((l) => l.endsWith("done B / two"))).toContain("[B / two]");
	});

	test("the label is read when the line is logged, so a ship swap shows", () => {
		let ship = "Crucible";
		withLogSubject(
			() => `ILC Anneal / ${ship}`,
			() => {
				log.warn("before");
				ship = "Anvil";
				log.warn("after");
			},
		);

		expect(lines[0]).toContain("[ILC Anneal / Crucible] before");
		expect(lines[1]).toContain("[ILC Anneal / Anvil] after");
	});

	test("a describer that throws drops the tag, never the line", () => {
		withLogSubject(
			() => {
				throw new Error("account gone");
			},
			() => log.warn("still logged"),
		);

		expect(lines[0]).toMatch(/\[goal:ensure-fueled\] still logged$/);
	});

	test("withAccountLogging labels lines with the account and its ship", () => {
		const account = {
			id: "Carol Jordan",
			state: { ship: { name: "Wayfarer", class_id: "prospector" } },
		};

		withAccountLogging(
			() => account,
			() => log.warn("low fuel"),
		);

		expect(lines[0]).toContain("[Carol Jordan / Wayfarer] low fuel");
	});
});

describe("accountLogLabel", () => {
	test("username and ship name", () => {
		expect(accountLogLabel({ id: "ILC Anneal", state: { ship: { name: "Crucible" } } })).toBe(
			"ILC Anneal / Crucible",
		);
	});

	test("falls back to the ship class when the ship has no name", () => {
		expect(
			accountLogLabel({ id: "ILC Anneal", state: { ship: { class_id: "merchantman" } } }),
		).toBe("ILC Anneal / merchantman");
	});

	test("falls back to the player's username when the account has no id", () => {
		expect(accountLogLabel({ state: { player: { username: "Walter Davis" } } })).toBe(
			"Walter Davis",
		);
	});

	test("no label at all when nothing names the account", () => {
		expect(accountLogLabel({ state: {} })).toBeUndefined();
	});
});
