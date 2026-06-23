import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("config");

/** Registration code shared across all accounts for a user. */
export interface RegistrationConfig {
	registration_code: string;
}

/** Credentials for a single account, matching the API registration response format. */
export interface AccountConfig {
	username: string;
	password: string;
	player_id: string;
}

/** Validated config for the entire service. */
export interface DispatcherConfig {
	registration: RegistrationConfig;
	accounts: AccountConfig[];
}

/** Errors during config loading. */
export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate and parse a registration config object. */
export function parseRegistrationConfig(data: unknown): RegistrationConfig {
	if (!isRecord(data)) {
		throw new ConfigError("Registration config must be a JSON object");
	}

	if (typeof data["registration_code"] !== "string" || data["registration_code"].length === 0) {
		throw new ConfigError("Registration config must have a non-empty 'registration_code' string");
	}

	return { registration_code: data["registration_code"] };
}

/** Validate and parse a credentials-only object (username + password, no player_id). */
export function parseAccountCredentials(
	data: unknown,
	filename: string,
): { username: string; password: string } {
	if (!isRecord(data)) {
		throw new ConfigError(`Account config '${filename}' must be a JSON object`);
	}

	if (typeof data["username"] !== "string" || data["username"].length === 0) {
		throw new ConfigError(`Account config '${filename}' must have a non-empty 'username' string`);
	}

	if (typeof data["password"] !== "string" || data["password"].length === 0) {
		throw new ConfigError(`Account config '${filename}' must have a non-empty 'password' string`);
	}

	return {
		username: data["username"],
		password: data["password"],
	};
}

/** Validate and parse an account config object. */
export function parseAccountConfig(data: unknown, filename: string): AccountConfig {
	if (!isRecord(data)) {
		throw new ConfigError(`Account config '${filename}' must be a JSON object`);
	}

	if (typeof data["username"] !== "string" || data["username"].length === 0) {
		throw new ConfigError(`Account config '${filename}' must have a non-empty 'username' string`);
	}

	if (typeof data["password"] !== "string" || data["password"].length === 0) {
		throw new ConfigError(`Account config '${filename}' must have a non-empty 'password' string`);
	}

	if (typeof data["player_id"] !== "string" || data["player_id"].length === 0) {
		throw new ConfigError(`Account config '${filename}' must have a non-empty 'player_id' string`);
	}

	return {
		username: data["username"],
		password: data["password"],
		player_id: data["player_id"],
	};
}

/** Load and validate the registration config from a file path. */
export async function loadRegistrationConfig(filePath: string): Promise<RegistrationConfig> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf-8");
	} catch (err) {
		throw new ConfigError(
			`Could not read registration config at '${filePath}': ${errorMessage(err)}`,
		);
	}

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new ConfigError(`Registration config at '${filePath}' is not valid JSON`);
	}

	return parseRegistrationConfig(data);
}

/** Load and validate all account configs from a directory. */
export async function loadAccountConfigs(dirPath: string): Promise<AccountConfig[]> {
	let entries: string[];
	try {
		entries = await readdir(dirPath);
	} catch (err) {
		throw new ConfigError(`Could not read accounts directory '${dirPath}': ${errorMessage(err)}`);
	}

	const jsonFiles = entries.filter((name) => name.endsWith(".json")).sort();

	if (jsonFiles.length === 0) {
		throw new ConfigError(`No account config files found in '${dirPath}'`);
	}

	const accounts: AccountConfig[] = [];

	for (const filename of jsonFiles) {
		const filePath = join(dirPath, filename);
		let raw: string;
		try {
			raw = await readFile(filePath, "utf-8");
		} catch (err) {
			throw new ConfigError(`Could not read account config '${filePath}': ${errorMessage(err)}`);
		}

		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch {
			throw new ConfigError(`Account config '${filePath}' is not valid JSON`);
		}

		accounts.push(parseAccountConfig(data, filename));
		log.info(`Loaded account config: ${filename}`);
	}

	return accounts;
}

/**
 * Slugify a username for use as a config filename.
 * Lowercases, replaces non-alphanumeric chars with hyphens, trims hyphens.
 */
function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Save an account config to the accounts directory.
 * Creates the directory if it doesn't exist.
 */
export async function saveAccountConfig(config: AccountConfig, configDir: string): Promise<string> {
	const accountsDir = join(configDir, "accounts");
	await mkdir(accountsDir, { recursive: true });

	const filename = `${slugify(config.username)}.json`;
	const filePath = join(accountsDir, filename);

	await writeFile(filePath, JSON.stringify(config, null, 2), "utf-8");
	log.info(`Saved account config: ${filename}`);

	return filePath;
}

/** Load the full dispatcher config from a config directory. */
export async function loadConfig(configDir: string): Promise<DispatcherConfig> {
	const registrationPath = join(configDir, "registration.json");
	const accountsDir = join(configDir, "accounts");

	const registration = await loadRegistrationConfig(registrationPath);
	const accounts = await loadAccountConfigs(accountsDir);

	log.info(`Loaded config: ${accounts.length} account(s)`);

	return { registration, accounts };
}
