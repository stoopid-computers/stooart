import { afterAll, expect, test } from "vite-plus/test";
import { createServer as createHttpServer } from "node:http";
import { Schema } from "effect";
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

async function createServer(options: {
  hostname: string;
  port: number;
  fetch: (request: Request) => Promise<Response> | Response;
}) {
  const server = createHttpServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];

    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));

    // SAFETY: the server is listening on an ephemeral TCP port before requests are handled.
    const request = new Request(
      `http://${options.hostname}:${(server.address() as { port: number }).port}${incoming.url}`,
      {
        method: incoming.method,
        headers: Object.entries(incoming.headers).flatMap(([key, value]) =>
          value === undefined
            ? []
            : Array.isArray(value)
              ? value.map((item) => [key, item])
              : [[key, value]],
        ),
        body: ["GET", "HEAD"].includes(incoming.method ?? "") ? undefined : Buffer.concat(chunks),
      },
    );

    const response = await options.fetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.hostname, resolve));

  const address = server.address();

  if (!address || Schema.is(Schema.String)(address))
    throw new Error("HTTP fixture did not bind a TCP port");

  return {
    port: address.port,
    stop: (_closeActiveConnections?: boolean) =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

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

  const server = await createServer({
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

  const server = await createServer({
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
  const server = await createServer({
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
    const server = await createServer({
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
  const server = await createServer({
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

const policyCases = [
  {
    name: "keeps unresolved tasks local",
    task: { ...task.task, unresolved: true },
    workers: [task.workers[0]],
    executor: "local",
  },
  {
    name: "keeps tasks without acceptance criteria local",
    task: { ...task.task, acceptance: [" "] },
    workers: [task.workers[0]],
    executor: "local",
  },
  {
    name: "keeps undelegated research local",
    task: { ...task.task, kind: "research", delegationRequested: false },
    workers: [task.workers[0]],
    executor: "local",
  },
  { name: "keeps missing tasks local", task: null, workers: [task.workers[0]], executor: "local" },
  {
    name: "routes deterministic tasks to the script executor",
    task: { ...task.task, kind: "deterministic" },
    workers: [],
    executor: "script",
  },
  {
    name: "keeps tasks local when no provider matches",
    task: { ...task.task, allowedProviders: ["other-provider"] },
    workers: [task.workers[0]],
    executor: "local",
  },
  {
    name: "keeps unavailable workers out of routing",
    task: task.task,
    workers: [{ ...task.workers[0], available: false }],
    executor: "local",
  },
  {
    name: "keeps explicit-only workers out of automatic routing",
    task: task.task,
    workers: [{ ...task.workers[0], explicitOnly: true }],
    executor: "local",
  },
  {
    name: "keeps workers without required tools out of routing",
    task: task.task,
    workers: [{ ...task.workers[0], tools: [] }],
    executor: "local",
  },
  {
    name: "keeps duplicate worker profiles local",
    task: task.task,
    workers: [task.workers[0], task.workers[0]],
    executor: "local",
  },
  {
    name: "keeps the local executor out of worker routing",
    task: task.task,
    workers: [{ ...task.workers[0], executor: "local" }],
    executor: "local",
  },
  {
    name: "keeps missing explicit preferences local",
    task: { ...task.task, preferredWorkerId: "missing" },
    workers: [task.workers[0]],
    executor: "local",
  },
  {
    name: "allows an explicit preference for an explicit-only worker",
    task: { ...task.task, preferredWorkerId: task.workers[0].id },
    workers: [{ ...task.workers[0], explicitOnly: true }],
    executor: "agent-runner",
  },
] as const;

test.each(policyCases)("$name", async ({ task: taskInput, workers, executor }) => {
  const result = await run(["route", "-"], JSON.stringify({ task: taskInput, workers }));
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).executor).toBe(executor);
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
  await writeFile(linked, "");
  const symlinkPath = join(directory, "symlink-history.jsonl");
  await symlink(linked, symlinkPath);
  const linkedResult = await run(["history", "--journal", symlinkPath]);
  expect(linkedResult.code).toBe(1);
});
