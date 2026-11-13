import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Persists accounts added at runtime into `config/dispatcher.json`'s
 * `accountsFilter.usernames`, so the next startup connects them too. Without
 * this an account connected through `POST /accounts` silently drops at the
 * next restart or deploy.
 */

let pending: Promise<unknown> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function addUsername(configDir: string, username: string): Promise<boolean> {
	const path = join(configDir, "dispatcher.json");
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (err) {
		// No config file means no filter: every owned account already connects.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw err;
	}
	const config: unknown = JSON.parse(raw);
	const filter = isRecord(config) ? config["accountsFilter"] : undefined;
	const usernames = isRecord(filter) ? filter["usernames"] : undefined;
	// No username allowlist means every owned account already connects.
	if (!Array.isArray(usernames)) {
		return false;
	}
	const wanted = username.toLowerCase();
	if (usernames.some((u) => typeof u === "string" && u.toLowerCase() === wanted)) {
		return false;
	}
	usernames.push(username);
	const tmp = `${path}.tmp`;
	await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
	await rename(tmp, path);
	return true;
}

/**
 * Add `username` to the startup allowlist. Resolves true if the file changed,
 * false if the account was already listed or there is no username allowlist.
 * Writes are serialized, so concurrent adds can't drop each other's names.
 */
export function rememberAccount(configDir: string, username: string): Promise<boolean> {
	const result = pending.then(() => addUsername(configDir, username));
	pending = result.catch(() => undefined);
	return result;
}
