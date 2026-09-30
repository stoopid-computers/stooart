import { afterAll, expect, test } from "bun:test";
import packageJson from "../../package.json";
import { join, mkdtemp, readFile, rm, stat, symlink, writeFile } from "../platform.ts";
import { run } from "./process.ts";

const task = {
  task: {
    id: "cli-fixture-task",
    kind: "implementation",
    goal: "Validate the CLI fixture",
    acceptance: ["The fixture passes"],
    allowedPaths: ["src/fixture.ts"],
    requiredTools: ["edit", "test"],
    unresolved: false,
    delegationRequested: true,
    allowedProviders: ["fixture-provider"],
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

const outcome = {
  taskId: task.task.id,
  attemptId: "fixture-attempt",
  workerId: "fixture-worker",
  status: "verified",
  elapsedMs: 1,
  checks: ["The fixture passes"],
  correctionCount: 0,
};

const directory = await mkdtemp("stooart-cli-test-");

afterAll(() => rm(directory));

test("reports the package manifest version", async () => {
  const result = await run(["--version"]);
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe(packageJson.version);
});

test("routes stdin without credentials, including a single-candidate --jev request", async () => {
  for (const flags of [[], ["--jev"]]) {
    const result = await run(["route", "-", ...flags], JSON.stringify(task));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      executor: "agent-runner",
      workerId: "fixture-worker",
    });
  }
});

test("saves a key for a later process and routes with it using private file permissions", async () => {
  const config = join(directory, "user-config");
  const key = "fixture-persisted-key-never-print";
  const setup = await run(["jev", "setup"], key, { XDG_CONFIG_HOME: config });
  expect(setup.code).toBe(0);
  expect(setup.stdout).toContain("saved");
  expect(setup.stdout + setup.stderr).not.toContain(key);

  const credentialDirectory = join(config, "stooart");
  const credentialFile = join(credentialDirectory, "credentials");
  expect((await stat(credentialDirectory)).mode & 0o777).toBe(0o700);
  expect((await stat(credentialFile)).mode & 0o777).toBe(0o600);

  let authorization = "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      authorization = request.headers.get("authorization") ?? "";
      await request.text();

      return Response.json({
        model: "jev-test",
        answers: {
          worker: {
            type: "choice",
            choice: "second",
            confidence: 0.95,
            probabilities: { "fixture-worker": 0.05, second: 0.95 },
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });

  try {
    const input = {
      ...task,
      workers: [...task.workers, { ...task.workers[0], id: "second", priority: 20 }],
    };

    const routed = await run(
      ["route", "-", "--jev"],
      JSON.stringify(input),
      {
        XDG_CONFIG_HOME: config,
        TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      },
      ["TYPESAFE_API_KEY"],
    );

    expect(routed.code).toBe(0);
    expect(JSON.parse(routed.stdout)).toMatchObject({
      executor: "agent-runner",
      workerId: "second",
    });
    expect(authorization).toContain(key);
    expect(routed.stdout + routed.stderr).not.toContain(key);

    const override = "environment-key-takes-precedence";

    const envRouted = await run(["route", "-", "--jev"], JSON.stringify(input), {
      XDG_CONFIG_HOME: config,
      TYPESAFE_API_KEY: override,
      TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    });

    expect(envRouted.code).toBe(0);
    expect(authorization).toContain(override);

    const removed = await run(["jev", "remove"], "", { XDG_CONFIG_HOME: config });
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("removed");

    const afterRemoval = await run(
      ["route", "-", "--jev"],
      JSON.stringify(input),
      {
        XDG_CONFIG_HOME: config,
        TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      },
      ["TYPESAFE_API_KEY"],
    );

    expect(afterRemoval.code).toBe(0);
    expect(JSON.parse(afterRemoval.stdout)).toMatchObject({
      executor: "local",
      failureKind: "authentication",
    });
  } finally {
    await server.stop(true);
  }
}, 15_000);

test("rejects malformed JSON with nonzero exit and no recommendation", async () => {
  const result = await run(["route", "-"], "{bad-input");
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("{bad-input");
});

test("records and reads an outcome without modifying the input", async () => {
  const log = join(directory, "outcomes.jsonl");
  const result = await run(["record", "-", "--log", log], JSON.stringify(outcome));
  expect(result.code).toBe(0);
  const history = await run(["history", "--log", log]);
  expect(history.code).toBe(0);
  expect(JSON.parse(history.stdout)).toMatchObject(outcome);
  expect((await stat(log)).mode & 0o777).toBe(0o600);
});

test("uses effective-jev against a local HTTP fixture and transmits no task goal or paths", async () => {
  let sent = "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      sent = await request.text();

      return Response.json({
        model: "jev-test",
        answers: {
          worker: {
            type: "choice",
            choice: "second",
            confidence: 0.95,
            probabilities: { "fixture-worker": 0.05, second: 0.95 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    },
  });

  try {
    const input = {
      ...task,
      workers: [...task.workers, { ...task.workers[0], id: "second", priority: 20 }],
    };

    const result = await run(["route", "-", "--jev"], JSON.stringify(input), {
      TYPESAFE_API_KEY: "fixture-only-not-a-real-key",
      TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      executor: "agent-runner",
      workerId: "second",
    });
    expect(sent).not.toContain(task.task.goal);
    expect(sent).not.toContain(task.task.allowedPaths[0]!);
    expect(sent).toContain("second");
  } finally {
    await server.stop(true);
  }
}, 15_000);

test("returns local on a provider failure without exposing its response body", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("private provider diagnostic", { status: 429 }),
  });

  try {
    const input = { ...task, workers: [...task.workers, { ...task.workers[0], id: "second" }] };

    const result = await run(["route", "-", "--jev"], JSON.stringify(input), {
      TYPESAFE_API_KEY: "fixture-only-not-a-real-key",
      TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).executor).toBe("local");
    expect(JSON.parse(result.stdout).failureKind).toBe("rate_limit");
    expect(result.stdout + result.stderr).not.toContain("private provider diagnostic");
  } finally {
    await server.stop(true);
  }
}, 15_000);

test("returns typed local results for malformed or low-confidence Jev responses", async () => {
  for (const response of [
    {
      confidence: 0.95,
      probabilities: { "fixture-worker": 0.9, second: 0.9 },
      expected: "malformed_response",
    },
    {
      confidence: 0.2,
      probabilities: { "fixture-worker": 0.5, second: 0.5 },
      expected: "low_confidence",
    },
  ]) {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          model: "jev-test",
          answers: {
            worker: {
              type: "choice",
              choice: "fixture-worker",
              confidence: response.confidence,
              probabilities: response.probabilities,
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });

    try {
      const result = await run(
        ["route", "-", "--jev"],
        JSON.stringify({
          ...task,
          workers: [...task.workers, { ...task.workers[0], id: "second", priority: 20 }],
        }),
        {
          TYPESAFE_API_KEY: "fixture-only-not-a-real-key",
          TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        },
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        executor: "local",
        failureKind: response.expected,
      });
    } finally {
      await server.stop(true);
    }
  }
});

test("honors an explicit worker preference without contacting Jev", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("unexpected Jev request", { status: 500 }),
  });

  try {
    const result = await run(
      ["route", "-", "--jev"],
      JSON.stringify({
        ...task,
        task: { ...task.task, preferredWorkerId: "fixture-worker" },
        workers: [...task.workers, { ...task.workers[0], id: "second", priority: 20 }],
      }),
      {
        TYPESAFE_API_KEY: "fixture-only-not-a-real-key",
        TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      executor: "agent-runner",
      workerId: "fixture-worker",
    });
  } finally {
    await server.stop(true);
  }
});

test("applies routing policy gates at the CLI boundary", async () => {
  const base = task.task;
  const worker = task.workers[0];

  const cases = [
    [{ ...base, unresolved: true }, [worker], "local"],
    [{ ...base, acceptance: [" "] }, [worker], "local"],
    [{ ...base, kind: "research", delegationRequested: false }, [worker], "local"],
    [null, [worker], "local"],
    [{ ...base, kind: "deterministic" }, [], "script"],
    [{ ...base, allowedProviders: ["other-provider"] }, [worker], "local"],
    [base, [{ ...worker, available: false }], "local"],
    [base, [{ ...worker, explicitOnly: true }], "local"],
    [base, [{ ...worker, tools: [] }], "local"],
    [base, [worker, worker], "local"],
    [base, [{ ...worker, executor: "local" }], "local"],
    [{ ...base, preferredWorkerId: "missing" }, [worker], "local"],
    [
      { ...base, preferredWorkerId: worker.id },
      [{ ...worker, explicitOnly: true }],
      "agent-runner",
    ],
  ] as const;

  for (const [taskInput, workers, executor] of cases) {
    const result = await run(["route", "-"], JSON.stringify({ task: taskInput, workers }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).executor).toBe(executor);
  }
});

test("worker cooldown expires without overriding explicit preferences", async () => {
  const now = Date.now();
  const worker = task.workers[0];
  const backup = { ...worker, id: "backup", priority: 20 };
  const observedAt = new Date(now - 60_000).toISOString();

  const cooling = {
    ...worker,
    health: { failure: "quota", observedAt, retryAfter: new Date(now + 60_000).toISOString() },
  };

  const request = { ...task, workers: [cooling, backup] };
  const automatic = await run(["route", "-"], request);
  expect(automatic.code).toBe(0);
  expect(JSON.parse(automatic.stdout)).toMatchObject({ workerId: "backup" });

  const explicit = await run(["route", "-"], {
    ...request,
    task: { ...task.task, preferredWorkerId: worker.id },
  });

  expect(explicit.code).toBe(0);
  expect(JSON.parse(explicit.stdout)).toMatchObject({ executor: "local", workerId: null });

  const expired = {
    ...cooling,
    health: { ...cooling.health, retryAfter: new Date(now - 1_000).toISOString() },
  };

  const recovered = await run(["route", "-"], { ...request, workers: [expired, backup] });
  expect(recovered.code).toBe(0);
  expect(JSON.parse(recovered.stdout)).toMatchObject({ workerId: worker.id });
});

test("rejects truncated and symlink journals through history", async () => {
  const truncated = join(directory, "truncated-history.jsonl");
  const recorded = await run(["route", "-", "--journal", truncated], task);
  expect(recorded.code).toBe(0);
  const journalText = await readFile(truncated);
  await writeFile(truncated, journalText.trimEnd());
  const truncatedResult = await run(["history", "--journal", truncated]);
  expect(truncatedResult.code).toBe(1);
  const linked = join(directory, "linked-history.jsonl");
  await Bun.write(linked, "");
  const symlinkPath = join(directory, "symlink-history.jsonl");
  await symlink(linked, symlinkPath);
  const linkedResult = await run(["history", "--journal", symlinkPath]);
  expect(linkedResult.code).toBe(1);
});
