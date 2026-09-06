/**
 * Liveness signal from an external combat driver.
 *
 * An account in `"external"` combat mode gets no automatic flee response, which
 * is correct while a driver is actually flying it and catastrophic when one
 * isn't: the ship neither fights nor flees. That state has cost real hulls.
 *
 * The signal has to be a heartbeat rather than "did it send a command", because
 * a well-fought battle has many ticks where the right move is to hold and let
 * auto-fire resolve. Counting commands would flee a healthy fleet mid-fight.
 * The driver pings every tick it is alive, whether or not it acted.
 *
 * In memory only, and deliberately so: a heartbeat is a statement about a
 * process that is running right now, and a value that survived a daemon restart
 * would be a lie about a driver that did not.
 */
export class CombatHeartbeatStore {
	private readonly lastSeen = new Map<string, number>();

	/** Record that the driver for this account is alive. */
	beat(playerId: string, now: number = Date.now()): void {
		this.lastSeen.set(playerId, now);
	}

	/** Milliseconds since the last heartbeat, or `undefined` if none was ever received. */
	sinceLast(playerId: string, now: number = Date.now()): number | undefined {
		const seen = this.lastSeen.get(playerId);
		return seen === undefined ? undefined : now - seen;
	}

	/** Forget an account's heartbeat — used when a battle ends, so the next one starts clean. */
	clear(playerId: string): void {
		this.lastSeen.delete(playerId);
	}
}
