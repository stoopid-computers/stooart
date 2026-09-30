import { Effect } from "effect";
import { POLICY_VERSION, recommend } from "../core/router.ts";
import type { Recommendation } from "../core/types.ts";
import type { Decision, LinkedOutcome } from "./contracts.ts";
import { restoreTask, type ValidatedJournal } from "./journal.ts";
import { learningError, type LearningError } from "./errors.ts";
import { recommendWithRecipes } from "./recipes.ts";

function group(decision: Decision): string {
  return JSON.stringify([
    decision.task.projectId ?? "unscoped",
    decision.task.groupId ?? decision.task.id,
  ]);
}

function score(
  recommendations: ReadonlyArray<{ decision: Decision; choice: Recommendation }>,
  outcomesByDecision: ReadonlyMap<string, ReadonlyArray<LinkedOutcome>>,
) {
  let matchedLoggedChoice = 0;
  let observedAttempts = 0;
  let verified = 0;
  let failed = 0;
  let accepted = 0;
  let environmentErrors = 0;
  let cancelled = 0;
  let unknown = 0;
  let corrections = 0;
  let elapsedMs = 0;
  let measuredCostUsd = 0;
  let costObservedAttempts = 0;
  let unobservedDecisions = 0;
  let recipeMatches = 0;

  for (const { decision, choice } of recommendations) {
    if (choice.recipeId) recipeMatches++;

    const match =
      choice.workerId === decision.recommendation.workerId &&
      choice.executor === decision.recommendation.executor &&
      choice.model === decision.recommendation.model &&
      choice.effort === decision.recommendation.effort;

    if (match) matchedLoggedChoice++;

    const outcomes = match ? (outcomesByDecision.get(decision.id) ?? []) : [];

    if (!outcomes.length) unobservedDecisions++;

    for (const event of outcomes) {
      observedAttempts++;

      if (event.status === "verified") verified++;

      if (event.status === "failed") failed++;

      if (event.status === "accepted") accepted++;

      if (event.status === "environment_error") environmentErrors++;

      if (event.status === "cancelled") cancelled++;

      if (event.status === "unknown") unknown++;
      corrections += event.correctionCount;
      elapsedMs += event.elapsedMs;

      if (event.costUsd !== undefined) {
        measuredCostUsd += event.costUsd;
        costObservedAttempts++;
      }
    }
  }

  return {
    decisions: recommendations.length,
    matchedLoggedChoice,
    unobservedDecisions,
    recipeMatches,
    observedAttempts,
    verified,
    failed,
    accepted,
    environmentErrors,
    cancelled,
    unknown,
    corrections,
    elapsedMs,
    measuredCostUsd: costObservedAttempts ? measuredCostUsd : null,
    costObservedAttempts,
    costUnknownAttempts: observedAttempts - costObservedAttempts,
  };
}

/** Offline decision replay only. It neither invokes models nor reruns historical commands. */
function evaluateUnchecked(journal: ValidatedJournal, cutoff: string, now: number) {
  const events = journal.events;
  const boundary = Date.parse(cutoff);
  const training = events.filter((event) => Date.parse(event.at) < boundary);

  const trainGroups = new Set(
    training.flatMap((event) => (event.type === "decision" ? [group(event)] : [])),
  );

  const candidates = events.filter(
    (event): event is Decision =>
      event.type === "decision" && Date.parse(event.at) >= boundary && Date.parse(event.at) <= now,
  );

  const heldout = candidates.filter((decision) => !trainGroups.has(group(decision)));

  const baseline = heldout.map((decision) => ({
    decision,
    choice: recommend(restoreTask(decision.task), decision.workers, Date.parse(decision.at)),
  }));

  const recipes = heldout.map((decision) => ({
    decision,
    choice: recommendWithRecipes(
      restoreTask(decision.task),
      decision.workers,
      journal,
      Date.parse(decision.at),
      boundary,
    ).recommendation,
  }));

  const loggedJev = heldout.flatMap((decision) =>
    decision.strategy === "jev" ? [{ decision, choice: decision.recommendation }] : [],
  );

  const observedOutcomes = new Map(
    [...journal.outcomesByDecision].map(([id, outcomes]) => [
      id,
      outcomes.filter((event) => Date.parse(event.at) <= now),
    ]),
  );

  const families = [
    ...new Set(heldout.map((decision) => decision.task.features?.family ?? "unspecified")),
  ].sort();

  return {
    evaluationVersion: 1,
    policyVersion: POLICY_VERSION,
    cutoff,
    mode: "offline_observational" as const,
    trainingDecisions: training.filter((event) => event.type === "decision").length,
    trainingOutcomes: training.filter((event) => event.type === "outcome").length,
    excludedRelatedDecisions: candidates.length - heldout.length,
    heldoutDecisions: heldout.length,
    priority: score(baseline, observedOutcomes),
    recipes: score(recipes, observedOutcomes),
    loggedJev: score(loggedJev, observedOutcomes),
    families: families.map((family) => ({
      family,
      priority: score(
        baseline.filter(
          ({ decision }) => (decision.task.features?.family ?? "unspecified") === family,
        ),
        observedOutcomes,
      ),
      recipes: score(
        recipes.filter(
          ({ decision }) => (decision.task.features?.family ?? "unspecified") === family,
        ),
        observedOutcomes,
      ),
      loggedJev: score(
        loggedJev.filter(
          ({ decision }) => (decision.task.features?.family ?? "unspecified") === family,
        ),
        observedOutcomes,
      ),
    })),
    limits: [
      "Only outcomes for the actually selected worker are observed; this is not a causal model benchmark.",
      "Recipes use only pre-cutoff evidence; related task groups are excluded from held-out decisions.",
      "Logged Jev results cover only decisions that actually invoked Jev, not necessarily the same task mix.",
      "Jev is not called by offline evaluation. Compare actual worker performance using separately authorized matched executions.",
    ],
  };
}

export function evaluateJournal(
  journal: ValidatedJournal,
  cutoff: string,
  now = Date.now(),
): Effect.Effect<ReturnType<typeof evaluateUnchecked>, LearningError> {
  return Effect.suspend(() => {
    const boundary = Date.parse(cutoff);

    return !Number.isFinite(boundary) ||
      new Date(boundary).toISOString() !== cutoff ||
      boundary > now
      ? Effect.fail(learningError("evaluation.cutoff", "expected a past ISO cutoff"))
      : Effect.succeed(evaluateUnchecked(journal, cutoff, now));
  });
}
