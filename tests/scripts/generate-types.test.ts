import { describe, expect, test } from "bun:test";
import { dedupeOperationIds } from "../../scripts/generate-types";

describe("dedupeOperationIds", () => {
	test("returns no renames when all operationIds are unique", () => {
		const spec = {
			paths: {
				"/a": { get: { operationId: "a_get" }, post: { operationId: "a_post" } },
				"/b": { post: { operationId: "b_post" } },
			},
		};
		const renames = dedupeOperationIds(spec);
		expect(renames).toEqual([]);
		expect(spec.paths["/a"].get.operationId).toBe("a_get");
	});

	test("renames the second occurrence with a method suffix, keeping the first", () => {
		const spec = {
			paths: {
				"/help": {
					get: { operationId: "group_help" },
					post: { operationId: "group_help" },
				},
			},
		};
		const renames = dedupeOperationIds(spec);
		expect(renames).toEqual([
			{ path: "/help", method: "post", from: "group_help", to: "group_help_post" },
		]);
		expect(spec.paths["/help"].get.operationId).toBe("group_help");
		expect(spec.paths["/help"].post.operationId).toBe("group_help_post");
	});

	test("avoids colliding with an existing operationId when renaming", () => {
		const spec = {
			paths: {
				"/help": {
					get: { operationId: "group_help" },
					post: { operationId: "group_help" },
				},
				"/other": { post: { operationId: "group_help_post" } },
			},
		};
		const renames = dedupeOperationIds(spec);
		expect(renames).toHaveLength(1);
		const rename = renames[0];
		expect(rename?.to).toBe("group_help_post_");
		const ids = [
			spec.paths["/help"].get.operationId,
			spec.paths["/help"].post.operationId,
			spec.paths["/other"].post.operationId,
		];
		expect(new Set(ids).size).toBe(3);
	});

	test("ignores operations without operationId and non-operation entries", () => {
		const spec = {
			paths: {
				"/a": { get: {}, parameters: ["ref"] as unknown as Record<string, unknown> },
			},
		} as { paths: Record<string, Record<string, unknown>> };
		expect(dedupeOperationIds(spec)).toEqual([]);
	});

	test("handles a spec with no paths", () => {
		expect(dedupeOperationIds({})).toEqual([]);
	});
});
