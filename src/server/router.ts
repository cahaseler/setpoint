import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("server");

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

/** Extracted URL parameters from route matching. */
export type RouteParams = Record<string, string>;

/** Handler function for a matched route. */
export type RouteHandler<Ctx> = (
	req: Request,
	params: RouteParams,
	ctx: Ctx,
) => Response | Promise<Response>;

/** A registered route definition. */
export interface Route<Ctx> {
	method: string;
	pattern: string;
	handler: RouteHandler<Ctx>;
}

/** Compiled route with regex for matching. */
interface CompiledRoute<Ctx> {
	method: string;
	regex: RegExp;
	paramNames: string[];
	handler: RouteHandler<Ctx>;
}

/**
 * Compile a route pattern like "/accounts/:playerId/state" into a regex.
 * Supports `:param` segments that match any non-slash characters.
 */
function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
	const paramNames: string[] = [];
	// Support trailing /* for catch-all routes
	const isWildcard = pattern.endsWith("/*");
	const base = isWildcard ? pattern.slice(0, -2) : pattern;
	const regexStr = base.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
		paramNames.push(name);
		return "([^/]+)";
	});
	const suffix = isWildcard ? "(?:/.*)?$" : "$";
	return { regex: new RegExp(`^${regexStr}${suffix}`), paramNames };
}

/**
 * Simple pattern-matching router for Bun.serve.
 *
 * Routes are matched in registration order. First match wins.
 * Supports :param segments in patterns.
 */
export class Router<Ctx> {
	private readonly routes: CompiledRoute<Ctx>[] = [];

	/** Register a route. */
	add(method: string, pattern: string, handler: RouteHandler<Ctx>): void {
		const { regex, paramNames } = compilePattern(pattern);
		this.routes.push({ method: method.toUpperCase(), regex, paramNames, handler });
	}

	/** Convenience methods. */
	get(pattern: string, handler: RouteHandler<Ctx>): void {
		this.add("GET", pattern, handler);
	}

	post(pattern: string, handler: RouteHandler<Ctx>): void {
		this.add("POST", pattern, handler);
	}

	patch(pattern: string, handler: RouteHandler<Ctx>): void {
		this.add("PATCH", pattern, handler);
	}

	delete(pattern: string, handler: RouteHandler<Ctx>): void {
		this.add("DELETE", pattern, handler);
	}

	/**
	 * Handle an incoming request. Returns a Response.
	 * If no route matches, returns 404.
	 */
	async handle(req: Request, ctx: Ctx): Promise<Response> {
		const url = new URL(req.url);
		const method = req.method.toUpperCase();
		const pathname = url.pathname;

		for (const route of this.routes) {
			if (route.method !== method) {
				continue;
			}

			const match = route.regex.exec(pathname);
			if (!match) {
				continue;
			}

			const params: RouteParams = {};
			for (let i = 0; i < route.paramNames.length; i++) {
				const name = route.paramNames[i];
				const value = match[i + 1];
				if (name && value) {
					params[name] = decodeURIComponent(value);
				}
			}

			log.info(`${method} ${pathname}`);

			try {
				return await route.handler(req, params, ctx);
			} catch (err) {
				log.error(`Handler error: ${errorMessage(err)}`);
				return errorResponse("Internal server error", 500);
			}
		}

		return errorResponse("Not found", 404);
	}
}
