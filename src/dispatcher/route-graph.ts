import type { GetMapResponse } from "@spacemolt/lib";

// get_map without a system filter returns the full-map variant of the union,
// whose systems entries carry connections, empire, and position data.
export type MapSystem = Extract<GetMapResponse, { systems: unknown }>["systems"][number];

/** Build an adjacency map (system_id → connected system_ids) from a list of map systems. */
export function buildAdjacency(systems: MapSystem[]): Map<string, string[]> {
	const adjacency = new Map<string, string[]>();
	for (const system of systems) {
		adjacency.set(system.system_id, system.connections ?? []);
	}
	return adjacency;
}

/**
 * BFS from startId through the system adjacency graph.
 * Returns a Map of systemId → hop distance from startId.
 */
export function bfsDistances(
	adjacency: Map<string, string[]>,
	startId: string,
): Map<string, number> {
	const dist = new Map<string, number>();
	const queue: string[] = [startId];
	dist.set(startId, 0);

	let i = 0;
	while (i < queue.length) {
		const current = queue[i++];
		if (!current) continue;
		const currentDist = dist.get(current) ?? 0;

		for (const neighbor of adjacency.get(current) ?? []) {
			if (!dist.has(neighbor)) {
				dist.set(neighbor, currentDist + 1);
				queue.push(neighbor);
			}
		}
	}

	return dist;
}

/** Hop-count distance from `fromId` to `toId` through the map's connections, or undefined if unreachable. */
export function hopDistance(
	systems: MapSystem[],
	fromId: string,
	toId: string,
): number | undefined {
	return bfsDistances(buildAdjacency(systems), fromId).get(toId);
}
