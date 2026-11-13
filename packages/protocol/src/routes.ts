import { z } from "zod";

/**
 * One hop of a caller-supplied route: the system to jump into next.
 *
 * A plain system ID is an ordinary jump to an adjacent system. The object form
 * takes a known wormhole instead: `viaWormhole` is the wormhole's entrance POI
 * in the *previous* system, and `systemId` is where it leads. The game accepts
 * a wormhole jump aimed at either the entrance POI or the destination system;
 * setpoint aims at the entrance POI, so the caller decides which wormhole is
 * used when more than one connects the same pair.
 */
export const routeHopSchema = z.union([
	z.string().min(1),
	z.object({ systemId: z.string().min(1), viaWormhole: z.string().min(1) }),
]);

export type RouteHop = z.infer<typeof routeHopSchema>;

/** A caller-supplied route: hops in order, the destination system last. */
export const routeSchema = z.array(routeHopSchema).min(1);

/**
 * Caller-supplied routes for a loop, keyed by destination system ID.
 *
 * Whenever the loop needs to reach a system with an entry here, it flies that
 * route instead of asking the game's `find_route`. The route may list systems
 * before the ship's current one: it is flown from the hop after wherever the
 * ship currently is on it. A ship that is not on the route at all starts from
 * its first hop, and a rejected jump fails the leg with the ship's actual
 * position, rather than re-planning around the caller's choice.
 *
 * Read at the start of every leg, so patching `routes` on a running loop takes
 * effect on its next leg. A destination with no entry uses `find_route`.
 */
export const routesSchema = z.record(z.string(), routeSchema);

export type Routes = z.infer<typeof routesSchema>;

/** The system a hop lands in. */
export function hopSystemId(hop: RouteHop): string {
	return typeof hop === "string" ? hop : hop.systemId;
}
