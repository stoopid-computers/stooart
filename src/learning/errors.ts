import { Schema } from "effect";

export class JournalError extends Schema.TaggedError<JournalError>()("JournalError", {
  operation: Schema.String,
  path: Schema.optional(Schema.String),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class JournalSchemaError extends Schema.TaggedError<JournalSchemaError>()(
  "JournalSchemaError",
  {
    operation: Schema.String,
    path: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class JournalLockError extends Schema.TaggedError<JournalLockError>()("JournalLockError", {
  operation: Schema.String,
  path: Schema.optional(Schema.String),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class CheckError extends Schema.TaggedError<CheckError>()("CheckError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class ArtifactError extends Schema.TaggedError<ArtifactError>()("ArtifactError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class VerificationError extends Schema.TaggedError<VerificationError>()(
  "VerificationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type LearningError = JournalError | JournalSchemaError | JournalLockError | CliError;

export type LearningFailure = LearningError | CheckError | ArtifactError | VerificationError;

export const learningError = (
  operation: string,
  detail: string,
  path?: string,
  cause?: unknown,
): JournalError => new JournalError({ operation, detail, path, cause });

export const journalSchemaError = (
  operation: string,
  detail: string,
  path?: string,
  cause?: unknown,
): JournalSchemaError => new JournalSchemaError({ operation, detail, path, cause });

export const journalLockError = (
  operation: string,
  detail: string,
  path?: string,
  cause?: unknown,
): JournalLockError => new JournalLockError({ operation, detail, path, cause });

export const cliError = (operation: string, detail: string, cause?: unknown): CliError =>
  new CliError({ operation, detail, cause });

export const checkError = (operation: string, detail: string, cause?: unknown): CheckError =>
  new CheckError({ operation, detail, cause });

export const artifactError = (operation: string, detail: string, cause?: unknown): ArtifactError =>
  new ArtifactError({ operation, detail, cause });

export const verificationError = (
  operation: string,
  detail: string,
  cause?: unknown,
): VerificationError => new VerificationError({ operation, detail, cause });
