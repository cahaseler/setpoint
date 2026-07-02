import { ConfigError } from "./config.js";

/** Selects which owned players to connect. All clauses AND together. */
export interface OwnedPlayerFilter {
  /** Case-insensitive username allowlist. */
  usernames?: string[];
  /** Case-insensitive empire allowlist. */
  empires?: string[];
  /** Include players hidden in the dashboard. Default false. */
  includeHidden?: boolean;
}

/** Clerk-based service config: one API key + optional owned-player filter. */
export interface LibConfig {
  clerkApiKey: string;
  filter?: OwnedPlayerFilter;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFilter(raw: unknown): OwnedPlayerFilter | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const filter: OwnedPlayerFilter = {};
  if (Array.isArray(raw["usernames"])) {
    filter.usernames = raw["usernames"].filter((u): u is string => typeof u === "string");
  }
  if (Array.isArray(raw["empires"])) {
    filter.empires = raw["empires"].filter((e): e is string => typeof e === "string");
  }
  if (typeof raw["includeHidden"] === "boolean") {
    filter.includeHidden = raw["includeHidden"];
  }
  return filter;
}

/**
 * Build the Clerk service config. `clerkApiKey` comes from
 * `SPACEMOLT_CLERK_API_KEY` (env wins) or `clerkApiKey` in dispatcher.json.
 * An optional `accountsFilter` in the file selects which owned players connect.
 */
export function parseLibConfig(
  env: Record<string, string | undefined>,
  fileData: unknown,
): LibConfig {
  const file = isRecord(fileData) ? fileData : {};
  const fromEnv = env["SPACEMOLT_CLERK_API_KEY"];
  const fromFile = typeof file["clerkApiKey"] === "string" ? file["clerkApiKey"] : undefined;
  const clerkApiKey = fromEnv && fromEnv.length > 0 ? fromEnv : fromFile;

  if (!clerkApiKey || clerkApiKey.length === 0) {
    throw new ConfigError(
      "Missing Clerk API key: set SPACEMOLT_CLERK_API_KEY or 'clerkApiKey' in config/dispatcher.json",
    );
  }

  const filter = parseFilter(file["accountsFilter"]);
  return filter ? { clerkApiKey, filter } : { clerkApiKey };
}
