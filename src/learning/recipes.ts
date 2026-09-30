import { POLICY_VERSION, prepareRouting, recommendPrepared } from "../core/router.ts";
import type { TaskInput, WorkerInput } from "../core/schemas.ts";
import type { Task, TaskFeatures, WorkerProfile, Recommendation } from "../core/types.ts";
import type { Procedure } from "./contracts.ts";
import { sameWorker, type ValidatedJournal } from "./journal.ts";
import { sha256 } from "./hash.ts";

export const RECIPE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface Recipe {
  id: string;
  version: 1;
  projectId: string;
  kind: Task["kind"];
  features: TaskFeatures;
  requiredTools: string[];
  worker: WorkerProfile;
  procedure: Procedure;
  policyVersion: string;
  verified: number;
  failed: number;
  accepted: number;
  unknown: number;
  environmentErrors: number;
  cancelled: number;
  corrections: number;
  elapsedMs: number;
  measuredCostUsd: number | null;
  costObservedAttempts: number;
  attempts: number;
  evidenceIds: string[];
  verifiers: Array<{ id: string; version: string; requestSha256: string }>;
  failureKinds: string[];
  lastVerifiedAt: string | null;
  expiresAt: string | null;
}

export interface RecipeRecommendation {
  readonly recommendation: Recommendation;
  readonly matches: ReadonlyArray<Recipe>;
}

function featureKey(features: TaskFeatures): string {
  return JSON.stringify([features.family, features.scope, features.context, features.proof]);
}

function toolKey(tools: readonly string[]): string {
  return JSON.stringify([...new Set(tools)].sort());
}

/** Derive candidate procedures from the journal. This never executes or promotes a command. */
export function buildRecipes(
  journal: ValidatedJournal,
  now = Date.now(),
  before = Infinity,
): Recipe[] {
  const recipes = new Map<string, Recipe>();
  const recipesById = new Map<string, Recipe>();

  for (const event of journal.events) {
    if (event.type !== "outcome" || Date.parse(event.at) > now || Date.parse(event.at) >= before)
      continue;

    const decision = journal.decisions.get(event.decisionId);

    if (!decision) continue;
    const { task } = decision;

    if (
      !task.features ||
      !task.projectId ||
      !decision.recommendation.workerId ||
      decision.recommendation.policyVersion !== POLICY_VERSION
    )
      continue;

    const worker = decision.workers.find(
      (worker) => worker.id === decision.recommendation.workerId,
    );

    if (!worker) continue;

    const reused = decision.recommendation.recipeId
      ? recipesById.get(decision.recommendation.recipeId)
      : undefined;

    const procedure = event.procedure ?? reused?.procedure;

    if (!procedure) continue;

    const key = JSON.stringify([
      task.projectId,
      task.kind,
      featureKey(task.features),
      toolKey(task.requiredTools),
      worker.id,
      worker.executor,
      worker.model,
      worker.provider,
      worker.effort ?? null,
      toolKey(worker.tools),
      POLICY_VERSION,
      procedure.id,
      procedure.version,
    ]);

    let recipe = recipes.get(key);

    if (!recipe) {
      recipe = {
        id: `recipe-${sha256(key).slice(0, 24)}`,
        version: 1,
        projectId: task.projectId,
        kind: task.kind,
        features: task.features,
        requiredTools: [...task.requiredTools].sort(),
        worker,
        procedure,
        policyVersion: POLICY_VERSION,
        verified: 0,
        failed: 0,
        accepted: 0,
        unknown: 0,
        environmentErrors: 0,
        cancelled: 0,
        corrections: 0,
        elapsedMs: 0,
        measuredCostUsd: null,
        costObservedAttempts: 0,
        attempts: 0,
        evidenceIds: [],
        verifiers: [],
        failureKinds: [],
        lastVerifiedAt: null,
        expiresAt: null,
      };
      recipes.set(key, recipe);
      recipesById.set(recipe.id, recipe);
    }

    recipe.attempts++;
    recipe.elapsedMs += event.elapsedMs;
    recipe.corrections += event.correctionCount;

    if (event.costUsd !== undefined) {
      recipe.measuredCostUsd = (recipe.measuredCostUsd ?? 0) + event.costUsd;
      recipe.costObservedAttempts++;
    }

    recipe.evidenceIds.push(event.id);

    if (event.failureKind && !recipe.failureKinds.includes(event.failureKind))
      recipe.failureKinds.push(event.failureKind);

    if (event.status === "verified") {
      recipe.verified++;

      const receipt = journal.verifications.get(event.verificationId!)!;

      if (!recipe.lastVerifiedAt || receipt.at > recipe.lastVerifiedAt) {
        recipe.lastVerifiedAt = receipt.at;
        recipe.expiresAt = new Date(Date.parse(receipt.at) + RECIPE_TTL_MS).toISOString();
      }

      if (
        !recipe.verifiers.some(
          (verifier) => verifier.requestSha256 === receipt.verifier.requestSha256,
        )
      )
        recipe.verifiers.push(receipt.verifier);
    } else if (event.status === "environment_error") recipe.environmentErrors++;
    else if (event.status === "failed") recipe.failed++;
    else if (event.status === "accepted") recipe.accepted++;
    else if (event.status === "cancelled") recipe.cancelled++;
    else recipe.unknown++;
  }

  return [...recipes.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function recallRecipes(
  task: Task,
  workers: ReadonlyArray<WorkerProfile>,
  recipes: ReadonlyArray<Recipe>,
  now = Date.now(),
): Recipe[] {
  const prepared = prepareRouting(task, workers, now);

  if (
    !("eligible" in prepared) ||
    prepared.localReason ||
    task.kind === "deterministic" ||
    !task.features ||
    !task.projectId
  )
    return [];
  const features = task.features;

  const candidates = recipes.filter(
    (recipe) =>
      recipe.policyVersion === POLICY_VERSION &&
      recipe.verified > 0 &&
      recipe.expiresAt !== null &&
      Date.parse(recipe.expiresAt) > now &&
      recipe.projectId === task.projectId &&
      recipe.kind === task.kind &&
      featureKey(recipe.features) === featureKey(features) &&
      toolKey(recipe.requiredTools) === toolKey(task.requiredTools) &&
      prepared.eligible.some((worker) => sameWorker(worker, recipe.worker)),
  );

  // An observed rate is a sorting rule, not calibrated confidence. Denominators
  // and unknown outcomes remain visible to the caller.
  return candidates.sort(
    (a, b) =>
      b.verified / (b.verified + b.failed) - a.verified / (a.verified + a.failed) ||
      a.corrections / a.attempts - b.corrections / b.attempts ||
      b.verified - a.verified ||
      a.id.localeCompare(b.id),
  );
}

export function recommendWithRecipes(
  input: TaskInput,
  workers: ReadonlyArray<WorkerInput>,
  journal: ValidatedJournal,
  now = Date.now(),
  before = Infinity,
): RecipeRecommendation {
  const prepared = prepareRouting(input, workers, now);
  const baseline = recommendPrepared(prepared);

  if (!("eligible" in prepared) || prepared.localReason || baseline.executor === "script")
    return { recommendation: baseline, matches: [] };
  const task = prepared.task;
  const matches = recallRecipes(task, prepared.eligible, buildRecipes(journal, now, before), now);
  const recipe = matches[0];

  if (!recipe) return { recommendation: baseline, matches };
  const worker = prepared.eligible.find((candidate) => sameWorker(candidate, recipe.worker))!;

  return {
    recommendation: {
      ...baseline,
      executor: worker.executor,
      workerId: worker.id,
      model: worker.model,
      effort: worker.effort ?? null,
      recipeId: recipe.id,
      reason: `matching recipe: ${recipe.verified} verified, ${recipe.failed} failed, ${recipe.attempts} reported attempts; observational evidence`,
    },
    matches,
  };
}
