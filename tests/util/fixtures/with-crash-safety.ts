import { createLogger } from "../../../src/util/logger.js";
import { installCrashSafetyHandlers } from "../../../src/util/process-safety.js";

// Simulates the real production incident: a game-server disconnect rejects
// an in-flight query/mutation promise that nothing downstream ever awaits or
// catches (see spacemolt-lib's Correlator.rejectAll()). Fires it detached
// (no await, no .catch) — exactly what a leaked call site looks like.
function detachedRejection(): Promise<never> {
	return Promise.reject(new Error("simulated: connection closed mid-query"));
}

installCrashSafetyHandlers(createLogger("fixture"));
detachedRejection();

setTimeout(() => {
	console.log("SURVIVED");
	process.exit(0);
}, 200);
