import { Effect, Schema } from "effect";

const nonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const nonEmpty = Schema.NonEmptyString;

export const ExecutorSchema = nonEmpty.check(
  Schema.isPattern(/^(?!local$|script$)[a-z][a-z0-9._-]*$/),
);

export const FailureKindSchema = Schema.Literals([
  "authentication",
  "rate_limit",
  "quota",
  "timeout",
  "transport",
  "provider",
  "malformed_response",
  "low_confidence",
  "verification",
  "implementation",
]);

export const TaskFeaturesSchema = Schema.Struct({
  family: Schema.Literals(["ci", "bugfix", "migration", "ui", "integration", "tests", "other"]),
  scope: Schema.Literals(["small", "medium", "large"]),
  context: Schema.Literals(["fresh", "existing"]),
  proof: Schema.Literals(["tests", "visual", "review", "mixed"]),
});

/** Runtime schema for a work order. `delegationRequested` defaults to false. */
export const TaskSchema = Schema.Struct({
  id: nonEmpty,
  kind: Schema.Literals(["implementation", "research", "review", "diagnosis", "deterministic"]),
  goal: Schema.String,
  acceptance: Schema.Array(Schema.String),
  allowedPaths: Schema.Array(Schema.String),
  requiredTools: Schema.Array(Schema.String),
  unresolved: Schema.Boolean,
  delegationRequested: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  preferredWorkerId: Schema.optional(Schema.String),
  allowedProviders: Schema.optional(Schema.Array(Schema.String)),
  features: Schema.optional(TaskFeaturesSchema),
  projectId: Schema.optional(nonEmpty),
  groupId: Schema.optional(nonEmpty),
});

/** Runtime schema for a worker profile. */
export const WorkerProfileSchema = Schema.Struct({
  id: nonEmpty,
  executor: ExecutorSchema,
  model: nonEmpty,
  provider: nonEmpty,
  available: Schema.Boolean,
  tools: Schema.Array(Schema.String),
  effort: Schema.optional(Schema.String),
  explicitOnly: Schema.Boolean,
  priority: Schema.Finite,
  health: Schema.optional(
    Schema.Struct({
      failure: FailureKindSchema,
      observedAt: nonEmpty,
      retryAfter: nonEmpty,
    }),
  ),
});

export type TaskInput = typeof TaskSchema.Encoded | Schema.Json;

export type WorkerInput = typeof WorkerProfileSchema.Encoded | Schema.Json;

/** Runtime schema for a compact work outcome. */
export const OutcomeSchema = Schema.Struct({
  taskId: nonEmpty,
  attemptId: nonEmpty,
  workerId: Schema.optional(Schema.String),
  status: Schema.Literals([
    "verified",
    "accepted",
    "failed",
    "environment_error",
    "cancelled",
    "unknown",
  ]),
  elapsedMs: nonNegative,
  checks: Schema.Array(Schema.String),
  correctionCount: nonNegative,
  inputTokens: Schema.optional(nonNegative),
  outputTokens: Schema.optional(nonNegative),
});
