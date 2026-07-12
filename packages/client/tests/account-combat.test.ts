import { afterEach, describe, expect, test } from "bun:test";
import type { CombatEnvelope } from "@setpoint/protocol";
import { SetpointClient } from "../src/client.js";
import { SetpointHttpError } from "../src/errors.js";

describe("AccountApi.combat", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function sseBody(frames: string[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream({
			start(controller) {
				for (const frame of frames) {
					controller.enqueue(encoder.encode(frame));
				}
				controller.close();
			},
		});
	}

	function interruptedEnvelope(battleId: string): CombatEnvelope {
		return {
			receivedAt: "2026-01-01T00:00:00.000Z",
			type: "combat_interrupted",
			payload: { battleId, previousLoopType: "mining" },
		};
	}

	async function collect(
		iterable: AsyncGenerator<CombatEnvelope, void, void>,
	): Promise<CombatEnvelope[]> {
		const items: CombatEnvelope[] = [];
		for await (const item of iterable) items.push(item);
		return items;
	}

	test("events() GETs /accounts/:id/combat/events and yields each SSE frame parsed", async () => {
		let requestedUrl: string | undefined;
		const envelope1 = interruptedEnvelope("b1");
		const envelope2 = interruptedEnvelope("b2");
		globalThis.fetch = ((url: string | URL | Request) => {
			requestedUrl = url.toString();
			const body = sseBody([
				`data: ${JSON.stringify(envelope1)}\n\n`,
				`data: ${JSON.stringify(envelope2)}\n\n`,
			]);
			return Promise.resolve(
				new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
			);
		}) as typeof fetch;

		const client = new SetpointClient();
		const received = await collect(client.account("Player1").combat.events());

		expect(requestedUrl).toBe("http://127.0.0.1:7580/accounts/Player1/combat/events");
		expect(received).toHaveLength(2);
		expect((received[0]?.payload as { battleId: string }).battleId).toBe("b1");
		expect((received[1]?.payload as { battleId: string }).battleId).toBe("b2");
	});

	test("events() reassembles a frame split across multiple stream chunks", async () => {
		const envelope = interruptedEnvelope("b1");
		globalThis.fetch = (() => {
			const full = `data: ${JSON.stringify(envelope)}\n\n`;
			const mid = Math.floor(full.length / 2);
			const body = sseBody([full.slice(0, mid), full.slice(mid)]);
			return Promise.resolve(new Response(body, { status: 200 }));
		}) as unknown as typeof fetch;

		const client = new SetpointClient();
		const received = await collect(client.account("Player1").combat.events());

		expect(received).toHaveLength(1);
		expect((received[0]?.payload as { battleId: string }).battleId).toBe("b1");
	});

	test("events() throws SetpointHttpError for a non-2xx response", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response(JSON.stringify({ error: "Account not found" }), { status: 404 }),
			)) as unknown as typeof fetch;

		const client = new SetpointClient();
		await expect(collect(client.account("missing").combat.events())).rejects.toThrow(
			SetpointHttpError,
		);
	});

	test("events() encodeURIComponent's the account id", async () => {
		let requestedUrl: string | undefined;
		globalThis.fetch = ((url: string | URL | Request) => {
			requestedUrl = url.toString();
			return Promise.resolve(new Response(sseBody([]), { status: 200 }));
		}) as typeof fetch;

		const client = new SetpointClient();
		await collect(client.account("Player One").combat.events());

		expect(requestedUrl).toBe("http://127.0.0.1:7580/accounts/Player%20One/combat/events");
	});

	test("events() passes an abort signal through to fetch", async () => {
		let receivedSignal: AbortSignal | undefined;
		globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
			receivedSignal = init?.signal ?? undefined;
			return Promise.resolve(new Response(sseBody([]), { status: 200 }));
		}) as typeof fetch;

		const client = new SetpointClient();
		const controller = new AbortController();
		await collect(client.account("Player1").combat.events({ signal: controller.signal }));

		expect(receivedSignal).toBe(controller.signal);
	});
});
