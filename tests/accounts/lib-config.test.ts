import { describe, expect, test } from "bun:test";
import { parseLibConfig } from "../../src/accounts/lib-config.js";
import { ConfigError } from "../../src/accounts/config.js";

describe("parseLibConfig", () => {
  test("reads clerkApiKey from env", () => {
    const cfg = parseLibConfig({ SPACEMOLT_CLERK_API_KEY: "key_123" }, {});
    expect(cfg.clerkApiKey).toBe("key_123");
    expect(cfg.filter).toBeUndefined();
  });

  test("file clerkApiKey is used when env is absent", () => {
    const cfg = parseLibConfig({}, { clerkApiKey: "key_file" });
    expect(cfg.clerkApiKey).toBe("key_file");
  });

  test("env overrides file", () => {
    const cfg = parseLibConfig({ SPACEMOLT_CLERK_API_KEY: "key_env" }, { clerkApiKey: "key_file" });
    expect(cfg.clerkApiKey).toBe("key_env");
  });

  test("parses filter spec from file", () => {
    const cfg = parseLibConfig(
      { SPACEMOLT_CLERK_API_KEY: "k" },
      { accountsFilter: { usernames: ["Alpha"], empires: ["solarian"], includeHidden: true } },
    );
    expect(cfg.filter).toEqual({ usernames: ["Alpha"], empires: ["solarian"], includeHidden: true });
  });

  test("throws when clerkApiKey missing", () => {
    expect(() => parseLibConfig({}, {})).toThrow(ConfigError);
  });

  test("throws when clerkApiKey empty", () => {
    expect(() => parseLibConfig({ SPACEMOLT_CLERK_API_KEY: "" }, {})).toThrow(ConfigError);
  });
});
