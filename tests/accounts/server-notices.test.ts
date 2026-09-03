import { describe, expect, test } from "bun:test";
import {
	classifyServerNotice,
	createNoticeRateLimiter,
} from "../../src/accounts/server-notices.js";

describe("classifyServerNotice", () => {
	test("picks out a server_restart_warning and leads with the countdown", () => {
		const notice = classifyServerNotice("server_restart_warning", {
			message: "Server restarting for deploy",
			seconds_until_restart: 30,
			target_version: "v0.573.1",
		});
		expect(notice?.kind).toBe("server-lifecycle");
		expect(notice?.type).toBe("server_restart_warning");
		expect(notice?.summary).toBe("restart in 30s (\u2192 v0.573.1): Server restarting for deploy");
	});

	test("handles a server_restart_warning with no target_version", () => {
		const notice = classifyServerNotice("server_restart_warning", {
			message: "Server restarting",
			seconds_until_restart: 10,
		});
		expect(notice?.summary).toBe("restart in 10s: Server restarting");
	});

	test("falls back to the raw payload if the restart warning has an unexpected shape", () => {
		const notice = classifyServerNotice("server_restart_warning", { unexpected: true });
		expect(notice?.kind).toBe("server-lifecycle");
		expect(notice?.summary).toBe('{"unexpected":true}');
	});

	test("picks out a system-channel chat message", () => {
		const notice = classifyServerNotice("chat_message", {
			channel: "system",
			sender: "SpaceMolt",
			content: "Server restarting in 30 seconds",
		});
		expect(notice?.kind).toBe("server-chat");
		expect(notice?.type).toBe("chat_message");
		expect(notice?.summary).toContain("Server restarting in 30 seconds");
		expect(notice?.summary).toContain("system");
	});

	test("picks out an admin-channel chat message", () => {
		const notice = classifyServerNotice("chat_message", {
			channel: "admin",
			content: "hold onto your pants",
		});
		expect(notice?.kind).toBe("server-chat");
		expect(notice?.summary).toContain("hold onto your pants");
	});

	test("matches the channel case-insensitively", () => {
		expect(
			classifyServerNotice("chat_message", { channel: "SYSTEM", content: "x" }),
		).not.toBeNull();
	});

	test("picks out an empire_official message on any channel", () => {
		// The server sets this flag itself and a player client cannot spoof it,
		// so it's worth surfacing even on a channel we'd otherwise skip.
		const notice = classifyServerNotice("chat_message", {
			channel: "global",
			empire_official: true,
			content: "official announcement",
		});
		expect(notice?.kind).toBe("server-chat");
	});

	test("ignores ordinary player chat", () => {
		for (const channel of ["global", "local", "faction", "private"]) {
			expect(classifyServerNotice("chat_message", { channel, content: "hi" })).toBeNull();
		}
	});

	test("ignores chat with no channel and no official flag", () => {
		expect(classifyServerNotice("chat_message", { content: "hi" })).toBeNull();
	});

	test("ignores documented gameplay pushes", () => {
		// These are the high-volume types that would bury the signal.
		for (const type of ["mining_yield", "market_update", "crafting_update", "battle_damage"]) {
			expect(classifyServerNotice(type, { anything: true })).toBeNull();
		}
	});

	test("ignores uncorrelated protocol envelope frames", () => {
		for (const type of ["result", "action_result", "action_error", "error", "logged_in"]) {
			expect(classifyServerNotice(type, {})).toBeNull();
		}
	});

	test("ignores the per-action 'ok' acknowledgement", () => {
		// The highest-volume untyped frame in production: the ack for a mutation
		// this account asked for, not something the server is announcing.
		expect(
			classifyServerNotice("ok", { action: "jump", arrival_tick: 1, destination: "sol" }),
		).toBeNull();
		expect(classifyServerNotice("ok", { action: "dock", base: "Ironlight Crossroads" })).toBeNull();
	});

	test("reports an undocumented push type", () => {
		// The shape a restart warning would take if it ships as its own
		// msg_type rather than riding on chat.
		const notice = classifyServerNotice("server_restart", { seconds: 30 });
		expect(notice?.kind).toBe("undocumented-push");
		expect(notice?.type).toBe("server_restart");
		expect(notice?.summary).toBe('{"seconds":30}');
	});

	test("truncates an oversized payload", () => {
		const notice = classifyServerNotice("server_restart", { blob: "x".repeat(2000) });
		expect(notice?.summary.length).toBeLessThanOrEqual(501);
		expect(notice?.summary.endsWith("…")).toBe(true);
	});

	test("survives an unserializable payload", () => {
		const circular: Record<string, unknown> = {};
		circular["self"] = circular;
		const notice = classifyServerNotice("server_restart", circular);
		expect(notice?.summary).toBe("<unserializable payload>");
	});

	test("survives a non-object payload", () => {
		expect(classifyServerNotice("chat_message", "not-an-object")).toBeNull();
		expect(classifyServerNotice("server_restart", undefined)?.kind).toBe("undocumented-push");
	});
});

describe("createNoticeRateLimiter", () => {
	test("admits the first occurrence with no suppressed duplicates", () => {
		const limiter = createNoticeRateLimiter({ windowMs: 1000 });
		expect(limiter.admit("server_restart", 0)).toBe(0);
	});

	test("suppresses duplicates inside the window", () => {
		const limiter = createNoticeRateLimiter({ windowMs: 1000 });
		limiter.admit("server_restart", 0);
		expect(limiter.admit("server_restart", 100)).toBeNull();
		expect(limiter.admit("server_restart", 999)).toBeNull();
	});

	test("admits again after the window and reports the suppressed count", () => {
		const limiter = createNoticeRateLimiter({ windowMs: 1000 });
		limiter.admit("server_restart", 0);
		limiter.admit("server_restart", 10);
		limiter.admit("server_restart", 20);
		expect(limiter.admit("server_restart", 1000)).toBe(2);
		// The count resets once reported.
		expect(limiter.admit("server_restart", 2000)).toBe(0);
	});

	test("tracks each msg_type independently", () => {
		const limiter = createNoticeRateLimiter({ windowMs: 1000 });
		expect(limiter.admit("server_restart", 0)).toBe(0);
		expect(limiter.admit("chat_message", 0)).toBe(0);
		expect(limiter.admit("server_restart", 10)).toBeNull();
	});
});
