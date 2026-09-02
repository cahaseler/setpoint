/**
 * Recursive partial, for test fixtures that seed game state.
 *
 * The lib's generated game-state types mark most fields required, because a
 * real server payload always carries them. A test that only cares about
 * `location.docked_at` should not have to spell out the other seventeen
 * fields of `V2Location` to compile, so the fakes accept `DeepPartial` of the
 * real type and cast internally at the seam.
 *
 * This stays honest about typos: the mapped type still constrains keys to
 * `keyof T`, so a fixture naming a field that doesn't exist — or giving one
 * the wrong type — is still a compile error. What it relaxes is only
 * completeness, which is exactly the part a fixture is entitled to skip.
 */
export type DeepPartial<T> = T extends (infer U)[]
	? Array<DeepPartial<U>>
	: T extends object
		? { [K in keyof T]?: DeepPartial<T[K]> }
		: T;

/**
 * Cast a fixture to the full type at a call boundary. Use where a test hands
 * partial state to a production signature that legitimately requires the
 * complete type — the narrowing is the fixture's shortcut, not the
 * production code's.
 */
export const partial = <T>(value: DeepPartial<T>): T => value as T;
