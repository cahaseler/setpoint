import { describe, expect, test } from "bun:test";
import {
	type MapSystem,
	bfsDistances,
	buildAdjacency,
	hopDistance,
} from "../../src/dispatcher/route-graph.js";

function system(id: string, connections: string[]): MapSystem {
	return { system_id: id, connections, empire: "solarian" } as MapSystem;
}

describe("buildAdjacency", () => {
	test("maps each system_id to its connections", () => {
		const systems = [
			system("sol", ["alpha"]),
			system("alpha", ["sol", "beta"]),
			system("beta", ["alpha"]),
		];
		const adjacency = buildAdjacency(systems);
		expect(adjacency.get("sol")).toEqual(["alpha"]);
		expect(adjacency.get("alpha")).toEqual(["sol", "beta"]);
		expect(adjacency.get("beta")).toEqual(["alpha"]);
	});

	test("defaults to an empty connections list when missing", () => {
		const adjacency = buildAdjacency([{ system_id: "sol" } as MapSystem]);
		expect(adjacency.get("sol")).toEqual([]);
	});
});

describe("bfsDistances", () => {
	test("returns 0 for the start system", () => {
		const adjacency = buildAdjacency([system("sol", [])]);
		expect(bfsDistances(adjacency, "sol").get("sol")).toBe(0);
	});

	test("computes hop counts along a linear chain", () => {
		const systems = [
			system("sol", ["alpha"]),
			system("alpha", ["sol", "beta"]),
			system("beta", ["alpha", "gamma"]),
			system("gamma", ["beta"]),
		];
		const dist = bfsDistances(buildAdjacency(systems), "sol");
		expect(dist.get("sol")).toBe(0);
		expect(dist.get("alpha")).toBe(1);
		expect(dist.get("beta")).toBe(2);
		expect(dist.get("gamma")).toBe(3);
	});

	test("takes the shortest path on a branching graph", () => {
		// sol -- alpha -- gamma
		//  \______________/
		const systems = [
			system("sol", ["alpha", "gamma"]),
			system("alpha", ["sol", "gamma"]),
			system("gamma", ["sol", "alpha"]),
		];
		const dist = bfsDistances(buildAdjacency(systems), "sol");
		expect(dist.get("gamma")).toBe(1);
	});

	test("does not include unreachable systems", () => {
		const systems = [system("sol", ["alpha"]), system("alpha", ["sol"]), system("island", [])];
		const dist = bfsDistances(buildAdjacency(systems), "sol");
		expect(dist.has("island")).toBe(false);
	});
});

describe("hopDistance", () => {
	test("returns the hop count between two connected systems", () => {
		const systems = [
			system("sol", ["alpha"]),
			system("alpha", ["sol", "beta"]),
			system("beta", ["alpha"]),
		];
		expect(hopDistance(systems, "sol", "beta")).toBe(2);
	});

	test("returns 0 for the same system", () => {
		const systems = [system("sol", [])];
		expect(hopDistance(systems, "sol", "sol")).toBe(0);
	});

	test("returns undefined for a disconnected system", () => {
		const systems = [system("sol", ["alpha"]), system("alpha", ["sol"]), system("island", [])];
		expect(hopDistance(systems, "sol", "island")).toBeUndefined();
	});
});
