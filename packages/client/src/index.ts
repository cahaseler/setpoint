export { AccountApi, AccountsApi, AccountStateApi, AccountSystemApi } from "./account.js";
export type {
	AbortOptions,
	AccountDetail,
	AccountDetailState,
	AccountLocationSummary,
	AccountShipSummary,
	AccountSummary,
	AccountsListResult,
	AddAccountResult,
	ConnectedAccountDetail,
	ConnectedAccountSummary,
	PendingAccountDetail,
	PendingAccountSummary,
	RegisterAccountOptions,
	RegisterAccountResult,
	RemoveAccountResult,
} from "./account.js";
export { SetpointClient } from "./client.js";
export type {
	DashboardAccountEntry,
	DashboardData,
	HealthStatus,
	LogLevel,
	LogLevelResult,
	RequestOptions,
	SetpointClientOptions,
} from "./client.js";
export {
	ConnectionError,
	DeprecatedGoalError,
	GoalFailedError,
	SetpointHttpError,
	TimeoutError,
} from "./errors.js";
export type { SetpointHttpErrorBody } from "./errors.js";
export { JobApi, waitForJob } from "./jobs.js";
export type { WaitForJobOptions } from "./jobs.js";
export type { RawApi } from "./raw.js";

// Re-export the shared protocol types (`GoalResult`, `LoopStatus`, `JobRecord`,
// `RawEnvelope`, `V2GameState`, `GoalType`/`GoalOptionsMap`,
// `LoopType`/`LoopOptionsMap`, `Empire`, etc.) so consumers can import
// everything from `@setpoint/client` alone, without a direct
// `@setpoint/protocol` dependency. No name collisions with the client's own
// exports above (checked against `packages/protocol/src/{results,game,goals,loops}.ts`).
export * from "@setpoint/protocol";
