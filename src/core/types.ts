/** The kind of work the router is asked to recommend a worker for. */
export type TaskKind = "implementation" | "research" | "review" | "diagnosis" | "deterministic";

export interface TaskFeatures {
  readonly family: "ci" | "bugfix" | "migration" | "ui" | "integration" | "tests" | "other";
  readonly scope: "small" | "medium" | "large";
  readonly context: "fresh" | "existing";
  readonly proof: "tests" | "visual" | "review" | "mixed";
}

export type FailureKind =
  | "authentication"
  | "rate_limit"
  | "quota"
  | "timeout"
  | "transport"
  | "provider"
  | "malformed_response"
  | "low_confidence"
  | "verification"
  | "implementation";

/** Caller-observed health. Expiry does not assert that access has recovered. */
export interface WorkerHealth {
  readonly failure: FailureKind;
  readonly observedAt: string;
  readonly retryAfter: string;
}

/** A structured, source-free description of work. */
export interface Task {
  readonly id: string;
  readonly kind: TaskKind;
  readonly goal: string;
  readonly acceptance: ReadonlyArray<string>;
  readonly allowedPaths: ReadonlyArray<string>;
  readonly requiredTools: ReadonlyArray<string>;
  readonly unresolved: boolean;
  readonly delegationRequested: boolean;
  readonly preferredWorkerId?: string;
  readonly allowedProviders?: ReadonlyArray<string>;
  readonly features?: TaskFeatures;
  readonly projectId?: string;
  readonly groupId?: string;
}

/** Caller-defined runner identifier. `local` and `script` are reserved decisions. */
export type Executor = string;

/** A worker that may be selected after policy checks. */
export interface WorkerProfile {
  readonly id: string;
  readonly executor: Executor;
  readonly model: string;
  readonly provider: string;
  readonly available: boolean;
  readonly tools: ReadonlyArray<string>;
  readonly effort?: string;
  readonly explicitOnly: boolean;
  readonly priority: number;
  readonly health?: WorkerHealth;
}

export type RecommendationExecutor = Executor;

export interface RejectedWorker {
  readonly workerId: string;
  readonly reason: string;
}

/** A recommendation. It never launches a worker or runs a command. */
export interface Recommendation {
  readonly executor: RecommendationExecutor;
  readonly model: string | null;
  readonly effort: string | null;
  readonly workerId: string | null;
  readonly reason: string;
  readonly eligibleWorkerIds: ReadonlyArray<string>;
  readonly rejected: ReadonlyArray<RejectedWorker>;
  readonly policyVersion: string;
  readonly failureKind?: FailureKind;
  readonly recipeId?: string;
}

export type OutcomeStatus =
  | "verified"
  | "accepted"
  | "failed"
  | "environment_error"
  | "cancelled"
  | "unknown";

/** A compact record of an attempted recommendation. */
export interface Outcome {
  readonly taskId: string;
  readonly attemptId: string;
  readonly workerId?: string;
  readonly status: OutcomeStatus;
  readonly elapsedMs: number;
  readonly checks: ReadonlyArray<string>;
  readonly correctionCount: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface SelectorCandidate {
  readonly id: string;
  readonly executor: Executor;
  readonly model: string;
  readonly provider: string;
  readonly effort?: string;
}

/** Sanitized data a classifier may inspect. No goal, source, or secret is included. */
export interface SelectorRequest {
  readonly kind: TaskKind;
  readonly requiredTools: ReadonlyArray<string>;
  readonly features?: TaskFeatures;
  readonly candidates: ReadonlyArray<SelectorCandidate>;
}

/** An optional choice from a classifier. Confidence has no calibrated meaning. */
export interface SelectorResponse {
  readonly workerId: string;
  readonly confidence: number;
}
