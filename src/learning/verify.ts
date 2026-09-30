import { Effect, Exit, FileSystem, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { sha256 } from "./hash.ts";
import { VerificationRequestSchema, type Verification } from "./contracts.ts";
import { appendEvent, decisionFor, newId, readJournal } from "./journal.ts";
import {
  artifactError,
  verificationError,
  type LearningError,
  type ArtifactError,
  type VerificationError,
} from "./errors.ts";
import { runCheck, type CheckResult } from "./check-runner.ts";

export { sha256 };

export function artifactHash(
  path: string,
): Effect.Effect<string, ArtifactError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    const actual = yield* fs
      .realPath(path)
      .pipe(
        Effect.mapError((cause) =>
          artifactError("artifact.stat", "unable to inspect artifact", cause),
        ),
      );

    const parent = yield* fs
      .realPath(paths.dirname(path))
      .pipe(
        Effect.mapError((cause) =>
          artifactError("artifact.stat", "unable to inspect artifact", cause),
        ),
      );

    if (actual !== paths.join(parent, paths.basename(path)))
      return yield* artifactError("artifact.type", "artifact must be a regular file or directory");

    const stat = yield* fs
      .stat(path)
      .pipe(
        Effect.mapError((cause) =>
          artifactError("artifact.stat", "unable to inspect artifact", cause),
        ),
      );

    if (stat.type === "File")
      return sha256(
        yield* fs
          .readFile(path)
          .pipe(
            Effect.mapError((cause) =>
              artifactError("artifact.read", "unable to read artifact", cause),
            ),
          ),
      );

    if (stat.type !== "Directory")
      return yield* artifactError("artifact.type", "artifact must be a regular file or directory");

    const hashParts = ["stooart-tree-v1\n"];

    const walk = (directory: string, relative: string): Effect.Effect<void, ArtifactError> =>
      Effect.gen(function* () {
        const names = yield* fs
          .readDirectory(directory)
          .pipe(
            Effect.mapError((cause) =>
              artifactError("artifact.list", "unable to list artifact", cause),
            ),
          );

        for (const name of names.sort()) {
          const absolute = paths.join(directory, name);
          const key = relative ? `${relative}/${name}` : name;

          const resolved = yield* fs
            .realPath(absolute)
            .pipe(
              Effect.mapError((cause) =>
                artifactError("artifact.stat", "unable to inspect artifact entry", cause),
              ),
            );

          const resolvedParent = yield* fs
            .realPath(directory)
            .pipe(
              Effect.mapError((cause) =>
                artifactError("artifact.stat", "unable to inspect artifact directory", cause),
              ),
            );

          if (resolved !== paths.join(resolvedParent, name))
            return yield* artifactError(
              "artifact.type",
              "artifact contains a symlink or special file",
            );

          const child = yield* fs
            .stat(absolute)
            .pipe(
              Effect.mapError((cause) =>
                artifactError("artifact.stat", "unable to inspect artifact entry", cause),
              ),
            );

          if (child.type === "Directory") {
            hashParts.push(JSON.stringify(["directory", key]) + "\n");
            yield* walk(absolute, key);
          } else if (child.type === "File") {
            const bytes = yield* fs
              .readFile(absolute)
              .pipe(
                Effect.mapError((cause) =>
                  artifactError("artifact.read", "unable to read artifact entry", cause),
                ),
              );

            hashParts.push(JSON.stringify(["file", key, child.mode & 0o777, sha256(bytes)]) + "\n");
          } else
            return yield* artifactError(
              "artifact.type",
              "artifact contains a symlink or special file",
            );
        }
      });

    yield* walk(path, "");

    return sha256(hashParts.join(""));
  });
}

/** Runs only through an explicit verify invocation. No command comes from learned history. */
export function verifyAttempt(
  path: string,
  input: Schema.Json,
): Effect.Effect<
  Verification,
  ArtifactError | VerificationError | LearningError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const decoded = Schema.decodeUnknownExit(VerificationRequestSchema)(input);

  if (!Exit.isSuccess(decoded))
    return Effect.fail(
      verificationError("verification.schema", "invalid verification request", decoded.cause),
    );

  return Effect.gen(function* () {
    const paths = yield* Path.Path;
    const request = decoded.value;
    const journal = yield* readJournal(path);
    const decision = yield* decisionFor(journal, request.decisionId);

    if (journal.finalizedAttempts.has(request.attemptId))
      return yield* verificationError("verification.reference", "attempt already finalized");
    const cwd = paths.resolve(request.verifier.cwd);
    const artifactPath = paths.resolve(cwd, request.artifactPath);
    const hash = yield* artifactHash(artifactPath);
    const start = Date.now();

    const result = yield* runCheck(
      request.verifier.command,
      [...request.verifier.args],
      cwd,
      request.verifier.timeoutMs,
    ).pipe(
      Effect.catchTag("CheckError", () =>
        Effect.succeed<CheckResult>({
          stdout: "",
          stderr: "",
          status: null,
          failedToExecute: true,
        }),
      ),
    );

    const unchanged = yield* artifactHash(artifactPath).pipe(
      Effect.map((after) => after === hash),
      Effect.catchTag("ArtifactError", () => Effect.succeed(false)),
    );

    const failure: Verification["failure"] = !unchanged
      ? "artifact_changed"
      : result.failedToExecute
        ? "execution_error"
        : result.status !== 0
          ? "check_failed"
          : undefined;

    const receipt: Verification = {
      type: "verification",
      schemaVersion: 1,
      id: newId("verification"),
      at: new Date().toISOString(),
      decisionId: decision.id,
      attemptId: request.attemptId,
      workerId: decision.recommendation.workerId,
      verifier: {
        id: request.verifier.id,
        version: request.verifier.version,
        requestSha256: sha256(JSON.stringify({ ...request.verifier, cwd })),
      },
      artifact: { path: artifactPath, sha256: hash },
      passed: failure === undefined,
      exitCode: result.status,
      failure,
      elapsedMs: Date.now() - start,
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr),
    };

    yield* appendEvent(path, receipt);

    return receipt;
  });
}
