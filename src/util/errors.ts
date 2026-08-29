import type { V2Response } from "@spacemolt/lib";

type V2ResponseError = NonNullable<V2Response["error"]>;

/** Error returned by the SpaceMolt API in the response envelope. */
export class ApiError extends Error {
	readonly code: string;
	readonly statusCode: number;

	constructor(code: string, message: string, statusCode: number) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.statusCode = statusCode;
	}

	static fromResponse(error: V2ResponseError, statusCode: number): ApiError {
		return new ApiError(error.code ?? "unknown", error.message ?? "Unknown error", statusCode);
	}
}

/** HTTP-level error (network failure, non-JSON response, etc.) */
export class HttpError extends Error {
	readonly statusCode: number;

	constructor(message: string, statusCode: number) {
		super(message);
		this.name = "HttpError";
		this.statusCode = statusCode;
	}
}

/** Extract a readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
