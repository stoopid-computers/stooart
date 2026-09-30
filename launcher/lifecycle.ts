import { Data, Effect, Exit, Schema, type Cause } from "effect";

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

const MissingExecutable = Schema.Struct({ code: Schema.Literal("ENOENT") });

const launchError = (executable: string, cause: unknown): LaunchError =>
  new LaunchError({
    executable,
    message: Exit.isSuccess(Schema.decodeUnknownExit(MissingExecutable)(cause))
      ? `stooart executable not found: ${executable}`
      : `stooart executable failed: ${executable}`,
    cause,
  });

export interface SpawnedProcess {
  readonly exited: Promise<LaunchResult>;
  kill(signal: "SIGINT" | "SIGTERM"): void;
}

export interface SpawnAdapter {
  spawn(executable: string, options: LaunchOptions): SpawnedProcess;
  addSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  removeSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
}

/** Manage process signals, cancellation, and exit status for either runtime adapter. */
export const launchWith = (
  adapter: SpawnAdapter,
  options: LaunchOptions = {},
): Effect.Effect<LaunchResult, LaunchError> => {
  const executable = options.executable ?? "stooart";

  return Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const child = adapter.spawn(executable, options);
        const interrupt = () => child.kill("SIGINT");
        const terminate = () => child.kill("SIGTERM");
        adapter.addSignalListener("SIGINT", interrupt);
        adapter.addSignalListener("SIGTERM", terminate);

        return { child, interrupt, terminate, running: true };
      },
      catch: (cause) => launchError(executable, cause),
    }),
    (resource) =>
      Effect.tryPromise({
        try: () => resource.child.exited,
        catch: (cause) => launchError(executable, cause),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            resource.running = false;
          }),
        ),
      ),
    ({ child, interrupt, terminate, running }) =>
      Effect.try({
        try: () => {
          adapter.removeSignalListener("SIGINT", interrupt);
          adapter.removeSignalListener("SIGTERM", terminate);

          if (running) child.kill("SIGTERM");
        },
        catch: (cause) => launchError(executable, cause),
      }),
  );
};
