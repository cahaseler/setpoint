import { afterEach, describe, expect, test } from "bun:test";
import type { MarketUpdateEnvelope } from "@setpoint/protocol";
import { SetpointClient } from "../src/client.js";
import { SetpointHttpError } from "../src/errors.js";

describe("AccountApi.market.events()", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function sseBody(frames: string[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		return new ReadableStream({
			start(controller) {
				for (const frame of frames) controller.enqueue(encoder.encode(frame));
				controller.close();
			},
		});
	}

	function envelope(tick: number): MarketUpdateEnvelope {
		return {
			receivedAt: "2026-10-17T00:00:00.000Z",
			event: {
				base_id: "sol_base",
				tick,
				items: [
					{ item_id: "iron_ore", buy_orders: [{ price_each: 10, quantity: 50 }], sell_orders: [] },
				],
			},
		};
	}

	async function collect(
		iterable: AsyncGenerator<MarketUpdateEnvelope, void, void>,
	): Promise<MarketUpdateEnvelope[]> {
		const items: MarketUpdateEnvelope[] = [];
		for await (const item of iterable) items.push(item);
		return items;
	}

	test("GETs /accounts/:id/market/events and yields each SSE frame parsed", async () => {
		let requestedUrl: string | undefined;
		globalThis.fetch = ((url: string | URL | Request) => {
			requestedUrl = url.toString();
			const body = sseBody([1, 2].map((t) => `data: ${JSON.stringify(envelope(t))}\n\n`));
			return Promise.resolve(new Response(body, { status: 200 }));
		}) as typeof fetch;

		const received = await collect(new SetpointClient().account("Player One").market.events());

		expect(requestedUrl).toBe("http://127.0.0.1:7580/accounts/Player%20One/market/events");
		expect(received.map((e) => e.event.tick)).toEqual([1, 2]);
		expect(received[0]?.event.items[0]?.buy_orders[0]?.price_each).toBe(10);
	});

	test("reassembles a frame split across stream chunks", async () => {
		globalThis.fetch = (() => {
			const full = `data: ${JSON.stringify(envelope(7))}\n\n`;
			const mid = Math.floor(full.length / 2);
			return Promise.resolve(
				new Response(sseBody([full.slice(0, mid), full.slice(mid)]), { status: 200 }),
			);
		}) as unknown as typeof fetch;

		const received = await collect(new SetpointClient().account("Player1").market.events());

		expect(received.map((e) => e.event.tick)).toEqual([7]);
	});

	test("throws SetpointHttpError when the subscription cannot be established", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response(JSON.stringify({ error: "Could not subscribe to the station market" }), {
					status: 409,
				}),
			)) as unknown as typeof fetch;

		await expect(collect(new SetpointClient().account("Player1").market.events())).rejects.toThrow(
			SetpointHttpError,
		);
	});

	test("passes an abort signal through to fetch", async () => {
		let receivedSignal: AbortSignal | undefined;
		globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
			receivedSignal = init?.signal ?? undefined;
			return Promise.resolve(new Response(sseBody([]), { status: 200 }));
		}) as typeof fetch;

		const controller = new AbortController();
		await collect(
			new SetpointClient().account("Player1").market.events({ signal: controller.signal }),
		);

		expect(receivedSignal).toBe(controller.signal);
	});
});
