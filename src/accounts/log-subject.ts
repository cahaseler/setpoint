/**
 * Names an account in log lines: the username and the ship it is flying.
 *
 * Both, because a log monitor filters on either: by account to separate one
 * operator's fleet from another's, by ship to pick out a class of vessel.
 */

import { withLogSubject } from "../util/logger.js";

/** The slice of an account the label reads. */
export interface LabelledAccount {
	readonly id?: string | undefined;
	readonly state: {
		readonly player?: { readonly username?: string | undefined } | undefined;
		readonly ship?:
			| { readonly name?: string | undefined; readonly class_id?: string | undefined }
			| undefined;
	};
}

/** `"ILC Anneal / Crucible"` — username, then ship name (or class when unnamed). */
export function accountLogLabel(account: LabelledAccount): string | undefined {
	const name = account.id ?? account.state.player?.username;
	if (!name) return undefined;
	const ship = account.state.ship?.name ?? account.state.ship?.class_id;
	return ship ? `${name} / ${ship}` : name;
}

/**
 * Run `fn` with every log line beneath it naming this account and its ship.
 * Takes a resolver, not the account, because an account's instance can be
 * replaced on reconnect; the label is read from whichever is current.
 */
export function withAccountLogging<T>(resolveAccount: () => LabelledAccount, fn: () => T): T {
	return withLogSubject(() => accountLogLabel(resolveAccount()), fn);
}
