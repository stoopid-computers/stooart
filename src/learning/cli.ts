import { Effect, Exit, FileSystem, Path, Schema, Stdio, Stream, Terminal } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { TypeSafeClient } from "@compootor/effective-jev";
import { recommendWithJev } from "../core/jev.ts";
import { recommend } from "../core/router.ts";
import { OutcomeSchema, TaskSchema, WorkerProfileSchema } from "../core/schemas.ts";
import { VERSION } from "../version.ts";
import { LinkedOutcomeInputSchema, type Decision } from "./contracts.ts";
import { appendEvent, newId, readJournal, snapshotTask } from "./journal.ts";
import { artifactHash, verifyAttempt } from "./verify.ts";
import { buildRecipes, recommendWithRecipes } from "./recipes.ts";
import { readCredential, removeCredential, saveCredential } from "./credentials.ts";
import { evaluateJournal } from "./evaluate.ts";
import {
  cliError,
  journalSchemaError,
  learningError,
  verificationError,
  type LearningError,
  type LearningFailure,
  type CheckError,
  type ArtifactError,
  type VerificationError,
} from "./errors.ts";

const help = `stooart ${VERSION}
Policy-first task routing. Commands recommend workers; they do not launch them.

  stooart route <request.json|-> [--jev|--recipes] [--journal <file>]
  stooart jev setup             Save a TypeSafe key from hidden stdin
  stooart jev remove            Delete the saved TypeSafe key
  stooart record <outcome.json|-> [--log <file>]
  stooart record <linked-outcome.json|-> --journal <file>
  stooart verify <verification-request.json|-> --journal <file>
  stooart recall <request.json|-> --journal <file>
  stooart recipes --journal <file>
  stooart eval --journal <file> --after <ISO-timestamp>
  stooart history [--log <file>]
  stooart history --journal <file>
  stooart --version
`;

const parseJson = (text: string, path: string): Effect.Effect<Schema.Json, LearningFailure> =>
  Effect.try({
    try: () => JSON.parse(text),
    catch: (cause) => journalSchemaError("json.parse", "invalid JSON input", path, cause),
  }).pipe(
    Effect.flatMap((value) => {
      const decoded = Schema.decodeUnknownExit(Schema.Json)(value);

      return Exit.isSuccess(decoded)
        ? Effect.succeed(decoded.value)
        : Effect.fail(journalSchemaError("json.schema", "input is not JSON", path, decoded.cause));
    }),
  );

const readJson = (
  path: string,
): Effect.Effect<Schema.Json, LearningFailure, FileSystem.FileSystem | Stdio.Stdio> =>
  Effect.gen(function* () {
    let text: string;

    if (path === "-") {
      const stdio = yield* Stdio.Stdio;
      text = yield* Stream.mkString(Stream.decodeText(stdio.stdin)).pipe(
        Effect.mapError((cause) => learningError("json.read", "unable to read input", path, cause)),
      );
    } else {
      const fs = yield* FileSystem.FileSystem;
      text = yield* fs
        .readFileString(path)
        .pipe(
          Effect.mapError((cause) =>
            learningError("json.read", "unable to read input", path, cause),
          ),
        );
    }

    return yield* parseJson(text, path);
  });

const print = <A>(value: A): Effect.Effect<void, LearningError, Terminal.Terminal> =>
  Terminal.Terminal.pipe(
    Effect.flatMap((terminal) => terminal.display(`${JSON.stringify(value)}\n`)),
    Effect.mapError((cause) =>
      learningError("cli.print", "unable to write output", undefined, cause),
    ),
  );

const RouteRequestSchema = Schema.Struct({ task: Schema.Json, workers: Schema.Array(Schema.Json) });

type Options = {
  readonly flags: ReadonlyMap<string, string | true>;
  readonly files: ReadonlyArray<string>;
};

function options(
  args: readonly string[],
  switches: readonly string[],
  values: readonly string[],
  positional: number,
): Effect.Effect<Options, LearningError> {
  return Effect.gen(function* () {
    const flags = new Map<string, string | true>();
    const files: string[] = [];

    for (let index = 0; index < args.length; index++) {
      const arg = args[index];

      if (arg.startsWith("--")) {
        if (flags.has(arg)) return yield* cliError("cli.options", "duplicate option");

        if (switches.includes(arg)) flags.set(arg, true);
        else if (
          values.includes(arg) &&
          args[index + 1] !== undefined &&
          !args[index + 1].startsWith("--")
        )
          flags.set(arg, args[++index]);
        else return yield* cliError("cli.options", "unknown or incomplete option");
      } else files.push(arg);
    }

    if (files.length !== positional)
      return yield* cliError("cli.options", "unexpected positional arguments");

    return { flags, files };
  });
}

function required(
  flags: ReadonlyMap<string, string | true>,
  name: string,
): Effect.Effect<string, LearningError> {
  const value = flags.get(name);

  return value !== undefined && value !== true && value.trim()
    ? Effect.succeed(value)
    : Effect.fail(cliError("cli.options", `expected ${name}`));
}

const decode = <A>(
  schema: Schema.ConstraintDecoder<A>,
  value: Schema.Json,
  detail: string,
): Effect.Effect<A, LearningError> => {
  const result = Schema.decodeExit(schema)(value);

  return Exit.isSuccess(result)
    ? Effect.succeed(result.value)
    : Effect.fail(journalSchemaError("cli.schema", detail, undefined, result.cause));
};

function journalCommand(
  name: string | undefined,
  args: readonly string[],
): Effect.Effect<
  boolean,
  LearningError | CheckError | ArtifactError | VerificationError,
  | FileSystem.FileSystem
  | Path.Path
  | Stdio.Stdio
  | Terminal.Terminal
  | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    if (name === "route" || name === "recall") {
      const parsed = yield* options(
        args,
        name === "route" ? ["--jev", "--recipes"] : [],
        ["--journal"],
        1,
      );

      if (parsed.flags.has("--jev") && parsed.flags.has("--recipes"))
        return yield* cliError("cli.options", "choose --jev or --recipes");

      const request = yield* decode(
        RouteRequestSchema,
        yield* readJson(parsed.files[0]),
        "expected task and workers",
      );

      const now = Date.now();
      let recommendation = recommend(request.task, request.workers, now);
      let strategy: Decision["strategy"] = "priority";

      if (name === "recall" || parsed.flags.has("--recipes")) {
        const journalPath = yield* required(parsed.flags, "--journal");
        const journal = yield* readJournal(journalPath);
        const result = recommendWithRecipes(request.task, request.workers, journal, now);

        if (name === "recall") {
          yield* print(result);

          return true;
        }

        recommendation = result.recommendation;
        strategy = "recipes";
      } else if (
        parsed.flags.has("--jev") &&
        recommendation.executor !== "local" &&
        recommendation.executor !== "script" &&
        recommendation.eligibleWorkerIds.length > 1
      ) {
        strategy = "jev";

        const apiKey =
          Bun.env.TYPESAFE_API_KEY !== undefined ? Bun.env.TYPESAFE_API_KEY : yield* readCredential;

        if (!apiKey)
          recommendation = {
            ...recommendation,
            executor: "local",
            model: null,
            effort: null,
            workerId: null,
            reason: "Jev unavailable: authentication",
            failureKind: "authentication",
          };
        else {
          const fetchOptions =
            Bun.env.TYPESAFE_BASE_URL === undefined
              ? { apiKey, timeout: 10_000, retry: { maxRetries: 0 } }
              : {
                  apiKey,
                  baseURL: Bun.env.TYPESAFE_BASE_URL,
                  timeout: 10_000,
                  retry: { maxRetries: 0 },
                };

          const jevRecommendation = yield* TypeSafeClient.use((client) =>
            recommendWithJev(request.task, request.workers, client),
          ).pipe(
            Effect.provide(TypeSafeClient.layerFetch(fetchOptions)),
            Effect.orElseSucceed(() => null),
          );

          if (jevRecommendation) recommendation = jevRecommendation;
          else
            recommendation = {
              ...recommendation,
              executor: "local",
              model: null,
              effort: null,
              workerId: null,
              reason: "Jev unavailable: provider",
              failureKind: "provider",
            };
        }
      }

      const journalFlag = parsed.flags.get("--journal");

      if (journalFlag !== undefined && journalFlag !== true) {
        const task = yield* decode(TaskSchema, request.task, "invalid task schema");

        const workers = yield* decode(
          Schema.Array(WorkerProfileSchema),
          request.workers,
          "invalid worker schema",
        );

        const decision: Decision = {
          type: "decision",
          schemaVersion: 1,
          id: newId("decision"),
          at: new Date().toISOString(),
          task: snapshotTask(task),
          workers,
          recommendation,
          strategy,
        };

        yield* appendEvent(journalFlag, decision);
        yield* print({ ...recommendation, decisionId: decision.id, recordedAt: decision.at });
      } else yield* print(recommendation);

      return true;
    }

    if (name === "record" && args.includes("--journal")) {
      const parsed = yield* options(args, [], ["--journal"], 1);
      const path = yield* required(parsed.flags, "--journal");

      const outcome = yield* decode(
        LinkedOutcomeInputSchema,
        yield* readJson(parsed.files[0]),
        "invalid linked outcome",
      );

      if (outcome.status === "verified") {
        const receipt = (yield* readJournal(path)).verifications.get(outcome.verificationId!);

        if (
          !receipt ||
          !receipt.passed ||
          (yield* artifactHash(receipt.artifact.path)) !== receipt.artifact.sha256
        )
          return yield* verificationError(
            "outcome.evidence",
            "missing or stale verification artifact",
          );
      }

      const event = yield* appendEvent(path, {
        ...outcome,
        type: "outcome",
        schemaVersion: 1,
        id: newId("outcome"),
        at: new Date().toISOString(),
      });

      yield* print({
        recorded: true,
        id: event.id,
        decisionId: outcome.decisionId,
        attemptId: outcome.attemptId,
      });

      return true;
    }

    if (name === "verify") {
      const parsed = yield* options(args, [], ["--journal"], 1);

      const receipt = yield* verifyAttempt(
        yield* required(parsed.flags, "--journal"),
        yield* readJson(parsed.files[0]),
      );

      yield* print(receipt);

      if (!receipt.passed)
        return yield* verificationError("verification.failed", "verification checks failed");

      return true;
    }

    if (name === "recipes" || (name === "history" && args.includes("--journal"))) {
      const parsed = yield* options(args, [], ["--journal"], 0);
      const journal = yield* readJournal(yield* required(parsed.flags, "--journal"));

      if (name === "recipes") yield* print(buildRecipes(journal));
      else for (const event of journal.events) yield* print(event);

      return true;
    }

    if (name === "eval") {
      const parsed = yield* options(args, [], ["--journal", "--after"], 0);
      const journal = yield* readJournal(yield* required(parsed.flags, "--journal"));
      yield* print(yield* evaluateJournal(journal, yield* required(parsed.flags, "--after")));

      return true;
    }

    return false;
  });
}

function logPath(args: ReadonlyArray<string>): Effect.Effect<string, LearningFailure, Path.Path> {
  if (args.length === 0)
    return Path.Path.pipe(
      Effect.map((paths) =>
        paths.join(Bun.env.HOME ?? ".", ".local", "state", "stooart", "outcomes.jsonl"),
      ),
    );

  return args.length === 2 && args[0] === "--log" && Boolean(args[1])
    ? Effect.succeed(args[1])
    : Effect.fail(cliError("cli.options", "expected --log <file>"));
}

/** Run a CLI command using the provided Effect runtime services. */
export function command(
  args: ReadonlyArray<string>,
): Effect.Effect<
  void,
  LearningFailure,
  | FileSystem.FileSystem
  | Path.Path
  | Stdio.Stdio
  | Terminal.Terminal
  | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const [name, ...rest] = args;

    if (!name || name === "--help" || name === "-h") {
      yield* Terminal.Terminal.pipe(
        Effect.flatMap((terminal) => terminal.display(help)),
        Effect.mapError((cause) =>
          learningError("cli.print", "unable to write help", undefined, cause),
        ),
      );

      return;
    }

    if (name === "jev" && rest[0] === "setup") {
      if (rest.length !== 1) return yield* cliError("cli.options", "expected jev setup");
      const terminal = yield* Terminal.Terminal;
      yield* terminal
        .display("TypeSafe API key: ")
        .pipe(
          Effect.mapError((cause) =>
            learningError("cli.print", "unable to write prompt", undefined, cause),
          ),
        );

      const key = yield* terminal.readLine.pipe(
        Effect.map((value) => value.trim()),
        Effect.mapError((cause) =>
          learningError("jev.credentials", "unable to read TypeSafe credential", undefined, cause),
        ),
      );

      if (!key) return yield* cliError("jev.credentials", "empty TypeSafe credential");
      yield* saveCredential(key);
      yield* Terminal.Terminal.pipe(
        Effect.flatMap((terminal) => terminal.display("TypeSafe credential saved.\n")),
        Effect.mapError((cause) =>
          learningError("cli.print", "unable to write output", undefined, cause),
        ),
      );

      return;
    }

    if (name === "jev" && rest[0] === "remove") {
      if (rest.length !== 1) return yield* cliError("cli.options", "expected jev remove");
      const removed = yield* removeCredential;
      yield* Terminal.Terminal.pipe(
        Effect.flatMap((terminal) =>
          terminal.display(
            removed ? "Saved TypeSafe credential removed.\n" : "No saved TypeSafe credential.\n",
          ),
        ),
        Effect.mapError((cause) =>
          learningError("cli.print", "unable to write output", undefined, cause),
        ),
      );

      return;
    }

    if (name === "--version" || name === "-v") {
      yield* Terminal.Terminal.pipe(
        Effect.flatMap((terminal) => terminal.display(`${VERSION}\n`)),
        Effect.mapError((cause) =>
          learningError("cli.print", "unable to write version", undefined, cause),
        ),
      );

      return;
    }

    if (yield* journalCommand(name, rest)) return;

    if (name === "record") {
      if (!rest[0])
        return yield* cliError("cli.options", "expected record <outcome.json|-> [--log <file>]");
      const input = yield* readJson(rest[0]);
      const decoded = Schema.decodeUnknownExit(OutcomeSchema)(input);

      if (!Exit.isSuccess(decoded))
        return yield* journalSchemaError(
          "outcome.schema",
          "invalid outcome",
          rest[0],
          decoded.cause,
        );
      const path = yield* logPath(rest.slice(1));
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      yield* fs
        .makeDirectory(paths.dirname(path), { recursive: true, mode: 0o700 })
        .pipe(
          Effect.mapError((cause) =>
            learningError("outcome.append", "unable to prepare outcome directory", path, cause),
          ),
        );
      yield* fs
        .writeFileString(path, "", { flag: "a", mode: 0o600 })
        .pipe(
          Effect.mapError((cause) =>
            learningError("outcome.append", "unable to record outcome", path, cause),
          ),
        );
      yield* fs
        .chmod(path, 0o600)
        .pipe(
          Effect.mapError((cause) =>
            learningError("outcome.append", "unable to secure outcome log", path, cause),
          ),
        );
      yield* fs
        .writeFileString(
          path,
          `${JSON.stringify({ ...decoded.value, recordedAt: new Date().toISOString() })}\n`,
          { flag: "a", mode: 0o600 },
        )
        .pipe(
          Effect.mapError((cause) =>
            learningError("outcome.append", "unable to record outcome", path, cause),
          ),
        );
      yield* print({
        recorded: true,
        taskId: decoded.value.taskId,
        attemptId: decoded.value.attemptId,
        path,
      });

      return;
    }

    if (name === "history") {
      const path = yield* logPath(rest);
      const fs = yield* FileSystem.FileSystem;

      const text = yield* fs
        .readFileString(path)
        .pipe(
          Effect.mapError((cause) =>
            learningError("outcome.read", "unable to read outcome history", path, cause),
          ),
        );

      for (const line of text.split("\n").filter((item) => item.trim() !== "")) {
        const decoded = Schema.decodeUnknownExit(OutcomeSchema)(yield* parseJson(line, path));

        if (!Exit.isSuccess(decoded))
          return yield* journalSchemaError(
            "outcome.schema",
            "invalid outcome history record",
            path,
            decoded.cause,
          );
        yield* print(decoded.value);
      }

      return;
    }

    return yield* cliError("cli.command", `unknown command: ${name}`);
  });
}
