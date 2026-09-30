import { Effect, Exit, Schema } from "effect";
import {
  choice,
  type ChoiceQuestion,
  type ChoiceResponse,
  type SystemOneRequest,
  type TypeSafeError,
} from "@compootor/effective-jev";
import {
  prepareRouting,
  recommendPrepared,
  recommendFromSelection,
  selectorRequest,
} from "./router.ts";
import type { Recommendation, SelectorResponse } from "./types.ts";
import { classifyProviderFailure } from "./failures.ts";
import type { TaskInput, WorkerInput } from "./schemas.ts";

export interface WorkerSelectorClient {
  readonly systemOne: (
    request: SystemOneRequest<{ worker: ChoiceQuestion }>,
  ) => Effect.Effect<{ readonly answers: { readonly worker: ChoiceResponse } }, TypeSafeError>;
}

const probability = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1),
);

const ChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  confidence: probability,
  probabilities: Schema.Record(Schema.String, probability),
});

const selectionFromAnswer = (
  answer: ChoiceResponse,
  candidateIds: ReadonlyArray<string>,
): SelectorResponse | undefined => {
  const decoded = Schema.decodeExit(ChoiceAnswer)(answer);

  if (Exit.isFailure(decoded)) return undefined;
  const value = decoded.value;
  const choiceId = value.choice;

  if (!candidateIds.includes(choiceId)) return undefined;
  const probabilities = value.probabilities;

  if (
    Object.keys(probabilities).length !== candidateIds.length ||
    !candidateIds.every((id) => Object.hasOwn(probabilities, id))
  )
    return undefined;
  const total = candidateIds.reduce((sum, id) => sum + probabilities[id], 0);

  if (Math.abs(total - 1) > 0.02) return undefined;

  if (!candidateIds.every((id) => probabilities[choiceId] >= probabilities[id])) return undefined;

  return { workerId: choiceId, confidence: value.confidence };
};

/** Ask Jev to choose among policy-eligible candidates. The request excludes task goals and source. */
export const recommendWithJev = (
  input: TaskInput,
  workers: ReadonlyArray<WorkerInput>,
  client: WorkerSelectorClient,
): Effect.Effect<Recommendation> => {
  const prepared = prepareRouting(input, workers);

  if (
    "executor" in prepared ||
    prepared.localReason ||
    prepared.task.kind === "deterministic" ||
    prepared.eligible.length <= 1
  ) {
    return Effect.succeed(recommendPrepared(prepared));
  }

  const request = selectorRequest(prepared.task, prepared.eligible);

  const criteria = Object.fromEntries(
    request.candidates.map((candidate) => [
      candidate.id,
      `${candidate.executor} ${candidate.model} via ${candidate.provider}`,
    ]),
  );

  return client
    .systemOne({
      state: JSON.stringify(request),
      questions: { worker: choice("Choose one eligible worker.", criteria) },
    })
    .pipe(
      Effect.map((result) => {
        const candidateIds = request.candidates.map((candidate) => candidate.id);
        const response = selectionFromAnswer(result.answers.worker, candidateIds);
        const recommendation = recommendFromSelection(input, workers, response, candidateIds);

        if (response && response.confidence >= 0.5) return recommendation;

        return {
          ...recommendation,
          failureKind: response ? ("low_confidence" as const) : ("malformed_response" as const),
        };
      }),
      Effect.catch((error) => {
        const failureKind = classifyProviderFailure(error);

        return Effect.succeed({
          ...recommendFromSelection(input, workers, undefined),
          reason: `Jev unavailable: ${failureKind}`,
          failureKind,
        });
      }),
    );
};
