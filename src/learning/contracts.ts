import { Schema } from "effect";
import {
  ExecutorSchema,
  FailureKindSchema,
  OutcomeSchema,
  TaskFeaturesSchema,
  WorkerProfileSchema,
} from "../core/schemas.ts";

const text = Schema.NonEmptyString;

const count = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

const amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
);

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

/** Deliberately omits goals, acceptance prose, file paths, and conversation text. */
export const TaskSnapshotSchema = Schema.Struct({
  id: text,
  kind: Schema.Literals(["implementation", "research", "review", "diagnosis", "deterministic"]),
  requiredTools: Schema.Array(text),
  unresolved: Schema.Boolean,
  delegationRequested: Schema.Boolean,
  scopeComplete: Schema.Boolean,
  preferredWorkerId: Schema.optional(text),
  allowedProviders: Schema.optional(Schema.Array(text)),
  features: Schema.optional(TaskFeaturesSchema),
  projectId: Schema.optional(text),
  groupId: Schema.optional(text),
});

export type TaskSnapshot = typeof TaskSnapshotSchema.Type;

export const RecommendationSchema = Schema.Struct({
  executor: Schema.Union([ExecutorSchema, Schema.Literals(["local", "script"])]),
  model: Schema.NullOr(text),
  effort: Schema.NullOr(text),
  workerId: Schema.NullOr(text),
  reason: text,
  eligibleWorkerIds: Schema.Array(text),
  rejected: Schema.Array(Schema.Struct({ workerId: text, reason: text })),
  policyVersion: text,
  failureKind: Schema.optional(FailureKindSchema),
  recipeId: Schema.optional(text),
});

export const DecisionSchema = Schema.Struct({
  type: Schema.Literal("decision"),
  schemaVersion: Schema.Literal(1),
  id: text,
  at: timestamp,
  task: TaskSnapshotSchema,
  workers: Schema.Array(WorkerProfileSchema),
  recommendation: RecommendationSchema,
  strategy: Schema.Literals(["priority", "recipes", "jev"]),
});

export type Decision = typeof DecisionSchema.Type;

export const VerificationRequestSchema = Schema.Struct({
  decisionId: text,
  attemptId: text,
  artifactPath: text,
  verifier: Schema.Struct({
    id: text,
    version: text,
    command: text,
    args: Schema.Array(Schema.String),
    cwd: text,
    timeoutMs: count.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(120_000)),
  }),
});

export type VerificationRequest = typeof VerificationRequestSchema.Type;

export const VerificationSchema = Schema.Struct({
  type: Schema.Literal("verification"),
  schemaVersion: Schema.Literal(1),
  id: text,
  at: timestamp,
  decisionId: text,
  attemptId: text,
  workerId: Schema.NullOr(text),
  verifier: Schema.Struct({ id: text, version: text, requestSha256: digest }),
  artifact: Schema.Struct({ path: text, sha256: digest }),
  passed: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Int),
  failure: Schema.optional(
    Schema.Literals(["check_failed", "execution_error", "artifact_changed"]),
  ),
  elapsedMs: amount,
  stdoutSha256: digest,
  stderrSha256: digest,
});

export type Verification = typeof VerificationSchema.Type;

export const ProcedureSchema = Schema.Struct({
  id: text,
  version: text,
  steps: Schema.Array(text).check(Schema.isMinLength(1)),
  preconditions: Schema.Array(text),
});

export type Procedure = typeof ProcedureSchema.Type;

export const LinkedOutcomeInputSchema = Schema.Struct({
  ...OutcomeSchema.fields,
  decisionId: text,
  verificationId: Schema.optional(text),
  artifactSha256: Schema.optional(digest),
  failureKind: Schema.optional(FailureKindSchema),
  costUsd: Schema.optional(amount),
  correctionCount: count,
  inputTokens: Schema.optional(count),
  outputTokens: Schema.optional(count),
  cacheReadTokens: Schema.optional(count),
  cacheWriteTokens: Schema.optional(count),
  procedure: Schema.optional(ProcedureSchema),
});

export type LinkedOutcomeInput = typeof LinkedOutcomeInputSchema.Type;

export const LinkedOutcomeSchema = Schema.Struct({
  ...LinkedOutcomeInputSchema.fields,
  type: Schema.Literal("outcome"),
  schemaVersion: Schema.Literal(1),
  id: text,
  at: timestamp,
});

export type LinkedOutcome = typeof LinkedOutcomeSchema.Type;

export const JournalEventSchema = Schema.Union([
  DecisionSchema,
  VerificationSchema,
  LinkedOutcomeSchema,
]);

export type JournalEvent = typeof JournalEventSchema.Type;
