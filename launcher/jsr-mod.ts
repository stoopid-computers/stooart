import { Effect } from "effect";
import {
  launchWith,
  LaunchError,
  type LaunchOptions,
  type LaunchResult,
  type SpawnAdapter,
} from "./lifecycle.ts";

export { LaunchError };

export type { LaunchOptions, LaunchResult };

const signalNumbers = new Map(
  Object.entries({
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
  }),
);

const denoAdapter: SpawnAdapter = {
  spawn(executable, options) {
    let env: Record<string, string> | undefined;

    if (options.env !== undefined) {
      env = {};

      for (const [name, value] of Object.entries({ ...Deno.env.toObject(), ...options.env })) {
        if (value !== undefined) env[name] = value;
      }
    }

    const child = new Deno.Command(executable, {
      args: [...(options.args ?? [])],
      cwd: options.cwd,
      env,
      clearEnv: options.env !== undefined,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();

    return {
      exited: child.status.then((status) => ({
        exitCode:
          status.code || (status.signal ? 128 + (signalNumbers.get(status.signal) ?? 1) : 0),
        signal: status.signal,
      })),
      kill: (signal) => child.kill(signal),
    };
  },
  addSignalListener: (signal, listener) => Deno.addSignalListener(signal, listener),
  removeSignalListener: (signal, listener) => Deno.removeSignalListener(signal, listener),
};

/** Launch an installed executable with scoped signal forwarding and cancellation. */
export const launchEffect = (
  options: LaunchOptions = {},
): Effect.Effect<LaunchResult, LaunchError> => launchWith(denoAdapter, options);

/** Promise adapter for JSR consumers. The native executable must be installed separately. */
export const launch = (options: LaunchOptions = {}): Promise<LaunchResult> =>
  Effect.runPromise(launchEffect(options));

export default launch;
