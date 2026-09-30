#!/usr/bin/env -S deno run --allow-run=stooart
import { Console, Effect } from "effect";
import { launchEffect } from "./jsr-mod.ts";

await Effect.runPromise(
  launchEffect({ args: Deno.args }).pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Console.error(error.message).pipe(
          Effect.andThen(
            Effect.sync(() => {
              Deno.exitCode = 1;
            }),
          ),
        ),
      onSuccess: ({ exitCode }) =>
        Effect.sync(() => {
          Deno.exitCode = exitCode;
        }),
    }),
  ),
);
