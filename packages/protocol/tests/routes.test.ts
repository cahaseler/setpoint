import { describe, expect, test } from "bun:test";
import { hopSystemId, loopSchemas, routesSchema } from "../src/index.js";

describe("routes schema", () => {
	test("accepts system IDs and wormhole hops, keyed by destination", () => {
		const routes = {
			lhs_1140: ["sol", "ross_128", "lhs_1140"],
			fang: ["sol", { systemId: "fang", viaWormhole: "wh_entrance_0365fe63" }],
		};
		expect(routesSchema.parse(routes)).toEqual(routes);
	});

	test("rejects an empty route and a wormhole hop missing its entrance", () => {
		expect(() => routesSchema.parse({ vega: [] })).toThrow();
		expect(() => routesSchema.parse({ fang: [{ systemId: "fang" }] })).toThrow();
	});

	test("every loop type accepts routes", () => {
		for (const [type, schema] of Object.entries(loopSchemas)) {
			const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
			expect(shape).toHaveProperty("routes");
			expect(type).toBeTruthy();
		}
	});

	test("hopSystemId reads either form", () => {
		expect(hopSystemId("vega")).toBe("vega");
		expect(hopSystemId({ systemId: "fang", viaWormhole: "wh_1" })).toBe("fang");
	});
});
