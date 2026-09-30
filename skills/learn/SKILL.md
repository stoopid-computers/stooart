---
name: learn
description: Record and reuse stooart task evidence. Use when asked to journal a routed decision, verify and record an outcome, recall a procedure, or evaluate prior routes.
---

# Learn from stooart outcomes

Use a JSONL journal chosen for this task. The loop is route, do the work, verify it, record the outcome, then recall or evaluate. `route`, `recall`, `recipes`, and `eval` do not execute workers or procedures. Only `verify` runs a command, and it runs the command in its request.

## 1. Route and do the work

Run `stooart route request.json --journal journal.jsonl` and save its `decisionId`. Follow the `delegate` skill to describe the task and confirm worker availability. For retrieval, include a stable `projectId`, a `groupId` shared by related attempts, and all four `features`: `family`, `scope`, `context`, and `proof`. The caller does the work or delegates it, then records the actual worker and attempt ID. A route is not proof that work was done.

## 2. Verify the artifact

Choose a trusted, bounded command and an artifact that covers the work. Respect the user's task and host permissions. A saved route does not expand them. Create a verification request with `decisionId`, `attemptId`, `artifactPath`, and a `verifier` containing `id`, `version`, `command`, `args`, absolute `cwd`, and `timeoutMs` from 1 to 120000. Run `stooart verify verification.json --journal journal.jsonl`.

The artifact can be a file or directory relative to `cwd`. Keep the journal outside a directory being hashed. Directory hashes include every descendant and file permission. Symlinks and special files fail. stooart hashes the artifact before and after the check. A nonzero exit, timeout, execution error, or artifact change produces a failed receipt. The command inherits the current environment and is not sandboxed. A passing receipt shows only that this command passed against this artifact.

## 3. Record the outcome

Write an outcome with `decisionId`, `taskId`, `attemptId`, selected `workerId` when applicable, `status`, `elapsedMs`, `checks`, and `correctionCount`. Choose the status that matches the result: `verified`, `accepted`, `failed`, `environment_error`, `cancelled`, or `unknown`. For `verified`, include the passing receipt's `verificationId` and `artifactSha256`. stooart checks the artifact again before accepting the outcome. Never label an unchecked report `verified`. Include `failureKind`, token counts, and `costUsd` only when they reflect measured facts. Run `stooart record outcome.json --journal journal.jsonl`. Each attempt has one final outcome.

Add a `procedure` when its `id`, `version`, `steps`, and `preconditions` describe a reusable method. Change the version when the steps or preconditions change. `record --log` creates a separate report log. It does not provide recipe evidence.

## 4. Recall procedures or evaluate routes

Run `stooart recall request.json --journal journal.jsonl` to inspect matches. Use `stooart route request.json --recipes --journal journal.jsonl` to opt into recipe routing. `stooart recipes --journal journal.jsonl` lists candidates. A recipe needs a matching project, task features, worker configuration, current policy version, and a passing receipt less than 90 days old. Provider, preference, availability, cooldown, and scope rules still apply. Retrieval never runs stored steps.

Run `stooart eval --journal journal.jsonl --after ISO_TIMESTAMP` with a cutoff between earlier evidence and later decisions. Evaluation is offline. It excludes related groups from the held-out set and scores a choice only when the selected worker has an observed outcome. The report replays recorded decisions. It does not establish that one worker caused a better result.

## Journal privacy

The journal stores worker profiles, task metadata, checks, outcome labels, and optional procedure text. Decision snapshots omit raw goals, acceptance prose, and allowed paths. Keep credentials, private source, and sensitive identifiers out of labels, IDs, procedures, and legacy logs. New journals use private file permissions, but they remain local, user-editable records rather than signed attestations. Preserve a damaged journal before repair; the CLI fails closed on corrupt or conflicting events.
