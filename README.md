# pi-harness2

**Harness² as a Pi extension.** Recursively improve the harness Pi runs under — its standing instructions, skills, subagents, scripts, and plugins — for the task in front of you, using the task's own execution evidence instead of a rubric or score.

Based on [google-research/harness2](https://github.com/google-research/harness2) (Apache-2.0). See [HARNESS2.md](HARNESS2.md) for the full study, component mapping, pipeline, and design notes.

## What it does

For one task, with a fixed model:

```text
base probes ──► INV editor ──► probe ──┐
             └► DOM editor ──► probe ──┴► composer ──► probe ──► blind selection
                                                                      │
                                                     experience reflection
                                                                      │
                                                            per-domain library
```

- **INV** edits *how the agent works*: tool use, reading order, verification, scripts, budget, completion.
- **DOM** edits *what a practitioner knows*: artifact contract, domain checks, decision rules, durable facts.
- **Composer** merges only what the evidence supports. Keeping the base unchanged is a valid outcome.
- **Reflection** records what each edit did and at most one transferable lesson for later tasks in the same domain.

Every probe and every editor is an isolated Pi subprocess. The current project is never modified; probes run in Git worktrees (or a filtered copy outside Git).

## Install

Requires Pi 1.3+.

```bash
# try it for one invocation
pi -e /path/to/pi-harness2/src/index.ts

# or install the local package
pi install /path/to/pi-harness2
```

The package manifest points at `src/index.ts`; no build step is required.

## Quick start

```bash
cd /path/to/your/repo

# 1. Create a task package. In the TUI, this opens an editor for the prompt.
/harness2 init fix-parser

# 2. Preview what would run (no model calls)
/harness2 run --task fix-parser --k 1 --dry-run

# 3. Run one Propose–Probe–Compose step
/harness2 run --task fix-parser --k 1

# 4. Read the report
/harness2 report

# 5. Apply the adopted harness to future sessions in this project
/harness2 use
```

If you do not pass `--task`, the latest user message becomes the task prompt.

The model can also call the `harness2_refine` tool with the same options.

## Status bar

The footer shows the current Harness² state:

- `H² ready` — no active harness
- `H² active task/label` — an adopted harness is applied
- `H² parallel k=1 45% probing inv1` — a run is in progress

During a run, a small progress panel also appears above the editor with the task, a
progress bar, elapsed time, and the current phase. These update while probes and
editor sessions run, and clear when the run finishes. `/harness2 status` prints
the active harness and latest run.

## Commands

| Command | Purpose |
|---|---|
| `/harness2 run [--task id] [--prompt "text"] [--k N] [--mode parallel\|sequential] [--seed N] [--select auto\|ask\|first] [--no-reflect] [--dry-run]` | Run the recursion |
| `/harness2 init [id] [--prompt "text"] [--domain name]` | Create a task package |
| `/harness2 list` | List tasks, runs, active harness |
| `/harness2 report [run]` | Show a run report |
| `/harness2 adopt [run] [label] [--use]` | Copy a final harness to `.harness2/adopted/` |
| `/harness2 use [run] [label]` | Apply a harness to this project |
| `/harness2 use --off` | Stop applying it |
| `/harness2 status` | Show the active harness and latest run |

`k` is the task-level recursion budget:

- `k=1` — one Propose–Probe–Compose step.
- `--k K --mode parallel` — `K` INV + `K` DOM candidates, then `K` independent compositions (explore wider).
- `--k K --mode sequential` — `K` successive rounds carrying the checkpoint and evidence forward (refine deeper).

At `k=1` a parallel run costs roughly **4 probes + 3 editor sessions**. Start there. Costs are recorded per run from Pi's usage events; editor sessions and probes are both billable.

## The editable harness

Harnesses live on disk and are plain text. The surface is allowlisted:

```text
systemprompt.md                  always on
guardrails.md                    always on
LongTermMEMORY.md                always on
tool_descriptions/tool_guidance.md
skills/<name>/SKILL.md           advertised, loaded on demand
skills/<name>/scripts/*          helper carried with a skill
agents/<name>.md                 subagent, separate Pi process
scripts/<name>.py                deterministic helper
plugins/<name>.ts                real Pi extension, acts in the tool loop
```

The four always-on files are concatenated into `--append-system-prompt` for each probe. Skills are passed with `--skill`; agents activate a small built-in `task` tool; plugins are loaded with `-e`.

Validation rejects a proposal as a whole when a skill has no `description:` or no trigger line, a referenced script is missing, Python does not parse, a path is off-surface, or always-on text exceeds the cap. Invalid proposals get one retry with the error text as feedback.

## Where state lives

```text
.harness2/
├── tasks/<id>/                  task packages (task.json, task.md, source/)
├── runs/<run-id>/               evidence, harnesses, rollouts, report.md, result.json
├── library/<domain>/            adopted harnesses + transferable lessons
├── adopted/<task>/harness/      latest adopted tree
└── active.json                  the harness applied to this project
```

Add `.harness2/` to `.gitignore`. It contains full trajectories and possibly model costs.

## Applying an adopted harness

`/harness2 use` makes this extension append the harness's always-on text on every run and advertise its skills through Pi's resource discovery. While a harness is active, discovered `AGENTS.md` context files are suppressed so the same instructions do not appear twice; the active harness is the always-on layer. Pi reloads skills; plugins are **not** loaded implicitly — use `pi -e <harness>/plugins/<name>.ts` if you reviewed one and want it.

## Safety

- Probes run with your OS permissions and **unrestricted network access**, exactly as upstream Harness²'s release does.
- Plugins are executable code. A proposal can create one. Read `plugins/` before adopting or activating a harness.
- Evidence builders refuse task files matching `leakGlobs` and refuse common grader-verdict markers.
- Nothing is written to your project's `.pi/` or `AGENTS.md`. Adoption is explicit.
- Session shutdown terminates child Pi processes.

## Configuration

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `HARNESS2_HOME` | `.harness2` | State directory |
| `HARNESS2_MODEL` | current model | Solver model |
| `HARNESS2_IMPROVER_MODEL` | solver model | Editor/selector/reflector model |
| `HARNESS2_K` | `1` | Recursion budget |
| `HARNESS2_MODE` | `parallel` | `parallel` or `sequential` |
| `HARNESS2_SEED` | unset | Shuffle candidate ids |
| `HARNESS2_CONCURRENCY` | `2` | Parallel probes/editor sessions |
| `HARNESS2_ROLLOUT_TIMEOUT` | `1800` | Seconds per probe |
| `HARNESS2_PROPOSER_TIMEOUT` | `3600` | Seconds per editor session |
| `HARNESS2_OBS_TRUNC` | `50000` | Characters per observation in evidence |
| `HARNESS2_ALWAYS_ON_MAX` | `16000` | Always-on character cap |
| `HARNESS2_KEEP_WORKSPACES` | `0` | Keep probe worktrees |
| `HARNESS2_WORKSPACE_COPY` | `0` | Force a plain-copy workspace instead of a Git worktree |
| `HARNESS2_LIBRARY_SCOPE` | `shared` | `shared` across runs or `run`-local |
| `HARNESS2_NO_REFLECT` | `0` | Skip reflection |
| `HARNESS2_LEAK_MARKERS` | on | Set `0` to disable the grader-marker tripwire (explicit `leakGlobs` still apply) |
| `HARNESS2_PI_BIN` | auto | Explicit Pi executable for child sessions |

## Development

```bash
npm install --ignore-scripts
npx tsc --noEmit
pi -e ./src/index.ts --help
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). The method and prompt structure are adapted from Google's Harness²; the Pi implementation is new.
