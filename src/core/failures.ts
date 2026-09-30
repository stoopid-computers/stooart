import { Exit, Match, Schema } from "effect";
import type {
  APIResponseError,
  TypeSafeConfigError,
  TypeSafeError,
} from "@compootor/effective-jev";
import type { FailureKind } from "./types.ts";

const QuotaDetails = Schema.Struct({
  error: Schema.Struct({
    code: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
  }),
});

function responseFailure(error: APIResponseError): FailureKind {
  if (error.status === 401 || error.status === 403) return "authentication";

  if (error.status !== 429) return "provider";
  const decoded = Schema.decodeUnknownExit(QuotaDetails)(error.body);

  if (
    Exit.isSuccess(decoded) &&
    (decoded.value.error.code === "insufficient_quota" ||
      decoded.value.error.type === "insufficient_quota")
  )
    return "quota";

  return "rate_limit";
}

/** Expose categories only; provider response bodies and messages stay private. */
export const classifyProviderFailure = (error: TypeSafeError | TypeSafeConfigError): FailureKind =>
  Match.value(error).pipe(
    Match.tag("APITimeoutError", () => "timeout" as const),
    Match.tag("APIConnectionError", () => "transport" as const),
    Match.tag("ResponseValidationError", () => "malformed_response" as const),
    Match.tag("TypeSafeConfigError", () => "authentication" as const),
    Match.tag("InvalidRequestError", () => "provider" as const),
    Match.orElse(responseFailure),
  );
