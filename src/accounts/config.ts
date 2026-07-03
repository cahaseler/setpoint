import { readFile } from "node:fs/promises";
import { errorMessage } from "../util/errors.js";

/** Registration code shared across all accounts for a user. */
export interface RegistrationConfig {
	registration_code: string;
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
