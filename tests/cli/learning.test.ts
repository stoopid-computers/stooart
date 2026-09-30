import { afterAll, expect, test } from "vitest";
import { run } from "./process.ts";
import { join, mkdtemp, mkdir, rm, writeFile } from "../platform.ts";

const directory = await mkdtemp("stooart-learning-cli-");

afterAll(() => rm(directory));

const request = {
  task: {
    id: "learning-fixture-task",
    kind: "implementation",
    goal: "Validate the learning fixture",
    acceptance: ["The fixture passes"],
    allowedPaths: ["src/fixture.ts"],
    requiredTools: ["edit", "test"],
    unresolved: false,
    delegationRequested: true,
    allowedProviders: ["fixture-provider"],
    projectId: "fixture-project",
    features: { family: "ci", scope: "small", context: "fresh", proof: "tests" },
  },
  workers: [
    {
      id: "fixture-worker",
      executor: "agent-runner",
      model: "fixture-model",
      provider: "fixture-provider",
      available: true,
      tools: ["edit", "test"],
      effort: "low",
      explicitOnly: false,
      priority: 10,
    },
  ],
};

async function history(journal: string) {
  const result = await run(["history", "--journal", journal]);
  expect(result.code).toBe(0);

  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function setup(name: string) {
  const cwd = join(directory, name);
  await mkdir(cwd);
  await writeFile(join(cwd, "artifact.txt"), "verified change\n");
  const journal = join(cwd, "journal.jsonl");
  const result = await run(["route", "-", "--journal", journal], request);
  expect(result.code).toBe(0);
  const decision = JSON.parse(result.stdout);

  return {
    cwd,
    journal,
    decision,
    verification: {
      decisionId: decision.decisionId,
      attemptId: `attempt-${name}`,
      artifactPath: "artifact.txt",
      verifier: {
        id: "fixture-test",
        version: "1",
        command: "/bin/sh",
        args: ["-c", "printf private-check-output; test -f artifact.txt"],
        cwd,
        timeoutMs: 1000,
      },
    },
  };
}

async function recordedRecipe(name: string) {
  const { journal, verification, decision } = await setup(name);
  const check = await run(["verify", "-", "--journal", journal], verification);
  expect(check.code).toBe(0);
  const receipt = JSON.parse(check.stdout);
  expect(receipt).toMatchObject({ passed: true, exitCode: 0, attemptId: verification.attemptId });

  const outcome = {
    decisionId: decision.decisionId,
    taskId: request.task.id,
    attemptId: verification.attemptId,
    workerId: "fixture-worker",
    status: "verified",
    verificationId: receipt.id,
    artifactSha256: receipt.artifact.sha256,
    elapsedMs: 100,
    correctionCount: 0,
    checks: ["fixture-test"],
    procedure: {
      id: "fixture-procedure",
      version: "1",
      steps: ["Reproduce", "Fix", "Verify"],
      preconditions: ["Existing test"],
    },
  };

  expect((await run(["record", "-", "--journal", journal], outcome)).code).toBe(0);

  return { journal, verification, decision, receipt, outcome };
}

test("a verified outcome becomes an opt-in recipe for a matching task", async () => {
  const { journal, outcome } = await recordedRecipe("complete");
  const recall = await run(["recall", "-", "--journal", journal], request);
  expect(recall.code).toBe(0);
  const recalledRecipe = JSON.parse(recall.stdout).matches[0];
  expect(recalledRecipe).toMatchObject({
    verified: 1,
    failed: 0,
    worker: { id: "fixture-worker" },
    procedure: outcome.procedure,
  });

  const route = await run(["route", "-", "--recipes", "--journal", journal], {
    ...request,
    task: { ...request.task, id: "new-task" },
  });

  expect(route.code).toBe(0);
  expect(JSON.parse(route.stdout)).toMatchObject({
    recipeId: recalledRecipe.id,
    workerId: recalledRecipe.worker.id,
  });
});

test("duplicate outcomes are rejected and journal history omits private inputs", async () => {
  const { journal, verification, decision, receipt, outcome } =
    await recordedRecipe("private-history");

  const beforeDuplicate = await history(journal);
  expect((await run(["record", "-", "--journal", journal], outcome)).code).toBe(1);
  const historyResult = await run(["history", "--journal", journal]);
  expect(historyResult.code).toBe(0);
  expect(historyResult.stdout).not.toContain("private-check-output");
  expect(historyResult.stdout).not.toContain(request.task.goal);
  expect(historyResult.stdout).not.toContain(request.task.allowedPaths[0]);
  const events = await history(journal);
  expect(events).toEqual(beforeDuplicate);
  expect(events.find((event) => event.type === "verification")).toMatchObject({
    decisionId: decision.decisionId,
    attemptId: verification.attemptId,
    passed: true,
  });
  expect(events.find((event) => event.type === "outcome")).toMatchObject({
    decisionId: decision.decisionId,
    verificationId: receipt.id,
    attemptId: verification.attemptId,
    status: "verified",
  });
});

test("offline evaluation counts verified and unobserved decisions", async () => {
  const { journal } = await recordedRecipe("evaluation");

  const route = await run(["route", "-", "--journal", journal], {
    ...request,
    task: { ...request.task, id: "new-task" },
  });

  expect(route.code).toBe(0);

  const evaluation = await run([
    "eval",
    "--journal",
    journal,
    "--after",
    "2000-01-01T00:00:00.000Z",
  ]);

  expect(evaluation.code).toBe(0);
  expect(JSON.parse(evaluation.stdout)).toMatchObject({
    evaluationVersion: 1,
    cutoff: "2000-01-01T00:00:00.000Z",
    trainingDecisions: 0,
    trainingOutcomes: 0,
    heldoutDecisions: 2,
    priority: { observedAttempts: 1, verified: 1, unobservedDecisions: 1 },
    recipes: { observedAttempts: 1, verified: 1 },
  });
});

test("recall excludes mismatched tasks and unavailable workers", async () => {
  const { journal } = await recordedRecipe("recall-mismatch");

  for (const mismatch of [
    { ...request, task: { ...request.task, projectId: "another-project" } },
    {
      ...request,
      task: { ...request.task, features: { ...request.task.features, proof: "visual" } },
    },
    { ...request, workers: [{ ...request.workers[0], model: "another-model" }] },
    { ...request, workers: [{ ...request.workers[0], available: false }] },
  ]) {
    const recalled = await run(["recall", "-", "--journal", journal], mismatch);
    expect(recalled.code).toBe(0);
    expect(JSON.parse(recalled.stdout).matches).toEqual([]);
  }
});

test("explicit worker preferences override recipe routing", async () => {
  const { journal } = await recordedRecipe("preference");

  const preferred = await run(["route", "-", "--recipes", "--journal", journal], {
    ...request,
    task: { ...request.task, preferredWorkerId: "another-worker" },
    workers: [...request.workers, { ...request.workers[0], id: "another-worker" }],
  });

  expect(preferred.code).toBe(0);
  expect(JSON.parse(preferred.stdout)).toMatchObject({ workerId: "another-worker" });
  expect(JSON.parse(preferred.stdout).recipeId).toBeUndefined();
});

test("failed recipe reuse remains visible in recall", async () => {
  const { journal } = await recordedRecipe("failed-reuse");
  const recall = await run(["recall", "-", "--journal", journal], request);
  expect(recall.code).toBe(0);
  const recalledRecipe = JSON.parse(recall.stdout).matches[0];

  const route = await run(["route", "-", "--recipes", "--journal", journal], {
    ...request,
    task: { ...request.task, id: "new-task" },
  });

  expect(route.code).toBe(0);

  const failedReuse = await run(["record", "-", "--journal", journal], {
    decisionId: JSON.parse(route.stdout).decisionId,
    taskId: "new-task",
    attemptId: "failed-reuse",
    workerId: "fixture-worker",
    status: "failed",
    elapsedMs: 40,
    correctionCount: 1,
    checks: ["fixture-test"],
  });

  expect(failedReuse.code).toBe(0);
  const afterFailure = await run(["recall", "-", "--journal", journal], request);
  expect(afterFailure.code).toBe(0);
  expect(JSON.parse(afterFailure.stdout).matches[0]).toMatchObject({
    id: recalledRecipe.id,
    verified: 1,
    failed: 1,
    attempts: 2,
    corrections: 1,
  });
});

test("verified outcomes require a matching recorded receipt", async () => {
  const { journal, decision, verification } = await setup("no-proof");

  const result = await run(["record", "-", "--journal", journal], {
    decisionId: decision.decisionId,
    taskId: request.task.id,
    workerId: "fixture-worker",
    attemptId: verification.attemptId,
    status: "verified",
    elapsedMs: 1,
    correctionCount: 0,
    checks: ["worker claims success"],
  });

  expect(result.code).toBe(1);
  const events = await history(journal);
  expect(events.find((event) => event.type === "decision")).toMatchObject({
    id: decision.decisionId,
  });
  expect(events.some((event) => event.type !== "decision")).toBe(false);
});

test("failed checks persist a failed receipt and return a nonzero exit", async () => {
  const { journal, verification } = await setup("failed");

  const result = await run(["verify", "-", "--journal", journal], {
    ...verification,
    verifier: { ...verification.verifier, args: ["-c", "printf private-failure >&2; exit 3"] },
  });

  expect(result.code).toBe(1);
  const receipt = JSON.parse(result.stdout);
  expect(receipt).toMatchObject({ passed: false, exitCode: 3, failure: "check_failed" });
  expect(result.stdout + result.stderr).not.toContain("private-failure");
  const events = await history(journal);
  expect(events.find((event) => event.type === "verification")).toMatchObject({
    type: "verification",
    id: receipt.id,
    decisionId: verification.decisionId,
    attemptId: verification.attemptId,
    passed: false,
    exitCode: 3,
    failure: "check_failed",
  });
});

test("verification binds the result artifact and rejects later changes", async () => {
  const { cwd, journal, verification, decision } = await setup("changed");
  const result = await run(["verify", "-", "--journal", journal], verification);
  expect(result.code).toBe(0);
  const receipt = JSON.parse(result.stdout);
  await writeFile(join(cwd, "artifact.txt"), "modified after check");

  const record = await run(["record", "-", "--journal", journal], {
    decisionId: decision.decisionId,
    taskId: request.task.id,
    workerId: "fixture-worker",
    attemptId: verification.attemptId,
    status: "verified",
    elapsedMs: 1,
    correctionCount: 0,
    checks: [],
    verificationId: receipt.id,
    artifactSha256: receipt.artifact.sha256,
  });

  expect(record.code).toBe(1);

  const mutated = await run(["verify", "-", "--journal", journal], {
    ...verification,
    attemptId: "mutating-check",
    verifier: { ...verification.verifier, args: ["-c", "printf altered > artifact.txt"] },
  });

  expect(mutated.code).toBe(1);
  expect(JSON.parse(mutated.stdout).failure).toBe("artifact_changed");
});

test("verification reports a missing executable", async () => {
  const { journal, verification } = await setup("missing-executable");

  const verifier = {
    ...verification.verifier,
    command: join(directory, "missing-executable"),
    args: [],
  };

  const result = await run(["verify", "-", "--journal", journal], { ...verification, verifier });

  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ passed: false, failure: "execution_error" });
});

test("verification hashes a source directory and detects added files", async () => {
  const { cwd, journal, verification } = await setup("directory");
  const source = join(cwd, "source");
  await mkdir(source);
  await writeFile(join(source, "code.txt"), "original source");

  const checked = await run(["verify", "-", "--journal", journal], {
    ...verification,
    artifactPath: "source",
  });

  expect(checked.code).toBe(0);

  const changed = await run(["verify", "-", "--journal", journal], {
    ...verification,
    artifactPath: "source",
    attemptId: "changing-source",
    verifier: { ...verification.verifier, args: ["-c", "printf added > source/new.txt"] },
  });

  expect(changed.code).toBe(1);
  expect(JSON.parse(changed.stdout).failure).toBe("artifact_changed");
});

test("concurrent journal writers never lose an acknowledged decision", async () => {
  const journal = join(directory, "concurrent.jsonl");

  const results = await Promise.all(
    Array.from({ length: 4 }, () => run(["route", "-", "--journal", journal], request)),
  );

  const successful = results.filter((result) => result.code === 0);
  expect(successful.length).toBeGreaterThan(0);
  const acknowledgedIds = successful.map((result) => JSON.parse(result.stdout).decisionId);
  const events = await history(journal);
  expect(new Set(events.flatMap((event) => (event.type === "decision" ? [event.id] : [])))).toEqual(
    new Set(acknowledgedIds),
  );
});

test("recipe and Jev flags cannot be combined, and missing credentials return a typed abstention", async () => {
  expect(
    (
      await run(
        ["route", "-", "--recipes", "--jev", "--journal", join(directory, "flags.jsonl")],
        request,
      )
    ).code,
  ).toBe(1);

  const result = await run(["route", "-", "--jev"], {
    ...request,
    workers: [...request.workers, { ...request.workers[0], id: "another" }],
  });

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    executor: "local",
    failureKind: "authentication",
  });
});

test("a changed procedure needs a new version", async () => {
  const { journal, decision } = await setup("procedure-version");

  const outcome = {
    decisionId: decision.decisionId,
    taskId: request.task.id,
    workerId: "fixture-worker",
    attemptId: "procedure-one",
    status: "accepted",
    elapsedMs: 1,
    correctionCount: 0,
    checks: [],
    procedure: {
      id: "repeatable-check",
      version: "1",
      steps: ["Run the check"],
      preconditions: [],
    },
  };

  expect((await run(["record", "-", "--journal", journal], outcome)).code).toBe(0);

  const changed = {
    ...outcome,
    attemptId: "procedure-two",
    procedure: { ...outcome.procedure, steps: ["Run a different check"] },
  };

  expect((await run(["record", "-", "--journal", journal], changed)).code).toBe(1);
  const versioned = { ...changed, procedure: { ...changed.procedure, version: "2" } };
  expect((await run(["record", "-", "--journal", journal], versioned)).code).toBe(0);
  const events = await history(journal);
  expect(events.flatMap((event) => (event.type === "outcome" ? [event.attemptId] : []))).toEqual([
    "procedure-one",
    "procedure-two",
  ]);
  const recalled = await run(["recall", "-", "--journal", journal], request);
  expect(recalled.code).toBe(0);
  expect(JSON.parse(recalled.stdout).matches).toEqual([]);
});
