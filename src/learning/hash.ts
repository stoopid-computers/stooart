import { NodeCrypto } from "@effect/platform-node";
import { Crypto, Effect, Encoding, Schema } from "effect";

const encoder = new TextEncoder();

export const sha256 = (input: string | Uint8Array): string =>
  Encoding.encodeHex(
    Effect.runSync(
      Effect.provide(
        Effect.flatMap(Crypto.Crypto, (crypto) =>
          crypto.digest("SHA-256", Schema.is(Schema.String)(input) ? encoder.encode(input) : input),
        ),
        NodeCrypto.layer,
      ),
    ),
  );
