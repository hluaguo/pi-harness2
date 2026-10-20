# AGENTS.md

Rules for changing this repository. They apply to humans and to coding agents.
The short version: explain the reason, avoid ceremony, and write down decisions
that a future change could otherwise undo.

## Comments and docstrings

Do not write a docstring that repeats the function name or signature. `/** Reads
a file. */` above `readText` tells the reader nothing they did not already know.
The same goes for comments that narrate the next line.

Write a comment when the code hides a reason: an unusual constraint, a failed
alternative, a boundary that must not move, or a behavior that looks wrong until
you know why it is there. Put the comment next to the decision, not at the top of
the file.

A file header is fine when it explains the module's role or where a port came
from. `src/types.ts` says the names mirror upstream `core/spec.py`; that is useful
when editing it. `src/util.ts` says it holds filesystem, process, hash, and
concurrency helpers; that is enough.

Do not leave comments about the editing process, the agent's plan, or what was
changed in a previous revision. Git has that history.

## Tests

Do not add a test that restates the implementation. A test for a getter, a
constant, or an obvious branch costs maintenance and catches nothing.

A test earns its place when it encodes a failure we have seen or a boundary that
is expensive to check by hand:

- a path escaping the harness tree;
- a probe seeing the wrong workspace or leaking the user's working tree;
- an uncommitted change missing from a probe;
- a candidate tree with the same hash probed twice;
- evidence containing a file matched by `leakGlobs`;
- child Pi processes surviving session shutdown.

Prefer one small end-to-end check over a large mocked suite for orchestration.
Most of the risk here is subprocess and filesystem behavior, and mocks would skip
exactly the part that breaks.

There is no test runner in the repository right now. `npm run check` is the
current gate. If you add a runner, record that decision below and keep the first
suite small. Do not add a coverage target.

When you fix a bug, add the smallest reproduction that would have caught it. If
that is impractical, write the manual reproduction in the commit message or pull
request. A bug fix without either is incomplete.

## Why, and when

Code should say what it does. Comments, commit messages, and this file should say
why. A future reader will not know which parts are safe to change from the code
alone.

Record a decision here when it constrains future work: the execution substrate, a
storage layout, a security boundary, a default that costs money, or a rule that
exists because something failed before. Do not log routine refactors, renames, or
dependency bumps.

Use this format:

```text
YYYY-MM-DD, who: the decision.
Why: the reason, including the failure or constraint that forced it.
Evidence: file, run, commit, or upstream reference.
```

Only a human maintainer can accept a decision. If you are an agent, put a proposal
under "Proposed" and leave the attribution and date to the maintainer. Do not
invent a human decision, a date, or a reason.

## Repo-specific rules

Keep orchestration in the parent process and evidence on disk. The parent writes
the tree, starts a child, and reads the result. A run should still make sense after
the process exits.

Treat model output as data. A proposal tree is repaired and validated before any
child runs it. Paths are allowlisted, referenced scripts must exist, Python must
parse, and candidate plugins are never executed during validation.

Fail at the stage, not the run. A malformed proposal retries once, then inherits
the current harness. Base probes and other candidates keep their evidence.

Do not hide state in memory when a file will do. Run directories, `result.json`,
and `report.md` are the debugging surface. A cache is allowed when the report
shows it was used (`artifactKey`, `reusedFrom`).

A change to the editable surface touches more than one place. Check `src/tree.ts`
for the allowlist and validator, `src/materialize.ts` and `src/templates/` for the
exported package, `README.md` for the public description, and `HARNESS2.md` for
the component mapping.

Prompt text in `src/prompts.ts` is product behavior. A wording change can change
what editors propose. Treat it like code and explain the reason in the commit.

Child Pi flags are a contract. Probe, editor, selector, subagent, and exported
context extension should agree on disabled resources and explicit loads. If you
change one, search for the others.

Use the Node standard library and the Pi packages already present. Add a
dependency only when it removes more code than it brings.

Follow the local style: TypeScript ESM, tabs, `.ts` import extensions, small
modules, and names that match the upstream Python method where the concepts match.

## Decision log

```text
2026-10-13, upstream Harness² (1cfe254e): keep model weights fixed and adapt the
harness instead.
Why: the method has to work on ordinary tasks without a training run, a rubric, or
a held-out score.
Evidence: google-research/harness2, HARNESS2.md section 1.

2026-10-20, maintainer: reimplement the method as a Pi extension instead of
wrapping the upstream Python CLI.
Why: upstream is built around OpenCode and Codex. Pi sessions can serve as both
solver and harness editor, and Pi already has an editable surface for prompts,
skills, subagents, scripts, and plugins.
Evidence: HARNESS2.md section 2.

2026-10-20, maintainer: probe in a detached Git worktree with the uncommitted
working-tree diff applied and committed as a local baseline.
Why: a probe must start from the state the user is actually in, must not touch
their files, and `git diff HEAD` must show only the probe's changes. Repositories
without Git fall back to a filtered copy plus a file-stat snapshot.
Evidence: src/workspace.ts.

2026-10-20, maintainer: child Pi sessions run with `--no-session` and with
discovered extensions, skills, context files, prompt templates, and MCP servers
disabled.
Why: a probe should see the candidate harness and nothing else, and probe history
should not pollute the user's session. Explicit `-e`, `--skill`, and
`--append-system-prompt` still load.
Evidence: HARNESS2.md section 5, src/runner.ts.

2026-10-20, maintainer: keep the harness surface allowlisted and validate a
proposal before probing it.
Why: a proposal can write arbitrary files and run code. Only known paths may
execute, referenced scripts must exist, Python must parse, and answer-key globs
must stay out of evidence.
Evidence: src/tree.ts, HARNESS2.md section 3.

2026-10-20, maintainer: cap always-on text at 16,000 characters.
Why: always-on text is paid on every model call and competes with the output
budget. A skill costs nothing until it is named.
Evidence: HARNESS2_ALWAYS_ON_MAX, upstream validation rule.

2026-10-20, maintainer: retry an invalid proposal once, then inherit the current
harness and mark the stage `fellBack`.
Why: an editor can return a malformed tree after base probes have already been
paid for. One bad stage should not abort the run.
Evidence: src/recursion.ts, src/tree.ts.

2026-10-20, maintainer: select a final blind, and let verification gate the pool
without driving adaptation.
Why: the choice should follow the artifact, not knowledge of which candidate came
from the base. A score must not become something the editors optimize.
Evidence: src/selection.ts, HARNESS2.md section 11.

2026-10-20, maintainer: suppress discovered `AGENTS.md` context files while a
Harness² harness is active.
Why: the active harness is the always-on layer. Showing both duplicates
instructions when the harness was seeded from `AGENTS.md`.
Evidence: src/index.ts, before_agent_start.

2026-10-20, maintainer: do not load plugins implicitly from `/harness2 use` or
`/harness2 export`.
Why: Pi has no safe mid-session plugin loading, and plugins are executable code.
Loading one requires an explicit `pi -e`.
Evidence: src/index.ts, src/materialize.ts.

2026-10-20, maintainer: reuse a rollout when a candidate tree hashes to one
already probed.
Why: composition can return an identical tree, and a full probe is expensive.
`artifactKey` and `reusedFrom` keep the reuse visible in the report.
Evidence: src/recursion.ts, src/report.ts.

2026-10-20, maintainer: allow an early stop when base probes deliver identical
artifacts, but keep it off by default.
Why: with no behavioral contrast there is nothing for an editor to act on, and
the run would spend editor sessions for no result. The default stays off until
enough runs show the signal is reliable.
Evidence: baseNoSignal in src/recursion.ts.

2026-10-20, maintainer: ship without a unit test runner in the first version.
Why: the risky behavior is subprocess and filesystem work that mocks would not
exercise, and manual end-to-end runs gave more signal. Add a runner when a
concrete failure needs one.
Evidence: package.json, scripts/check.
```

## Proposed

Add entries here as `YYYY-MM-DD, agent: proposal. Why: ...`. A maintainer moves
accepted proposals into the decision log with their own attribution.
