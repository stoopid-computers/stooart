import { Data, Effect, Exit, Schema, type Cause } from "effect";
import type { Scope } from "effect";

export interface LaunchOptions {
  /** Defaults to `stooart` on PATH. */
  executable?: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface LaunchResult {
  exitCode: number;
  signal: string | null;
}

interface LaunchErrorFields {
  readonly executable: string;
  readonly message: string;
  readonly cause: unknown;
}

const LaunchErrorBase: new (
  fields: LaunchErrorFields,
) => Cause.YieldableError & LaunchErrorFields & { readonly _tag: "LaunchError" } = Data.TaggedError(
  "LaunchError",
)<LaunchErrorFields>;

export class LaunchError extends LaunchErrorBase {}

export class SpawnFailure extends Data.TaggedError("SpawnFailure")<{ readonly cause: unknown }> {}

const MissingExecutable = Schema.Union([
  Schema.Struct({ code: Schema.Literal("ENOENT") }),
  Schema.Struct({
    reason: Schema.Struct({ cause: Schema.Struct({ code: Schema.Literal("ENOENT") }) }),
  }),
]);

const launchError = (executable: string, cause: unknown): LaunchError =>
  new LaunchError({
    executable,
    message: Exit.isSuccess(Schema.decodeUnknownExit(MissingExecutable)(cause))
      ? `stooart executable not found: ${executable}`
      : `stooart executable failed: ${executable}`,
    cause,
  });

export interface SpawnedProcess {
  readonly exited: Effect.Effect<LaunchResult, SpawnFailure>;
  kill(signal: "SIGINT" | "SIGTERM"): Effect.Effect<void, SpawnFailure>;
}

export interface SpawnAdapter<R = never> {
  spawn(
    executable: string,
    options: LaunchOptions,
  ): Effect.Effect<SpawnedProcess, SpawnFailure, R | Scope.Scope>;
  addSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  removeSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}

/** Manage process signals, cancellation, and exit status for either runtime adapter. */
export const launchWith = <R>(
  adapter: SpawnAdapter<R>,
  options: LaunchOptions = {},
): Effect.Effect<LaunchResult, LaunchError, R> => {
  const executable = options.executable ?? "stooart";

  return Effect.scoped(
    Effect.acquireUseRelease(
      adapter.spawn(executable, options).pipe(
        Effect.mapError((error) => launchError(executable, error.cause)),
        Effect.map((child) => {
          const interrupt = () => Effect.runFork(child.kill("SIGINT"));
          const terminate = () => Effect.runFork(child.kill("SIGTERM"));

          adapter.addSignalListener("SIGINT", interrupt);
          adapter.addSignalListener("SIGTERM", terminate);

          return { child, interrupt, terminate, running: true };
        }),
      ),
      (resource) =>
        resource.child.exited.pipe(
          Effect.mapError((error) => launchError(executable, error.cause)),
          Effect.tap(() =>
            Effect.sync(() => {
              resource.running = false;
            }),
          ),
        ),
      ({ child, interrupt, terminate, running }) =>
        Effect.sync(() => {
          adapter.removeSignalListener("SIGINT", interrupt);
          adapter.removeSignalListener("SIGTERM", terminate);
        }).pipe(Effect.andThen(running ? Effect.ignore(child.kill("SIGTERM")) : Effect.void)),
    ),
  );
};
