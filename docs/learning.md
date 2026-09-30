# Evidence and procedure reuse

Use an explicitly chosen JSONL journal to record routing decisions and checked outcomes. Routing, retrieval, and evaluation read journal entries. Only `verify` runs a command, and it runs the command named in your request.

## 1. Save a routing decision

```sh
bun run src/cli.ts route examples/learning-task.json --journal ./journal.jsonl
```

The output adds `decisionId` and `recordedAt` to the recommendation. The journal stores candidate profiles, policy version, selected worker configuration, strategy, and a task snapshot. It omits the raw goal, acceptance prose, and allowed paths.

Task `features` must provide all four categories when present:

| Field     | Values                                                             |
| --------- | ------------------------------------------------------------------ |
| `family`  | `ci`, `bugfix`, `migration`, `ui`, `integration`, `tests`, `other` |
| `scope`   | `small`, `medium`, `large`                                         |
| `context` | `fresh`, `existing`                                                |
| `proof`   | `tests`, `visual`, `review`, `mixed`                               |

For later retrieval, supply a stable `projectId`. Give related attempts from the same change one `groupId`, even when their task IDs differ. Evaluation uses `groupId`, or the task ID when no group is supplied, to keep related attempts out of the held-out set. stooart cannot infer missing relationships.

## 2. Verify the artifact

`verify` requires a request and `--journal`. This example checks the `src` directory with the project's `check` command:

```json
{
  "decisionId": "decision-from-route",
  "attemptId": "attempt-1",
  "artifactPath": "src",
  "verifier": {
    "id": "project-check",
    "version": "1",
    "command": "bun",
    "args": ["run", "check"],
    "cwd": "/absolute/path/to/stooart",
    "timeoutMs": 120000
  }
}
```

`artifactPath` can name a file or directory relative to `cwd`. For a directory, stooart hashes every descendant's name, contents, and permission bits. It does not exclude files. Symlinks and special files are rejected. Choose the artifact that the check is meant to validate. Keep the journal outside that artifact because `verify` appends a receipt. For example, hashing `src` does not cover changes elsewhere in the project.

stooart hashes the artifact before and after the check. Its receipt records the verifier ID and version, command-configuration hash, exit status, duration, and stdout/stderr hashes. It does not save command arguments or raw output. A failed command, timeout, execution error, or artifact change creates a failed receipt and returns exit code 1. Invalid requests fail before the command runs.

Set `timeoutMs` from 1 to 120,000. On timeout, stooart sends SIGKILL to the direct child. It does not isolate the process tree or sandbox the command. Run trusted checks that clean up their own child processes. stooart captures output in memory to hash it, and passes the current environment to the check. Choose the command and permissions accordingly.

A passing receipt shows that this command passed against the selected artifact. It does not show that the check was adequate or establish that the work is correct. Receipts live in a local, user-editable journal. They are not signed attestations. Keep any separate acceptance checks or review your task requires.

## 3. Record the outcome

Run `record --journal` with the outcome fields and `decisionId`. For `status: "verified"`, include the receipt's `verificationId` and `artifactSha256`. The decision, task, attempt, and selected worker must match. Before accepting the outcome, stooart checks the artifact hash again. Each attempt can have one final outcome.

An optional procedure supplies reusable instructions:

```json
{
  "id": "scoped-ci-fix",
  "version": "1",
  "steps": [
    "Reproduce the existing failure",
    "Change the permitted files",
    "Run the original check"
  ],
  "preconditions": ["An existing check reproduces the failure"]
}
```

Add the object as `procedure` on the linked outcome when it describes a repeatable method. Change its version if you edit its steps or preconditions. The journal stores procedure text and check labels, so keep private source and credentials out of them.

Use the status that matches what happened: `verified`, `accepted`, `failed`, `environment_error`, `cancelled`, or `unknown`. Only a matching passing receipt supports `verified`. `failureKind` can describe implementation, verification, or provider trouble. Token counts can separate input, output, cache reads, and cache writes. Include `costUsd` only when measured. `elapsedMs` covers the whole attempt, including handoff, retries, checks, and repairs, when those durations are known.

## 4. Retrieve procedures or evaluate routes

```sh
bun run src/cli.ts recipes --journal ./journal.jsonl
bun run src/cli.ts recall examples/learning-task.json --journal ./journal.jsonl
bun run src/cli.ts route examples/learning-task.json --recipes --journal ./journal.jsonl
bun run src/cli.ts eval --journal ./journal.jsonl --after 2000-01-01T00:00:00.000Z
```

`recipes` lists versioned candidates from recorded procedures and outcomes. `recall` shows matches and a recommendation. A match must share the project, task kind, features, required tools, and worker configuration: ID, executor, model, provider, effort, and tools. It also needs a verified outcome, the current policy version, and a verification receipt less than 90 days old. Worker and provider restrictions, availability, cooldowns, scope, and research-delegation policy still apply.

Matches sort by the observed verified fraction among verified and failed attempts, reported corrections per attempt, verified count, then recipe ID. Counts for accepted, unknown, cancelled, and environment failures remain visible. This opt-in heuristic may have little evidence. It is not a calibrated probability or proof that one worker is better. stooart links a failed reuse to the selected recipe even when the later outcome omits the procedure. `recall` and `route` never run procedure text.

`eval` uses events before the cutoff as training data and replays decisions at or after it. It excludes related groups from the held-out set, reports samples by task family, and keeps held-out outcomes out of the recipe shortlist. Priority and recipe replays receive an observed outcome only when they match the worker selected at the time. Recorded Jev results use their own task mix, and evaluation makes no API calls. Unknown costs stay unknown. Repeated controlled runs are needed to compare worker performance.

## Runnable local example

Try the full evidence loop from the stooart checkout. It uses a fictional worker and checks the `src` directory. You need Bun and jq:

```sh
demo_dir=$(mktemp -d)
journal="$demo_dir/journal.jsonl"
bun run src/cli.ts route examples/learning-task.json --journal "$journal" > "$demo_dir/decision.json"
jq -n --slurpfile decision "$demo_dir/decision.json" --arg cwd "$PWD" '{
  decisionId: $decision[0].decisionId, attemptId: "demo-attempt", artifactPath: "src",
  verifier: {id: "stooart-check", version: "1", command: "bun", args: ["run", "check"], cwd: $cwd, timeoutMs: 120000}
}' > "$demo_dir/verification.json"
bun run src/cli.ts verify "$demo_dir/verification.json" --journal "$journal" > "$demo_dir/receipt.json"
jq -n --slurpfile decision "$demo_dir/decision.json" --slurpfile receipt "$demo_dir/receipt.json" '{
  decisionId: $decision[0].decisionId, taskId: "check-project", attemptId: "demo-attempt",
  workerId: $decision[0].workerId, status: "verified", verificationId: $receipt[0].id,
  artifactSha256: $receipt[0].artifact.sha256, elapsedMs: $receipt[0].elapsedMs,
  correctionCount: 0, checks: ["stooart-check"],
  procedure: {id: "check-project", version: "1", steps: ["Run the existing project check"], preconditions: ["Dependencies installed"]}
}' > "$demo_dir/outcome.json"
bun run src/cli.ts record "$demo_dir/outcome.json" --journal "$journal"
bun run src/cli.ts recall examples/learning-task.json --journal "$journal"
```

## Journal files and recovery

New journals use mode 0600 and new parent directories use 0700. A directory lock serializes writers; competing writers fail without acknowledging a lost record. Truncated lines, duplicate IDs/attempts, mismatched references, changed procedure versions, and invalid chronology fail closed. A crash can leave a lock or partial final line. Inspect it and preserve the original journal before repairing it; stooart never steals a lock or silently skips damaged records.

The legacy `record --log` format remains separate and supplies no recipe evidence.
