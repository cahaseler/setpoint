#!/usr/bin/env bun

/** smctl — CLI for the setpoint daemon. */

import { errorMessage } from "../util/errors.js";
import { DaemonClient } from "./client.js";
import { dispatch, getUsageText } from "./commands.js";
import { createOutput } from "./output.js";

const VERSION = "0.0.281";

const DEFAULT_PORT = 7580;

async function main(): Promise<void> {
	const output = createOutput();

	// Parse raw args (skip "bun" and script path)
	const rawArgs = process.argv.slice(2);

	// Extract flags
	let port: number | undefined;
	let jsonBody: unknown | undefined;
	let useStdin = false;
	let asyncMode = false;
	let forceMode = false;
	const positionalArgs: string[] = [];

	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg === "--port") {
			const next = rawArgs[++i];
			if (!next) {
				return output.usageError("--port requires a number");
			}
			port = Number.parseInt(next, 10);
			if (Number.isNaN(port)) {
				return output.usageError(`Invalid port: ${next}`);
			}
		} else if (arg === "--json") {
			const next = rawArgs[++i];
			if (!next) {
				return output.usageError("--json requires a JSON string argument");
			}
			try {
				jsonBody = JSON.parse(next);
			} catch {
				return output.usageError("--json value is not valid JSON");
			}
		} else if (arg === "--async") {
			asyncMode = true;
		} else if (arg === "--force") {
			forceMode = true;
		} else if (arg === "--stdin") {
			useStdin = true;
		} else if (arg === "--help" || arg === "-h") {
			output.ok({ usage: getUsageText() });
		} else if (arg === "--version" || arg === "-v") {
			output.raw(`smctl ${VERSION}`);
		} else {
			positionalArgs.push(arg as string);
		}
	}

	// Read stdin if requested
	if (useStdin) {
		if (jsonBody !== undefined) {
			output.usageError("Cannot use both --json and --stdin");
		}
		const text = await readStdin();
		try {
			jsonBody = JSON.parse(text);
		} catch {
			output.usageError("Stdin is not valid JSON");
		}
	}

	// Resolve port
	const envPort = Number(process.env["SM_PORT"]);
	const resolvedPort = port ?? (envPort > 0 ? envPort : DEFAULT_PORT);

	if (positionalArgs.length === 0) {
		output.usageError(getUsageText());
	}

	const client = new DaemonClient({ port: resolvedPort });
	const matched = await dispatch(
		{ client, output, jsonBody, asyncMode, forceMode },
		positionalArgs,
	);

	if (!matched) {
		output.usageError(`Unknown command: ${positionalArgs.join(" ")}\n\n${getUsageText()}`);
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of Bun.stdin.stream()) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf-8");
}

main().catch((err) => {
	const output = createOutput();
	output.serverError({
		error: "unexpected_error",
		message: errorMessage(err),
	});
});
