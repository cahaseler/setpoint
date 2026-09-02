import { describe, expect, test } from "bun:test";
import {
	classifyServerNotice,
	createNoticeRateLimiter,
} from "../../src/accounts/server-notices.js";

describe("classifyServerNotice", () => {
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
