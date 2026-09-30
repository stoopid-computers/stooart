import { Effect, Exit, FileSystem, Path, Schema } from "effect";
import { recommendPrepared, prepareRouting } from "../core/router.ts";
import type { Task, WorkerProfile } from "../core/types.ts";
import {
  journalLockError,
  journalSchemaError,
  learningError,
  type LearningError,
} from "./errors.ts";
import {
  JournalEventSchema,
  type Decision,
  type JournalEvent,
  type LinkedOutcome,
  type TaskSnapshot,
  type Verification,
} from "./contracts.ts";

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function snapshotTask(task: Task): TaskSnapshot {
  const {
    id,
    kind,
    requiredTools,
    unresolved,
    delegationRequested,
    preferredWorkerId,
    allowedProviders,
    features,
    projectId,
    groupId,
  } = task;

  return {
    id,
    kind,
    requiredTools,
    unresolved,
    delegationRequested,
    preferredWorkerId,
    allowedProviders,
    features,
    projectId,
    groupId,
    scopeComplete: Boolean(
      task.goal.trim() &&
      task.acceptance.length &&
      task.allowedPaths.length &&
      task.acceptance.every((s) => s.trim()) &&
      task.allowedPaths.every((s) => s.trim()),
    ),
  };
}

export function restoreTask(task: TaskSnapshot): Task {
  return {
    ...task,
    goal: task.scopeComplete ? "recorded scope" : "",
    acceptance: task.scopeComplete ? ["recorded check"] : [],
    allowedPaths: task.scopeComplete ? ["recorded scope"] : [],
  };
}

export function sameWorker(a: WorkerProfile, b: WorkerProfile): boolean {
  return (
    a.id === b.id &&
    a.executor === b.executor &&
    a.model === b.model &&
    a.provider === b.provider &&
    a.effort === b.effort &&
    JSON.stringify([...a.tools].sort()) === JSON.stringify([...b.tools].sort())
  );
}

export interface ValidatedJournal {
  readonly events: ReadonlyArray<JournalEvent>;
  readonly decisions: ReadonlyMap<string, Decision>;
  readonly verifications: ReadonlyMap<string, Verification>;
  readonly outcomesByDecision: ReadonlyMap<string, ReadonlyArray<LinkedOutcome>>;
  readonly finalizedAttempts: ReadonlySet<string>;
}

export function decisionFor(
  journal: ValidatedJournal,
  id: string,
): Effect.Effect<Decision, LearningError> {
  const decision = journal.decisions.get(id);

  return decision
    ? Effect.succeed(decision)
    : Effect.fail(learningError("journal.reference", "decision not found"));
}

const invalid = (detail: string): Effect.Effect<never, LearningError> =>
  Effect.fail(learningError("journal.validate", detail));

/** Check references in append order. A receipt cannot retroactively verify an outcome. */
export function validateJournal(
  events: ReadonlyArray<JournalEvent>,
): Effect.Effect<ValidatedJournal, LearningError> {
  return Effect.gen(function* () {
    const ids = new Set<string>();
    const attempts = new Set<string>();
    const decisions = new Map<string, Decision>();
    const verifications = new Map<string, Verification>();
    const outcomesByDecision = new Map<string, LinkedOutcome[]>();
    const procedures = new Map<string, string>();
    let lastTime = -Infinity;

    for (const event of events) {
      const time = Date.parse(event.at);

      if (!Number.isFinite(time) || new Date(time).toISOString() !== event.at || time < lastTime)
        return yield* invalid("invalid journal chronology");
      lastTime = time;

      if (ids.has(event.id)) return yield* invalid("duplicate journal ID");
      ids.add(event.id);

      if (event.type === "decision") {
        const task = restoreTask(event.task);
        const prepared = prepareRouting(task, event.workers, time);
        const baseline = recommendPrepared(prepared);
        const choice = event.recommendation;

        if (choice.workerId) {
          if (!("eligible" in prepared) || prepared.localReason || baseline.executor === "script")
            return yield* invalid("decision violates policy");
          const worker = prepared.eligible.find((candidate) => candidate.id === choice.workerId);

          if (
            !worker ||
            worker.model !== choice.model ||
            worker.executor !== choice.executor ||
            (worker.effort ?? null) !== choice.effort
          )
            return yield* invalid("decision worker mismatch");
        } else if (
          !(choice.executor === "local" || choice.executor === "script") ||
          (choice.executor === "script" && baseline.executor !== "script") ||
          choice.model !== null ||
          choice.effort !== null
        ) {
          return yield* invalid("invalid non-worker decision");
        }

        decisions.set(event.id, event);
      } else {
        const decision = decisions.get(event.decisionId);

        if (!decision) return yield* invalid("decision not found");

        if ((event.workerId ?? null) !== decision.recommendation.workerId)
          return yield* invalid("attempt worker mismatch");

        if (event.type === "verification") {
          if (attempts.has(event.attemptId)) return yield* invalid("attempt already finalized");

          if (event.passed && (event.exitCode !== 0 || event.failure !== undefined))
            return yield* invalid("invalid verification result");
          verifications.set(event.id, event);
        } else {
          if (attempts.has(event.attemptId) || event.taskId !== decision.task.id)
            return yield* invalid("duplicate or mismatched attempt");
          attempts.add(event.attemptId);

          if (event.procedure) {
            const key = JSON.stringify([
              decision.task.projectId,
              event.procedure.id,
              event.procedure.version,
            ]);

            const definition = JSON.stringify([
              event.procedure.steps,
              event.procedure.preconditions,
            ]);

            if (procedures.has(key) && procedures.get(key) !== definition)
              return yield* invalid("changed procedure requires a new version");
            procedures.set(key, definition);
          }

          if (event.verificationId) {
            const receipt = verifications.get(event.verificationId);

            if (
              !receipt ||
              receipt.decisionId !== event.decisionId ||
              receipt.attemptId !== event.attemptId ||
              receipt.artifact.sha256 !== event.artifactSha256
            )
              return yield* invalid("verification evidence mismatch");

            if (event.status === "verified" && !receipt.passed)
              return yield* invalid("failed checks cannot verify an outcome");
          } else if (event.status === "verified" || event.artifactSha256)
            return yield* invalid("verification evidence required");
          const outcomes = outcomesByDecision.get(event.decisionId) ?? [];
          outcomes.push(event);
          outcomesByDecision.set(event.decisionId, outcomes);
        }
      }
    }

    return { events, decisions, verifications, outcomesByDecision, finalizedAttempts: attempts };
  });
}

const decodeEvent = (line: string, path: string): Effect.Effect<JournalEvent, LearningError> =>
  Effect.try({
    try: () => JSON.parse(line),
    catch: (cause) => journalSchemaError("journal.parse", "invalid JSON record", path, cause),
  }).pipe(
    Effect.flatMap((value) => {
      const decoded = Schema.decodeUnknownExit(JournalEventSchema)(value);

      return Exit.isSuccess(decoded)
        ? Effect.succeed(decoded.value)
        : Effect.fail(
            journalSchemaError("journal.schema", "invalid journal record", path, decoded.cause),
          );
    }),
  );

export function readJournal(
  path: string,
): Effect.Effect<ValidatedJournal, LearningError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    const exists = yield* fs
      .exists(path)
      .pipe(
        Effect.mapError((cause) =>
          learningError("journal.stat", "unable to inspect journal", path, cause),
        ),
      );

    if (!exists) return yield* validateJournal([]);

    const actual = yield* fs
      .realPath(path)
      .pipe(
        Effect.mapError((cause) =>
          learningError("journal.stat", "unable to inspect journal", path, cause),
        ),
      );

    const parent = yield* fs
      .realPath(paths.dirname(path))
      .pipe(
        Effect.mapError((cause) =>
          learningError("journal.stat", "unable to inspect journal", path, cause),
        ),
      );

    if (actual !== paths.join(parent, paths.basename(path)))
      return yield* learningError("journal.read", "journal must be a regular file", path);

    const stat = yield* fs
      .stat(path)
      .pipe(
        Effect.mapError((cause) =>
          learningError("journal.stat", "unable to inspect journal", path, cause),
        ),
      );

    if (stat.type !== "File")
      return yield* learningError("journal.read", "journal must be a regular file", path);

    const text = yield* fs
      .readFileString(path)
      .pipe(
        Effect.mapError((cause) =>
          learningError("journal.read", "unable to read journal", path, cause),
        ),
      );

    if (text && !text.endsWith("\n"))
      return yield* learningError("journal.read", "journal has an incomplete final record", path);

    const events = yield* Effect.forEach(text.split("\n").filter(Boolean), (line) =>
      decodeEvent(line, path),
    );

    return yield* validateJournal(events);
  });
}

const appendUnlocked = (
  path: string,
  event: JournalEvent,
): Effect.Effect<JournalEvent, LearningError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const journal = yield* readJournal(path);
    yield* validateJournal([...journal.events, event]);
    yield* fs
      .writeFileString(path, "", { flag: "a", mode: 0o600 })
      .pipe(
        Effect.mapError((cause) =>
          learningError("journal.append", "unable to append journal", path, cause),
        ),
      );
    yield* fs
      .chmod(path, 0o600)
      .pipe(
        Effect.mapError((cause) =>
          learningError("journal.append", "unable to secure journal", path, cause),
        ),
      );
    yield* fs
      .writeFileString(path, `${JSON.stringify(event)}\n`, { flag: "a", mode: 0o600 })
      .pipe(
        Effect.mapError((cause) =>
          learningError("journal.append", "unable to append journal", path, cause),
        ),
      );

    return event;
  });

export function appendEvent(
  path: string,
  input: Schema.Json,
): Effect.Effect<JournalEvent, LearningError, FileSystem.FileSystem | Path.Path> {
  const decoded = Schema.decodeUnknownExit(JournalEventSchema)(input);

  if (!Exit.isSuccess(decoded))
    return Effect.fail(
      learningError("journal.schema", "invalid journal event", path, decoded.cause),
    );
  const lock = `${path}.lock`;

  const acquire = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* fs.makeDirectory(paths.dirname(path), { recursive: true, mode: 0o700 });
    yield* fs.makeDirectory(lock, { mode: 0o700 });

    return lock;
  }).pipe(
    Effect.mapError((cause) =>
      journalLockError("journal.lock", "journal is locked or cannot be prepared", lock, cause),
    ),
  );

  return Effect.acquireUseRelease(
    acquire,
    () => appendUnlocked(path, decoded.value),
    (held) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.remove(held, { recursive: true })),
        Effect.mapError((cause) =>
          journalLockError("journal.unlock", "unable to release journal lock", held, cause),
        ),
      ),
  );
}
