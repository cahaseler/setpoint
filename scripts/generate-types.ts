/**
 * Generates src/generated/api-types.ts from the SpaceMolt OpenAPI spec.
 *
 * The spec is read from the vendored openapi/spacemolt-v2.json when present,
 * and otherwise fetched from the live endpoint (the public distribution does
 * not vendor the spec). The generated types are committed, so a normal build
 * needs no network access — only regenerating types does.
 *
 * The live spec currently violates OpenAPI 3.0.3 by reusing one operationId
 * for both GET and POST on the battle/fleet/storage /help paths (reported
 * upstream). openapi-typescript faithfully emits duplicate identifiers from
 * that, so we dedupe operationIds in memory before generation. Once the
 * upstream fix lands, the dedupe pass finds no collisions and becomes a no-op.
 */
import openapiTS, { COMMENT_HEADER, astToString } from "openapi-typescript";

const LIVE_SPEC_URL = "https://game.spacemolt.com/api/v2/openapi.json";

interface OperationLike {
	operationId?: string;
}

/**
 * Renames colliding operationIds in place by suffixing the HTTP method
 * (e.g. spacemolt_battle_help → spacemolt_battle_help_post). The first
 * occurrence keeps its original id. Returns the renames performed.
 */
export function dedupeOperationIds(spec: {
	paths?: Record<string, Record<string, unknown>>;
}): { path: string; method: string; from: string; to: string }[] {
	const operations: { path: string; method: string; operation: OperationLike }[] = [];
	for (const [path, methods] of Object.entries(spec.paths ?? {})) {
		for (const [method, op] of Object.entries(methods)) {
			if (typeof op === "object" && op !== null) {
				operations.push({ path, method, operation: op as OperationLike });
			}
		}
	}
	const allIds = new Set<string>();
	for (const { operation } of operations) {
		if (operation.operationId !== undefined) {
			allIds.add(operation.operationId);
		}
	}
	const seen = new Set<string>();
	const renames: { path: string; method: string; from: string; to: string }[] = [];
	for (const { path, method, operation } of operations) {
		const id = operation.operationId;
		if (id === undefined) {
			continue;
		}
		if (!seen.has(id)) {
			seen.add(id);
			continue;
		}
		let candidate = `${id}_${method}`;
		while (allIds.has(candidate) || seen.has(candidate)) {
			candidate = `${candidate}_`;
		}
		operation.operationId = candidate;
		allIds.add(candidate);
		seen.add(candidate);
		renames.push({ path, method, from: id, to: candidate });
	}
	return renames;
}

/**
 * Load the OpenAPI spec, preferring the vendored copy and falling back to the
 * live endpoint when it is absent (e.g. in the public, spec-less distribution).
 */
async function loadSpec() {
	const specFile = Bun.file(new URL("../openapi/spacemolt-v2.json", import.meta.url));
	if (await specFile.exists()) {
		return specFile.json();
	}
	console.warn(`[generate-types] no vendored spec found — fetching ${LIVE_SPEC_URL}`);
	const res = await fetch(LIVE_SPEC_URL);
	if (!res.ok) {
		throw new Error(`Failed to fetch live spec: ${res.status} ${res.statusText}`);
	}
	return res.json();
}

async function main(): Promise<void> {
	const spec = await loadSpec();
	const renames = dedupeOperationIds(spec);
	for (const rename of renames) {
		console.warn(
			`[generate-types] duplicate operationId '${rename.from}' on ${rename.method.toUpperCase()} ${rename.path} renamed to '${rename.to}'`,
		);
	}
	const ast = await openapiTS(spec);
	const output = COMMENT_HEADER + astToString(ast);
	const outPath = new URL("../src/generated/api-types.ts", import.meta.url);
	await Bun.write(outPath, output);
	console.log(`[generate-types] wrote ${outPath.pathname}`);
}

if (import.meta.main) {
	await main();
}
