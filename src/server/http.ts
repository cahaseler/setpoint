/**
 * Response builders and handler types shared by every route.
 *
 * Route matching itself is Bun's — see `buildRoutes` in `index.ts`, which
 * hands `Bun.serve` a `routes` table and reads `:param` segments off
 * `req.params`.
 */

/** Build a JSON success response. */
export function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Build a JSON error response. */
export function errorResponse(message: string, status = 400): Response {
	return jsonResponse({ error: message }, status);
}

/** URL parameters extracted from a matched route's `:param` segments. */
export type RouteParams = Record<string, string>;

/** Handler function for a matched route. */
export type RouteHandler<Ctx> = (
	req: Request,
	params: RouteParams,
	ctx: Ctx,
) => Response | Promise<Response>;
