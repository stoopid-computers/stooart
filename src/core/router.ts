import { Exit, Schema } from "effect";
import { TaskSchema, WorkerProfileSchema, type TaskInput, type WorkerInput } from "./schemas.ts";
import type {
  Recommendation,
  RejectedWorker,
  SelectorCandidate,
  SelectorRequest,
  SelectorResponse,
  Task,
  WorkerProfile,
} from "./types.ts";

export const POLICY_VERSION = "2";

export interface RoutingPreparation {
  readonly task: Task;
  readonly eligible: ReadonlyArray<WorkerProfile>;
  readonly rejected: ReadonlyArray<RejectedWorker>;
  readonly localReason?: string;
}

const local = (
  reason: string,
  rejected: ReadonlyArray<RejectedWorker> = [],
  eligible: ReadonlyArray<WorkerProfile> = [],
): Recommendation => ({
  executor: "local",
  model: null,
  effort: null,
  workerId: null,
  reason,
  eligibleWorkerIds: eligible.map((worker) => worker.id),
  rejected,
  policyVersion: POLICY_VERSION,
});

/** Decode and apply all policy gates before a classifier can see candidates. */
export const prepareRouting = (
  input: TaskInput,
  workers: ReadonlyArray<WorkerInput>,
  now = Date.now(),
): RoutingPreparation | Recommendation => {
  const parsedTask = Schema.decodeUnknownExit(TaskSchema)(input);

  if (!Exit.isSuccess(parsedTask)) return local("invalid task schema");
  const task = parsedTask.value;

  if (task.unresolved)
    return { task, eligible: [], rejected: [], localReason: "task has unresolved decisions" };

  if (
    task.goal.trim().length === 0 ||
    task.acceptance.length === 0 ||
    task.allowedPaths.length === 0 ||
    task.acceptance.some((item) => item.trim().length === 0) ||
    task.allowedPaths.some((path) => path.trim().length === 0)
  ) {
    return {
      task,
      eligible: [],
      rejected: [],
      localReason: "task scope or acceptance is incomplete",
    };
  }

  if (["research", "review", "diagnosis"].includes(task.kind) && !task.delegationRequested) {
    return {
      task,
      eligible: [],
      rejected: [],
      localReason: `${task.kind} stays local unless delegation is requested`,
    };
  }

  const rejected: RejectedWorker[] = [];
  const decoded: WorkerProfile[] = [];

  for (const candidate of workers) {
    const parsedWorker = Schema.decodeUnknownExit(WorkerProfileSchema)(candidate);

    if (!Exit.isSuccess(parsedWorker)) {
      rejected.push({ workerId: "unknown", reason: "invalid worker schema" });
      continue;
    }

    decoded.push(parsedWorker.value);
  }

  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const worker of decoded) {
    if (seenIds.has(worker.id)) duplicateIds.add(worker.id);
    seenIds.add(worker.id);
  }

  const eligible: WorkerProfile[] = [];

  for (const worker of decoded) {
    if (duplicateIds.has(worker.id))
      rejected.push({ workerId: worker.id, reason: "duplicate worker id" });
    else if (!worker.available)
      rejected.push({ workerId: worker.id, reason: "worker is unavailable" });
    else if (
      worker.health &&
      (!Number.isFinite(Date.parse(worker.health.observedAt)) ||
        !Number.isFinite(Date.parse(worker.health.retryAfter)) ||
        Date.parse(worker.health.observedAt) > now ||
        Date.parse(worker.health.retryAfter) < Date.parse(worker.health.observedAt))
    )
      rejected.push({ workerId: worker.id, reason: "invalid worker health evidence" });
    else if (worker.health && Date.parse(worker.health.retryAfter) > now)
      rejected.push({ workerId: worker.id, reason: `worker cooldown: ${worker.health.failure}` });
    else if (task.allowedProviders && !task.allowedProviders.includes(worker.provider)) {
      rejected.push({ workerId: worker.id, reason: "provider is not allowed" });
    } else if (!task.requiredTools.every((tool) => worker.tools.includes(tool))) {
      rejected.push({ workerId: worker.id, reason: "missing required tool" });
    } else if (worker.explicitOnly && task.preferredWorkerId !== worker.id) {
      rejected.push({ workerId: worker.id, reason: "worker requires explicit preference" });
    } else if (task.preferredWorkerId && worker.id !== task.preferredWorkerId) {
      rejected.push({ workerId: worker.id, reason: "another worker was explicitly preferred" });
    } else eligible.push(worker);
  }

  if (task.preferredWorkerId && eligible.length === 0) {
    return { task, eligible, rejected, localReason: "explicitly preferred worker is not eligible" };
  }

  const sortedEligible = eligible.sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
  );

  if (task.kind === "deterministic") return { task, eligible: sortedEligible, rejected };

  if (sortedEligible.length === 0)
    return { task, eligible: sortedEligible, rejected, localReason: "no eligible worker" };

  return { task, eligible: sortedEligible, rejected };
};

/** Give an optional classifier only a sanitized view of already eligible workers. */
export const selectorRequest = (
  task: Task,
  eligible: ReadonlyArray<WorkerProfile>,
): SelectorRequest => ({
  kind: task.kind,
  requiredTools: task.requiredTools,
  features: task.features,
  candidates: [...eligible]
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((worker): SelectorCandidate => ({
      id: worker.id,
      executor: worker.executor,
      model: worker.model,
      provider: worker.provider,
      effort: worker.effort,
    })),
});

const recommendationFor = (
  worker: WorkerProfile,
  reason: string,
  eligible: ReadonlyArray<WorkerProfile>,
  rejected: ReadonlyArray<RejectedWorker>,
): Recommendation => ({
  executor: worker.executor,
  model: worker.model,
  effort: worker.effort ?? null,
  workerId: worker.id,
  reason,
  eligibleWorkerIds: eligible.map((candidate) => candidate.id),
  rejected,
  policyVersion: POLICY_VERSION,
});

/** Route without an external classifier. This function has no execution effects. */
export const recommend = (
  input: TaskInput,
  workers: ReadonlyArray<WorkerInput>,
  now = Date.now(),
): Recommendation => {
  return recommendPrepared(prepareRouting(input, workers, now));
};

export const recommendPrepared = (
  prepared: RoutingPreparation | Recommendation,
): Recommendation => {
  if ("executor" in prepared) return prepared;

  if (prepared.localReason) return local(prepared.localReason, prepared.rejected);

  if (prepared.task.kind === "deterministic") {
    return {
      executor: "script",
      model: null,
      effort: null,
      workerId: null,
      reason: "deterministic task has explicit scope",
      eligibleWorkerIds: prepared.eligible.map((worker) => worker.id),
      rejected: prepared.rejected,
      policyVersion: POLICY_VERSION,
    };
  }

  const winner = prepared.eligible[0];

  if (!winner) return local("no eligible worker", prepared.rejected);

  return recommendationFor(
    winner,
    "selected by lowest priority, then worker id",
    prepared.eligible,
    prepared.rejected,
  );
};

/** Apply a classifier response after preparation. Invalid or uncertain choices stay local. */
export const recommendFromSelection = (
  input: TaskInput,
  workers: ReadonlyArray<WorkerInput>,
  response: SelectorResponse | undefined,
  allowedSelectionIds?: ReadonlyArray<string>,
): Recommendation => {
  const prepared = prepareRouting(input, workers);

  if ("executor" in prepared) return prepared;

  if (prepared.localReason || prepared.task.kind === "deterministic")
    return recommendPrepared(prepared);

  if (
    !response ||
    !Number.isFinite(response.confidence) ||
    response.confidence < 0.5 ||
    response.confidence > 1
  ) {
    return local(
      "classifier response is missing, malformed, or low confidence",
      prepared.rejected,
      prepared.eligible,
    );
  }

  const selected =
    allowedSelectionIds?.includes(response.workerId) === false
      ? undefined
      : prepared.eligible.find((worker) => worker.id === response.workerId);

  return selected
    ? recommendationFor(
        selected,
        "selected from policy-eligible workers by uncalibrated classifier confidence",
        prepared.eligible,
        prepared.rejected,
      )
    : local("classifier selected an ineligible worker", prepared.rejected, prepared.eligible);
};
