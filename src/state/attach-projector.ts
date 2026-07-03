import type { StateSection } from "@spacemolt/lib";
import type { LibAccountLike } from "../accounts/lib-types.js";
import type { StateProjector } from "./projector.js";

/**
 * Build the `LibAccountManager` onStateChange handler that projects each change
 * into SQLite via the given projector. Reads the changed sections from the
 * account's live cache at emit time.
 */
export function makeProjectingOnStateChange(
	projector: StateProjector,
): (playerId: string, changed: StateSection[], account: LibAccountLike) => void {
	return (playerId, changed, account) => {
		projector.project(playerId, account.state, changed);
	};
}
