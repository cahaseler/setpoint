import { afterEach, describe, expect, test } from "bun:test";
import type {
	ObservationSnapshot,
	ObservationUpdateEnvelope,
	ObservationUpdateEvent,
} from "@setpoint/protocol";
import { SetpointClient } from "../src/client.js";
import { SetpointHttpError } from "../src/errors.js";

describe("AccountApi.observation", () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls: Array<{ url: string; method: string | undefined }>;

	function mockFetchSequence(responses: Array<{ status: number; body: unknown }>): void {
		fetchCalls = [];
		let call = 0;
		globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: url.toString(), method: init?.method });
			const next = responses[Math.min(call, responses.length - 1)];
			call++;
			return Promise.resolve(
				new Response(JSON.stringify(next?.body), {
					status: next?.status ?? 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as typeof fetch;
	}

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const view: ObservationSnapshot = {
		poi_id: "sol_station",
		system_id: "sol",
		tick: 3,
		nearby: [{ player_id: "p2", username: "Other", in_combat: false }],
		system: [],
		cloaked: [],
		unknownSignature: false,
		activeScan: true,
	};

	test("get() GETs /accounts/:id/observation", async () => {
		mockFetchSequence([{ status: 200, body: view }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").observation.get();

		expect(result).toEqual(view);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/observation");
		expect(fetchCalls[0]?.method).toBe("GET");
	});

	test("get() encodeURIComponent's the account id", async () => {
		mockFetchSequence([{ status: 200, body: view }]);
		const client = new SetpointClient();

		await client.account("Player One").observation.get();

		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player%20One/observation");
	});

	describe("events()", () => {
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

		function observationEvent(tick: number): ObservationUpdateEvent {
			return {
				poi_id: "sol_station",
				system_id: "sol",
				tick,
				unknown_signature: false,
				pirates_changed: [
					{
						pirate_id: "pirate_1",
						name: "Raider",
						is_boss: false,
						status: "hostile",
						tier: "raider",
					},
				],
			} as ObservationUpdateEvent;
		}

		async function collect(
			iterable: AsyncGenerator<ObservationUpdateEnvelope, void, void>,
		): Promise<ObservationUpdateEnvelope[]> {
			const items: ObservationUpdateEnvelope[] = [];
			for await (const item of iterable) items.push(item);
			return items;
		}

		test("GETs /accounts/:id/observation/events and yields each SSE frame parsed", async () => {
			let requestedUrl: string | undefined;
			const envelopes: ObservationUpdateEnvelope[] = [
				{ receivedAt: "2026-01-01T00:00:00.000Z", event: observationEvent(1) },
				{ receivedAt: "2026-01-01T00:00:10.000Z", event: observationEvent(2) },
			];
			globalThis.fetch = ((url: string | URL | Request) => {
				requestedUrl = url.toString();
				const body = sseBody(envelopes.map((e) => `data: ${JSON.stringify(e)}\n\n`));
				return Promise.resolve(
					new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
				);
			}) as typeof fetch;

			const client = new SetpointClient();
			const received = await collect(client.account("Player1").observation.events());

			expect(requestedUrl).toBe("http://127.0.0.1:7580/accounts/Player1/observation/events");
			expect(received.map((e) => e.event.tick)).toEqual([1, 2]);
		});

		test("carries the pirate arrays the merged snapshot drops", async () => {
			globalThis.fetch = (() =>
				Promise.resolve(
					new Response(
						sseBody([
							`data: ${JSON.stringify({
								receivedAt: "2026-01-01T00:00:00.000Z",
								event: observationEvent(1),
							})}\n\n`,
						]),
						{ status: 200 },
					),
				)) as unknown as typeof fetch;

			const client = new SetpointClient();
			const received = await collect(client.account("Player1").observation.events());

			expect(received[0]?.event.pirates_changed?.[0]?.pirate_id).toBe("pirate_1");
		});

		test("appends activeScan=true to the query when asked for a sweep", async () => {
			let requestedUrl: string | undefined;
			globalThis.fetch = ((url: string | URL | Request) => {
				requestedUrl = url.toString();
				return Promise.resolve(new Response(sseBody([]), { status: 200 }));
			}) as typeof fetch;

			const client = new SetpointClient();
			await collect(client.account("Player1").observation.events({ activeScan: true }));

			expect(requestedUrl).toBe(
				"http://127.0.0.1:7580/accounts/Player1/observation/events?activeScan=true",
			);
		});

		test("omits the query entirely when no sweep is asked for", async () => {
			let requestedUrl: string | undefined;
			globalThis.fetch = ((url: string | URL | Request) => {
				requestedUrl = url.toString();
				return Promise.resolve(new Response(sseBody([]), { status: 200 }));
			}) as typeof fetch;

			const client = new SetpointClient();
			await collect(client.account("Player1").observation.events({ activeScan: false }));

			expect(requestedUrl).toBe("http://127.0.0.1:7580/accounts/Player1/observation/events");
		});

		test("reassembles a frame split across multiple stream chunks", async () => {
			globalThis.fetch = (() => {
				const full = `data: ${JSON.stringify({
					receivedAt: "2026-01-01T00:00:00.000Z",
					event: observationEvent(9),
				})}\n\n`;
				const mid = Math.floor(full.length / 2);
				return Promise.resolve(
					new Response(sseBody([full.slice(0, mid), full.slice(mid)]), { status: 200 }),
				);
			}) as unknown as typeof fetch;

			const client = new SetpointClient();
			const received = await collect(client.account("Player1").observation.events());

			expect(received.map((e) => e.event.tick)).toEqual([9]);
		});

		test("throws SetpointHttpError when the watch cannot be established", async () => {
			globalThis.fetch = (() =>
				Promise.resolve(
					new Response(
						JSON.stringify({ error: "Could not subscribe to the observation watch: in transit" }),
						{ status: 409 },
					),
				)) as unknown as typeof fetch;

			const client = new SetpointClient();
			await expect(collect(client.account("Player1").observation.events())).rejects.toThrow(
				SetpointHttpError,
			);
		});

		test("encodeURIComponent's the account id", async () => {
			let requestedUrl: string | undefined;
			globalThis.fetch = ((url: string | URL | Request) => {
				requestedUrl = url.toString();
				return Promise.resolve(new Response(sseBody([]), { status: 200 }));
			}) as typeof fetch;

			const client = new SetpointClient();
			await collect(client.account("Player One").observation.events());

			expect(requestedUrl).toBe("http://127.0.0.1:7580/accounts/Player%20One/observation/events");
		});

		test("passes an abort signal through to fetch", async () => {
			let receivedSignal: AbortSignal | undefined;
			globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
				receivedSignal = init?.signal ?? undefined;
				return Promise.resolve(new Response(sseBody([]), { status: 200 }));
			}) as typeof fetch;

			const client = new SetpointClient();
			const controller = new AbortController();
			await collect(client.account("Player1").observation.events({ signal: controller.signal }));

			expect(receivedSignal).toBe(controller.signal);
		});
	});
});
