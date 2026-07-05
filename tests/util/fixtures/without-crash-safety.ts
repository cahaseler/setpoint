// Baseline (no installCrashSafetyHandlers): proves the detached rejection
// below is a genuine crash trigger under Bun's default behavior, so the
// "with" fixture's survival is actually attributable to the fix and not a
// no-op scenario.
function detachedRejection(): Promise<never> {
	return Promise.reject(new Error("simulated: connection closed mid-query"));
}

detachedRejection();

setTimeout(() => {
	console.log("SURVIVED");
	process.exit(0);
}, 200);
