import { TYPED_NOTIFICATION_TYPES } from "@spacemolt/lib";

/**
 * Classifies inbound push frames to find server-originated operational
 * notices — most importantly the warning the game server broadcasts shortly
 * before it restarts for a deploy.
 *
 * setpoint subscribes to a handful of specific `msg_type`s (`crafting_update`
 * plus `COMBAT_NOTIFICATION_TYPES`), so every other push frame reaches the
 * lib's emitter, finds no listener, and is dropped without a trace. That
 * silence is what makes a deploy look like an unexplained burst of socket
 * closures to anything watching the fleet. `classifyServerNotice` picks the
 * frames worth a log line out of the `onAny` firehose without dragging in the
 * high-volume gameplay pushes (`mining_yield`, `market_update`, …) that would
 * bury it across a fleet of hundreds of accounts.
 */

/** `msg_type`s with a published payload schema in the version of the spec this lib was generated from. */
const DOCUMENTED_PUSH_TYPES: ReadonlySet<string> = new Set(TYPED_NOTIFICATION_TYPES);

/**
 * Protocol envelope types, as opposed to server pushes.
 *
 * `action_result` is the exception, and is handled before this set is
 * consulted: since game v0.596.2 the server sends unsolicited `action_result`
 * frames with no `request_id`, where `command` names an event rather than a
 * command the account issued — see UNSOLICITED_EVENT_LABELS. Those are real
 * notices. An `action_result` that DOES carry a `request_id` is an ordinary
 * envelope and stays filtered out here.
 */
const PROTOCOL_FRAME_TYPES: ReadonlySet<string> = new Set([
	"result",
	"action_result",
	"action_error",
	"error",
	"logged_in",
	"welcome",
	"registered",
	// `ok` carries the per-action acknowledgement for a completed mutation —
	// `{"action":"jump","arrival_tick":…,"destination":…}` and the dock/travel
	// equivalents. It has no published schema, so it would otherwise read as an
	// undocumented push, but it is an envelope for work this account asked for
	// rather than anything the server is announcing.
	"ok",
]);

/**
 * Chat channels the server itself talks on. `chat_message`'s `channel` field
 * is documented as one of global, system, local, faction, private, admin; the
 * two here are the ones an operator uses to address players directly, so they
 * carry announcements — maintenance windows, incident notices — that have no
 * dedicated `msg_type` of their own. Player chatter (global, local, faction,
 * private) is deliberately excluded: it is high-volume and says nothing about
 * the server's operation.
 */
const SERVER_CHAT_CHANNELS: ReadonlySet<string> = new Set(["system", "admin"]);

/**
 * Documented push types that are operational notices rather than gameplay.
 * These have a published schema, so they would otherwise be filtered out with
 * the rest of the typed pushes.
 */
const SERVER_LIFECYCLE_TYPES: ReadonlySet<string> = new Set(["server_restart_warning"]);

/**
 * Events the server raises on an account that did not ask for anything.
 *
 * The account has no ack to reason from — something happened TO it — so
 * without logging these they are invisible: a ship being captured produced no
 * output at all. `@spacemolt/lib` applies the accompanying delta to the cache,
 * so state stays correct either way; this is about the operator being able to
 * see it happened.
 */
const UNSOLICITED_EVENT_LABELS: ReadonlyMap<string, string> = new Map([
	["player_died", "died"],
	["ship_captured", "ship captured"],
	["emergency_warp_stabilizer", "emergency warp stabilizer fired"],
	["passenger_stranded", "stranded — the ship it was riding was destroyed or captured"],
	["fleet_kicked", "kicked from its fleet"],
	["fleet_disbanded", "fleet disbanded"],
	["mobile_capital_transit", "moved by the Mobile Capital jumping while docked"],
]);

/** A push frame worth logging, and why it was picked out. */
export interface ServerNotice {
	/**
	 * `server-lifecycle` — a documented operational push, above all
	 * `server_restart_warning`.
	 * `server-chat` — an announcement on the system/admin chat channel.
	 * `undocumented-push` — a `msg_type` absent from the generated spec, which
	 * catches an operational notice the spec doesn't describe yet.
	 * `unsolicited-event` — something happened TO this account without it
	 * asking: death, capture, being kicked from a fleet.
	 */
	kind: "server-lifecycle" | "server-chat" | "undocumented-push" | "unsolicited-event";
	/** The frame's `msg_type`. */
	type: string;
	/** Human-readable one-liner for the log. */
	summary: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Serialize a payload for a log line, capped so a large or unexpected payload
 * can't dump kilobytes per account into the log.
 */
function summarizePayload(payload: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(payload) ?? String(payload);
	} catch {
		// Circular or otherwise unserializable — the type alone is still useful.
		return "<unserializable payload>";
	}
	return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/**
 * Render a `server_restart_warning` payload, leading with the countdown so the
 * log line answers "how long have I got" without parsing JSON. Falls back to
 * the raw payload if the server sends a shape the schema doesn't describe.
 */
function describeRestartWarning(payload: unknown): string {
	const body = asRecord(payload);
	const seconds = body?.["seconds_until_restart"];
	if (typeof seconds !== "number") {
		return summarizePayload(payload);
	}
	const message = asString(body?.["message"]) ?? "server restarting";
	const version = asString(body?.["target_version"]);
	return `restart in ${seconds}s${version === undefined ? "" : ` (→ ${version})`}: ${message}`;
}

/**
 * Decide whether a push frame is a server notice worth logging.
 * Returns `null` for the overwhelming majority of frames — ordinary gameplay
 * pushes and player chat.
 */
export function classifyServerNotice(
	type: string,
	payload: unknown,
	requestId?: string,
): ServerNotice | null {
	// An action_result with no request_id is not a stray envelope — nothing of
	// ours is waiting on it. Since v0.596.2 the server uses that shape to
	// announce things that happened to the account unprompted.
	if (type === "action_result" && requestId === undefined) {
		const command = asString(asRecord(payload)?.["command"]);
		if (command !== undefined) {
			const label = UNSOLICITED_EVENT_LABELS.get(command);
			return {
				kind: "unsolicited-event",
				type: command,
				summary: label ?? `unsolicited ${command}`,
			};
		}
	}

	if (SERVER_LIFECYCLE_TYPES.has(type)) {
		return { kind: "server-lifecycle", type, summary: describeRestartWarning(payload) };
	}

	if (type === "chat_message") {
		const body = asRecord(payload);
		const channel = asString(body?.["channel"])?.toLowerCase();
		const official = body?.["empire_official"] === true;
		// `empire_official` is set by the server on its own announcements and
		// cannot be spoofed by a player client, so it's worth honouring even on
		// a channel we'd otherwise skip.
		if ((channel !== undefined && SERVER_CHAT_CHANNELS.has(channel)) || official) {
			const sender = asString(body?.["sender"]) ?? "server";
			const content = asString(body?.["content"]) ?? summarizePayload(payload);
			return {
				kind: "server-chat",
				type,
				summary: `[${channel ?? "unknown"}] ${sender}: ${content}`,
			};
		}
		return null;
	}

	if (DOCUMENTED_PUSH_TYPES.has(type) || PROTOCOL_FRAME_TYPES.has(type)) {
		return null;
	}

	return {
		kind: "undocumented-push",
		type,
		summary: summarizePayload(payload),
	};
}

/**
 * Per-`msg_type` log suppression.
 *
 * A server broadcast lands on every account's socket at once, so one restart
 * warning would otherwise write one identical line per connected account —
 * hundreds of lines that bury the thing they're announcing. The first frame of
 * a given type logs immediately with its full payload; duplicates inside the
 * window are counted and reported on the next line for that type rather than
 * logged individually.
 */
export interface NoticeRateLimiter {
	/**
	 * Record an occurrence of `key` at `now`. Returns the number of duplicates
	 * suppressed since the previous emitted line when this one should be
	 * logged, or `null` when it falls inside the window and should be skipped.
	 */
	admit(key: string, now: number): number | null;
}

export const createNoticeRateLimiter = ({ windowMs }: { windowMs: number }): NoticeRateLimiter => {
	const seen = new Map<string, { loggedAt: number; suppressed: number }>();
	return {
		admit(key, now) {
			const entry = seen.get(key);
			if (entry && now - entry.loggedAt < windowMs) {
				entry.suppressed++;
				return null;
			}
			seen.set(key, { loggedAt: now, suppressed: 0 });
			return entry?.suppressed ?? 0;
		},
	};
};
