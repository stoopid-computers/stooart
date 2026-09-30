---
name: delegate
description: Use stooart to recommend a worker when the user or host asks for worker selection or delegation.
---

# Route work with stooart

stooart recommends an executor from the task and worker profiles you provide. It does not discover workers, launch them, or grant access. You decide whether and how to act on its recommendation.

## Prepare the request

Describe the goal, acceptance checks, allowed paths, required tools, and any unresolved decisions. Choose a task kind that matches the work. By default, research, review, and diagnosis stay local. Set `delegationRequested: true` when the user has asked to delegate one of those tasks. Set `preferredWorkerId` for an exact worker choice. Use `allowedProviders` to limit providers.

Start with [the example request](references/request.json). Replace its task and worker profiles with current information. List only workers the caller can use, including their availability, tools, executor, provider, model, effort, and priority. An installed CLI or model name does not prove account access.

## Get a recommendation

Run `stooart route <request.json|->`, or from this repository run `bun run dev -- route <request.json|->`. By default, stooart selects the eligible worker with the lowest priority number, then worker ID. If Jev is configured and applies, `--jev` asks it to choose among eligible workers. Keep credentials out of the request.

Read the top-level `executor`, `model`, `effort`, `workerId`, `reason`, `eligibleWorkerIds`, `rejected`, and `policyVersion` fields. Check `failureKind` when present. `local` keeps the task with the caller. `script` recommends a scoped deterministic operation. A worker result is only a recommendation. Before using it, match its ID and configuration to the profile you supplied.

## If the user chooses to delegate

Send the worker the task scope and acceptance checks through a supported host mechanism within existing permissions. Verify the result to the degree the task requires. Report the recommendation, the work performed, and the checks that support the result. Follow the user's instructions and the host's rules for handoff, retries, and final acceptance.
