import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { command } from "./learning/cli.ts";

/** Run the command-line interface. Importing this module performs no actions. */
export function main(): void {
  BunRuntime.runMain(
    command(Bun.argv.slice(2)).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          // Effect causes can contain private input or provider bodies, so keep the public error generic.
          console.error(
            "stooart: command failed. Check arguments, input JSON, file access, and --jev configuration.",
          );
        }),
      ),
      Effect.provide(BunServices.layer),
    ),
    { disableErrorReporting: true },
  );
}
