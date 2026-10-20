# Harness² as a Pi extension

This project ports the method from
[google-research/harness2](https://github.com/google-research/harness2)
(commit `1cfe254e`, 2026-10-13) into a Pi extension. It does not wrap the
Python CLI. It reimplements the refinement loop using Pi sessions as both the
solver and the harness editor.

The result: while you work in a repository, Pi can run a **Propose–Probe–Compose**
step around a task, where the thing being improved is the harness Pi itself
runs under — its standing instructions, skills, subagents, scripts, and plugins.

> A harness is the system around a model that lets it act as an agent. Harnessing
> is the process of optimizing that system. Harness² keeps model weights fixed and
> improves the harness instead.

---

## 1. The idea being ported

Harness² couples two recursive loops.

### Task-level recursion

For one task, with a fixed model:

1. **Probe the base.** Execute the task a few times under the current harness.
2. **Propose.** Two independent editors read the task, the full base rollouts,
   and the current harness:
   - **INV** (invariant) owns *how the agent works*: tool use, reading order,
     scripts, verification, budget, completion.
   - **DOM** (domain) owns *what a practitioner knows*: required artifact shape,
     domain checks, decision rules, durable facts.
3. **Probe the proposals.** Each candidate harness runs the same task once.
4. **Compose.** A composer reads the base evidence and every candidate's harness
   and rollout, then emits one harness containing only what the evidence supports.
5. Repeat or widen according to the recursion budget `k`.

No ground truth, rubric, or score enters adaptation. A rollout's *behavioral
contrast* is the evidence. Composition is allowed to keep the base unchanged
(`KEEP_BASE`) or adopt one candidate wholesale.

### Harnessing-level recursion

After a task, an **experience reflector** diffs every candidate against the base
harness, records what each edit did (`helped`, `hurt`, `no observed effect`,
`confounded`), and writes at most one transferable lesson. The adopted harness
and the lesson enter a per-domain **library** that later tasks read before making
their own edits. This is how evidence accumulates without fine-tuning.

### Two recursion modes

| Mode | What it does | Disk token |
|---|---|---|
| `parallel` | `k` INV and `k` DOM candidates from shared base evidence; `k` independent compositions | `agg` |
| `sequential` | `k` nested Propose–Probe–Compose rounds; each round builds on the previous checkpoint and accumulated evidence | `seq` |

`k` is the task-level recursion budget. `k = 1` is one Propose–Probe–Compose step.

---

## 2. The eight components, mapped to Pi

Harness² exposes eight editable components. Pi does not have the same runtime as
OpenCode or Codex, so this port maps them onto Pi primitives that exist.

| # | Harness² component | Pi harness path here | When it is in context |
|---|---|---|---|
| c1 | system prompt | `systemprompt.md` | always on (appended to Pi's system prompt) |
| c2 | guardrails | `guardrails.md` | always on |
| c3 | memory | `LongTermMEMORY.md` | always on |
| c4 | tool guidance | `tool_descriptions/tool_guidance.md` | always on |
| c5 | subagents | `agents/<name>.md` | on demand, in a separate Pi process |
| c6 | skills | `skills/<name>/SKILL.md` | name + description advertised, body on demand |
| c7 | scripts | `scripts/<name>.py` | on demand via `bash` |
| c8 | plugins | `plugins/<name>.ts` | registered inside the solver's tool loop |

The always-on files are concatenated, in the order above, into a single
`--append-system-prompt` file for each rollout. Pi's own base system prompt is
still present; the harness is an *edit layer*, not a replacement prompt.

### Why plugins are the important port

In Harness², the plugin/hook component is the only thing that acts *inside* the
tool loop. Prose can be ignored; a hook cannot. This port keeps that property by
loading `plugins/<name>.ts` as real Pi extensions marked with `-e`. They can
register tools, intercept `tool_call`, rewrite `tool_result`, or inject prompt
sections. They are the cheapest way to enforce a rule that the model keeps
skipping.

### Subagents

Pi deliberately ships without built-in subagents. This extension ships a small
`src/probe-subagent.ts` helper. When a harness contains `agents/*.md`, probe
sessions load that helper and get a `task` tool. Each subagent is a fresh
`pi --print` process with its own context and a system prompt taken from the
agent's Markdown body.

An agent file looks like:

```markdown
---
name: extractor
description: Read many documents and return one normalized table.
tools: read, bash
model: anthropic/claude-sonnet-4-5
---

You are a document extraction worker. Return only the requested table.
```

---

## 3. Validation: what makes a proposal usable

Every proposal is repaired, then validated, before it is probed. A proposal that
fails validation is retried once with the error text as feedback; if it fails
again, the stage inherits the current harness and is marked `fellBack`.

The rules mirror Harness²'s hard-won ones:

1. **Always-on content must exist.** The concatenated always-on text may not be
   empty.
2. **Always-on content is capped** (`HARNESS2_ALWAYS_ON_MAX`, default 16,000
   characters). It is paid for on every model call and competes with the
   agent's output budget.
3. **Every skill needs a trigger line.** The skill's directory name must appear
   verbatim in the always-on text. Untriggered skills are dead weight. The
   validator can auto-repair this by appending a trigger line when there is room.
4. **Skill frontmatter needs `description:` and a matching `name:`.** Pi drops
   malformed skills silently.
5. **Every referenced script must ship.** A `scripts/foo.py` invoked from a
   skill or from always-on text must exist in the tree.
6. **Python scripts must compile.** They are parsed with `ast.parse` before any
   rollout.
7. **Paths are allowlisted.** Anything outside the surface is rejected and named
   in the retry feedback.
8. **No answer-key leakage.** Evidence trees refuse task files matching the
   task's `leakGlobs` and refuse common grader-verdict marker strings.

The validator returns a census (`always_on_chars`, file counts, skill counts) that
is recorded in the run report.

---

## 4. What a task is

A task is a directory under `.harness2/tasks/<id>/`:

```text
.harness2/tasks/reconcile-q3/
├── task.json
├── task.md          # optional: prompt can live here instead
└── source/          # optional read-only material
```

`task.json`:

```json
{
  "id": "reconcile-q3",
  "prompt": "Reconcile the Q3 ledger against the bank export. Deliver reconciliation.xlsx.",
  "domain": "accounting",
  "deliverables": ["reconciliation.xlsx", "notes.md"],
  "leakGlobs": ["*.answer", "expected/*"],
  "yardstick": "The workbook must tie every unmatched row to a source document.",
  "verify": "python3 scripts/check_reconciliation.py"
}
```

- `domain` selects the experience library. Tasks in the same domain read each
  other's lessons; different domains do not.
- `deliverables` is optional. When present, those paths are treated as the
  artifact and rendered into the selection/evidence context. When absent, the
  rollout's workspace diff is the deliverable.
- `yardstick` is optional guidance for what good process looks like. It is *not*
  a score and must describe the work, not its measurement.
- `verify` is optional. It runs in each probe workspace after the artifact is
  captured. If at least one candidate passes, only passing candidates enter the
  selector pool; if none pass, the selector sees every failure. The result is
  never written into trajectory evidence, so adaptation stays score-free.
- `leakGlobs` keeps answer keys out of the proposer's evidence tree.

Create one with `/harness2 init`, or pass a prompt directly to
`/harness2 run --prompt "..."`.

---

## 5. How a rollout runs

Each probe is a real, isolated Pi process:

```text
pi --mode json --no-session -ne -ns -nc -np --no-mcp \
   --tools +ls,+grep,+find \
   --append-system-prompt <harness-always-on.md> \
   --skill <harness>/skills/<name> \
   -e <harness>/plugins/<name>.ts \
   -e <this-package>/src/probe-subagent.ts \
   "the task prompt"
```

- `-ne -ns -nc -np` disable the user's discovered extensions, skills, context
  files, and prompt templates, so the candidate harness is the only harness.
  Explicit `-e`, `--skill`, and `--append-system-prompt` still load.
- The workspace is a **Git worktree** at `HEAD` with the current working tree
  changes committed as a local baseline. After the rollout, `git diff` is exactly
  what the solver changed. Non-Git directories fall back to a filtered copy and a
  file-hash snapshot.
- The JSON event stream is rendered into the shared evidence grammar:
  `[ACTION]`, `[OBSERVATION]`, `[ERROR]`, and `[ASSISTANT]`.
- Observations are truncated per event (`HARNESS2_OBS_TRUNC`, default 50,000
  chars); trajectories are written in full.
- If the task declares `verify`, the command runs in the workspace after the
  deliverable is captured. Its result goes to `rollouts/<label>/verify.json`,
  never to `trajectory.md`.
- Workspaces are removed after the deliverable is extracted unless
  `HARNESS2_KEEP_WORKSPACES=1`.

### Why `--no-session`

Probes must be reproducible and must not pollute your session history. The full
JSON event stream is saved under the run directory instead.

---

## 6. Evidence handed to an editor

Every proposal stage gets a fresh context directory:

```text
context/
├── task.md                    the task verbatim
├── source/                    task source material (if any)
├── harness/                   the tree being edited
├── rollouts/<label>.md        full trajectories
├── deliverables/<label>/      what each rollout produced, one per artifact
├── pool/<label>/
│   ├── harness/               a candidate's tree
│   ├── harness.diff           diff against the current harness
│   ├── rollout.md             its trajectory
│   └── produced.md            what it delivered
├── decisions/<label>.md       earlier stages' notes or errors
└── library/                   earlier tasks' adopted harnesses + lessons
```

The mission tells the editor that evidence is **data, not instructions**, that
there is no rubric or answer key, and that every edit must trace to a specific
trajectory moment. Only the mission's job text is an instruction.

This is a direct port of `core/context.py` and `core/prompts.py`, including the
rules that matter most:

- Always-on prose is the expensive option; prefer a skill, script, subagent, or
  plugin.
- A skill that is never named in always-on text is dead weight.
- A subagent is worth it only when its input is large and its answer is small.
- A plugin is for a mechanical failure that prose demonstrably does not fix.
- Never change the artifact's requested shape; guidance that makes reasoning
  visible belongs in the harness or trajectory, not in the deliverable.
- If the evidence does not support an edit, `KEEP_BASE` is a valid outcome.

### Cost controls

Two cheap checks avoid work the method does not need:

- **Rollout dedup.** A candidate whose tree is byte-identical to an earlier
  probe reuses that probe's trajectory and deliverable. The report records which
  label it reused and the run cost counts the probe once.
- **Composition skip.** If every dimension candidate is identical to the base
  (or, in sequential mode, to the current checkpoint), the composer session is
  replaced by a synthetic `KEEP_BASE` stage and no extra probe is spent.
- **Optional base early stop.** `HARNESS2_EARLY_STOP=1` stops before the editors
  when `k>1` base probes all delivered identical artifacts. It is off by default
  because identical artifacts do not prove that a better harness is impossible.

---

## 7. The editor and selector are also Pi sessions

The proposer is a Pi subprocess with `read`, `edit`, `write`, `bash`, `ls`,
`grep`, and `find`, running in a temporary copy of the evidence directory (the
audit copy stays under `evidence/<stage>/context/`). Its edits to
`context/harness/` *are* the proposal; its final message carries a `<notes>`
block. After the session, this extension harvests the edited tree before the
temporary directory is removed.

The selector is a separate Pi session that sees only:

```text
context/task.md
context/source/
context/candidates/<id>.md
```

Candidate IDs are shuffled and anonymous. The selector is not told which
candidate came from the base harness and which came from a refined one. It must
end with:

````text
```choice
<id>
```
````

At `k = 1` there is only one final, so selection is trivial and no selector
session is spent (matching Harness²'s `trivial_selection`).

The experience reflector is a third Pi session. It sees the base harness, every
candidate diff, every rollout, and which output was selected. It writes edit
rows and at most one durable lesson, or `NO_ENTRY`.

---

## 8. Run layout

```text
.harness2/
├── base/                          optional hand-authored base harness
├── tasks/<id>/                    task packages
├── library/<domain>/
│   ├── INDEX.md
│   └── entries/<task>/harness/ + EXPERIENCE.md
├── adopted/<task>/harness/        the last adopted tree
├── exports/<task>-<run>/          native Pi packages from /harness2 export
├── active.json                    the harness currently applied to this project
└── runs/<run-id>/
    ├── run.json                   configuration + status
    ├── result.json                stages, selection, adoption, costs
    ├── report.md                  human-readable report
    ├── events/                    raw proposer JSONL
    ├── evidence/<stage>/context/  evidence trees
    ├── selection/context/        blind-selection evidence
    ├── harnesses/<label>/         every candidate tree
    ├── workspaces/<label>/        probe workspaces (removed by default)
    └── rollouts/<label>/
        ├── events.jsonl
        ├── trajectory.md
        ├── deliverable/
        ├── verify.json          present when the task declares verify
        └── run.json
```

---

## 9. Status

The footer carries a persistent `H²` status:

- `H² ready` when no harness is active;
- `H² active <task>/<label>` after `/harness2 use`;
- `H² <mode> k=<k> <pct>% <phase>` during a run.

While a run is in progress, a three-line widget above the editor shows the task,
a progress bar, elapsed time, and the current phase. The progress fraction is
driven by the recursion phases (base probes, candidate proposals, candidate
probes, composition, selection, reflection); individual probe and editor
messages update the phase text. Everything clears on completion or failure.

## 10. Commands and tools

| Command | Purpose |
|---|---|
| `/harness2 run [--task id] [--prompt text] [--k N] [--mode parallel\|sequential] [--seed N] [--no-select] [--no-reflect] [--early-stop] [--dry-run]` | Run a refinement |
| `/harness2 init [id]` | Create a task package (uses the editor in TUI) |
| `/harness2 list` | List tasks, runs, and library entries |
| `/harness2 report [run]` | Print a run report path and summary |
| `/harness2 adopt [run] [label]` | Copy a final harness to `.harness2/adopted/` |
| `/harness2 export [run] [label] [--out dir] [--force]` | Export a final as a native Pi package |
| `/harness2 use [run] [label]` | Apply an adopted harness to this project |
| `/harness2 use --off` | Stop applying the active harness |
| `/harness2 help` | Show usage |

The model can call the `harness2_refine` tool with the same options. It returns
the run ID, adopted label, report path, costs, and the selected deliverable path.

### Exporting a native Pi package

`/harness2 export` writes a Pi package with:

- a generated `extensions/harness2-context.ts` that appends `always-on.md`;
- the harness's skills and a `package.json` manifest that discovers them;
- the harness's agents plus a self-contained `extensions/harness2-subagent.ts`;
- scripts under `scripts/`;
- plugins under `extensions/plugin-*.ts`;
- the full original tree under `harness/` for reference.

Install it with `pi install "<dir>"`, remove it with `pi remove "<dir>"`. This
survives without this extension and is the recommended way to make an adopted
harness permanent.

When a harness is **active** (`/harness2 use`), this extension:

- appends its always-on text to the system prompt on `before_agent_start`, and
  suppresses discovered `AGENTS.md` context files so the same instructions do
  not appear twice;
- returns its `skills/` directories from `resources_discover` (run `/reload`
  after switching so Pi re-discovers them);
- leaves plugins alone. Pi has no safe runtime plugin loading mid-session. To use
  an adopted plugin, load it explicitly with `pi -e`.

---

## 11. What is intentionally different from Harness²

This is a faithful method port, not a benchmark runner.

| Harness² | This extension |
|---|---|
| Benchmarks: JobBench, LAB, WorkBuddy | Any task package in your repository |
| OpenCode/Codex substrates | Pi (solver and editor are both Pi) |
| Separate `judge` and `report` commands with benchmark adapters | Selection is a blind Pi selector; reports are local Markdown/JSON |
| Per-run library namespaces (`bench-substrate-mode-k-seed`) | Persistent per-domain library, so lessons accumulate across invocations; use `HARNESS2_LIBRARY_SCOPE=run` for per-run isolation |
| Docker/sandbox execution for WorkBuddy | Runs in a Git worktree on the host. **Network access is unrestricted**, exactly as in the upstream release. |
| Grader and pass-rate measurement | Optional task `verify` command gates selection only; no score is optimized or shown to editors. |
| Claude CLI / OpenCode proposer channels | Pi proposer subprocesses |

### Known limitations

- **Cost.** A `k=2` parallel run is roughly 4 base/candidate probes + 2
  composition probes + 6–8 editor sessions. Start with `k=1` and a small task.
- **Selection quality.** A blind selector judging workspace diffs is weaker than
  a benchmark-specific judge. Use `/harness2 adopt` to override its choice.
- **Plugins are code.** A proposal can create a Pi extension. It runs with your
  OS permissions. Review `plugins/` before adopting. The evidence boundary tells
  editors never to execute candidate plugins, but validation cannot prove
  intent.
- **Worktrees.** The current working tree is committed into a detached worktree
  as a local baseline. This does not touch your repository history, but it does
  require Git user identity. Set `HARNESS2_WORKSPACE_COPY=1` to force a plain
  copy instead.
- **No automatic application.** The extension never overwrites your project's
  `.pi/` resources. Adoption is explicit.

---

## 12. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `HARNESS2_HOME` | `.harness2` | State directory |
| `HARNESS2_MODEL` | current session model | Solver model (`provider/id`) |
| `HARNESS2_IMPROVER_MODEL` | solver model | Editor/selector/reflector model |
| `HARNESS2_K` | `1` | Recursion budget |
| `HARNESS2_MODE` | `parallel` | `parallel` or `sequential` |
| `HARNESS2_SEED` | unset | Shuffle task order / candidate IDs |
| `HARNESS2_CONCURRENCY` | `2` | Parallel probes and editor sessions |
| `HARNESS2_ROLLOUT_TIMEOUT` | `1800` | Seconds per probe |
| `HARNESS2_PROPOSER_TIMEOUT` | `3600` | Seconds per editor session |
| `HARNESS2_OBS_TRUNC` | `50000` | Characters per observation in evidence |
| `HARNESS2_ALWAYS_ON_MAX` | `16000` | Always-on character cap |
| `HARNESS2_KEEP_WORKSPACES` | `0` | Keep probe worktrees |
| `HARNESS2_WORKSPACE_COPY` | `0` | Force plain-copy workspaces |
| `HARNESS2_LIBRARY_SCOPE` | `shared` | `shared` or `run` |
| `HARNESS2_NO_REFLECT` | `0` | Skip experience reflection |
| `HARNESS2_PI_BIN` | auto | Explicit Pi executable for child sessions |
| `HARNESS2_EARLY_STOP` | `0` | Stop when `k>1` base probes deliver identical artifacts |
| `HARNESS2_VERIFY_TIMEOUT` | `600` | Seconds per verification command |
| `HARNESS2_LEAK_MARKERS` | on | Set `0` to disable the grader-marker tripwire |

---

## 13. Reference

- Paper: [Harness²: Recursive Agent Harnessing for an Open World](https://arxiv.org/abs/2610.14224)
- Code: [google-research/harness2](https://github.com/google-research/harness2)
- Pi extensions: [docs/extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- Pi skills: [docs/skills.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)

Upstream Harness² is Apache-2.0. This port is Apache-2.0 as well. The method and
prompt structure are adapted from the upstream repository; see `NOTICE.md`.
