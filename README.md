# pi-harness2

This is a Pi extension that runs Harness² on a task you actually have. Pi runs the
task under its current harness, two editors propose changes to that harness, the
task runs again with each proposal, and a composer keeps the version the evidence
supports. The model stays fixed.

The method comes from [google-research/harness2](https://github.com/google-research/harness2).
[HARNESS2.md](HARNESS2.md) has the full study, the component mapping, and the
places where this port differs from the upstream runner.

## What counts as a harness

In Pi, the editable harness is plain text on disk:

```text
systemprompt.md                  always on
guardrails.md                    always on
LongTermMEMORY.md                always on
tool_descriptions/tool_guidance.md
skills/<name>/SKILL.md           advertised, loaded on demand
skills/<name>/scripts/*          helper carried with a skill
agents/<name>.md                 subagent, separate Pi process
scripts/<name>.py                deterministic helper
plugins/<name>.ts                Pi extension, runs inside the tool loop
```

The four always-on files are joined and passed to each probe as
`--append-system-prompt`. Skills are passed with `--skill`. Agents activate a
small `task` tool. Plugins load with `-e`.

INV editors change how the agent works: tool use, reading order, verification,
scripts, budget, completion. DOM editors change what a practitioner knows: the
artifact contract, domain checks, decision rules, facts worth keeping. A composer
merges their work. It can also return the base harness unchanged, and that is a
valid outcome.

## The loop

For one task at `k=1`:

```text
base probes ──► INV editor ──► probe ──┐
             └► DOM editor ──► probe ──┴► composer ──► probe ──► blind selection
                                                                      │
                                                     experience reflection
                                                                      │
                                                            per-domain library
```

`k` is the task-level recursion budget.

- `k=1` runs one propose, probe, and compose step.
- `--k K --mode parallel` makes `K` INV and `K` DOM candidates from the same base evidence, then `K` independent compositions.
- `--k K --mode sequential` runs `K` rounds, each one building on the previous checkpoint.

After selection, an experience reflector compares every candidate with the base
and records what each edit did: helped, hurt, no observed effect, or confounded.
It writes at most one lesson for the domain. Later tasks in that domain read the
lesson before their editors start.

Two cost controls avoid work the evidence does not need. A candidate tree that is
byte-identical to an earlier probe reuses that probe instead of rolling again.
If every dimension candidate keeps the base, composition is skipped and no
composer session is spent. The report marks both cases.

Every probe and every editor is an isolated Pi subprocess. Probes run in a Git
worktree with your uncommitted changes applied as a local baseline, so `git diff`
shows exactly what the probe changed. Outside Git, the extension copies the
project and filters build and cache directories. Your working tree is not
modified either way.

## Install

Requires Pi 1.3 or newer.

```bash
# one invocation, no install
pi -e /path/to/pi-harness2/src/index.ts

# or install the local package
pi install /path/to/pi-harness2
```

There is no build step. The package manifest points at `src/index.ts`.

## Quick start

```bash
cd /path/to/your/repo

# 1. Create a task package. In the TUI this opens an editor for the prompt.
/harness2 init fix-parser

# 2. See what would run, without model calls
/harness2 run --task fix-parser --k 1 --dry-run

# 3. Run one propose, probe, and compose step
/harness2 run --task fix-parser --k 1

# 4. Read the report
/harness2 report

# 5. Apply the adopted harness to this project
/harness2 use
```

If you leave out `--task`, the latest user message becomes the task prompt. The
model can also call the `harness2_refine` tool with the same options.

A `k=1` run costs about four probes and three editor sessions. Costs are read from
Pi's usage events and recorded in the run. Start with `k=1` on a small task. A
`k=2` run is much more expensive.

## Commands

| Command | What it does |
|---|---|
| `/harness2 run [--task id] [--prompt "text"] [--k N] [--mode parallel\|sequential] [--seed N] [--domain name] [--select auto\|ask\|first] [--no-reflect] [--early-stop] [--dry-run]` | Run the recursion |
| `/harness2 init [id] [--prompt "text"] [--domain name] [--deliverables a,b] [--yardstick "text"] [--verify "command"] [--source dir]` | Create a task package |
| `/harness2 list` | List tasks, runs, library domains, and the active harness |
| `/harness2 report [run]` | Show a run report |
| `/harness2 adopt [run] [label] [--use]` | Copy a final harness to `.harness2/adopted/` |
| `/harness2 export [run] [label] [--out dir] [--force]` | Export a final harness as a native Pi package |
| `/harness2 use [run] [label]` | Apply a harness to this project |
| `/harness2 use --off` | Stop applying it |
| `/harness2 status` | Show the active harness and the latest run |

`--select` controls how the final is picked. `auto` uses a blind selector when
there is more than one final. `ask` opens a picker. `first` takes the first
candidate and spends no selector session.

When a task declares a `verify` command, selection runs it in each probe
workspace. If some candidates pass and others fail, only the passing ones reach
the selector. Verification gates selection, never adaptation: the editors still
work from behavioral evidence.

The model can call `harness2_refine` with the same options. It returns the run
id, adopted label, report path, costs, and the selected deliverable.

## Status bar

The footer shows the current state:

- `H² ready` means no active harness.
- `H² active <task>/<label>` means an adopted harness is applied.
- `H² parallel k=1 45% probing inv1` means a run is in progress.

During a run, a small panel above the editor shows the task, a progress bar,
elapsed time, and the current phase. It clears when the run finishes.

## Task packages

`/harness2 init` writes a directory under `.harness2/tasks/<id>/`:

```text
.harness2/tasks/reconcile-q3/
├── task.json
├── task.md          # optional, if the prompt lives in Markdown
└── source/          # optional read-only material
```

A `task.json` can look like this:

```json
{
  "id": "reconcile-q3",
  "prompt": "Reconcile the Q3 ledger against the bank export. Deliver reconciliation.xlsx.",
  "domain": "accounting",
  "deliverables": ["reconciliation.xlsx", "notes.md"],
  "leakGlobs": ["*.answer", "expected/*"],
  "yardstick": "The workbook must tie every unmatched row to a source document.",
  "verify": "python3 check.py reconciliation.xlsx"
}
```

`domain` selects the experience library. Tasks in the same domain read each
other's lessons; different domains stay separate.

`deliverables` is optional. When present, those paths are rendered into the
selection evidence. When absent, the workspace diff is the deliverable.

`leakGlobs` keeps answer keys out of the proposer's evidence tree. The evidence
builders also refuse common grader-verdict markers unless you set
`HARNESS2_LEAK_MARKERS=0`.

`yardstick` describes good process. It is not a score and should not be written
like a rubric.

## Reading a run

Each run lives under `.harness2/runs/<run-id>/`:

```text
run.json                   configuration and status
result.json                stages, selection, adoption, costs
report.md                  human-readable report
events/                    raw proposer JSONL
evidence/<stage>/context/  evidence trees
selection/context/         blind-selection evidence
harnesses/<label>/         every candidate tree
workspaces/<label>/        probe workspaces, removed by default
rollouts/<label>/
├── events.jsonl
├── trajectory.md
├── deliverable/
├── verify.txt             only when the task declares verify
└── run.json
```

`/harness2 report` opens the latest report. Reports include a stage table, a
rollout table, costs, and a diff between the base and adopted harness.

## Applying a harness

`/harness2 adopt` copies a final into `.harness2/adopted/<task>/harness/`.
`/harness2 use` makes this project's Pi sessions use it:

- the harness's always-on text is appended to the system prompt;
- its skills are returned from Pi's resource discovery;
- discovered `AGENTS.md` context files are suppressed, so the same instructions
  do not appear twice;
- plugins are not loaded implicitly. If you review one and want it, load it with
  `pi -e <harness>/plugins/<name>.ts`.

Activation reloads Pi so it rediscovers the harness skills.

`/harness2 export` writes a self-contained Pi package instead. It contains the
always-on extension, skills, agents, scripts, and plugins, plus the original tree
under `harness/` for audit. Install it with the printed `pi install` command.
Plugins in an exported package are executable code. Read them before installing.

## Where state lives

```text
.harness2/
├── tasks/<id>/                  task packages
├── runs/<run-id>/               evidence, harnesses, rollouts, reports
├── library/<domain>/            adopted harnesses and transferable lessons
├── adopted/<task>/harness/      latest adopted tree
├── exports/                     generated Pi packages
└── active.json                  the harness applied to this project
```

Add `.harness2/` to `.gitignore`. It holds full trajectories, probe workspaces,
and model costs.

## Configuration

All environment variables are optional.

| Variable | Default | Meaning |
|---|---|---|
| `HARNESS2_HOME` | `.harness2` | State directory |
| `HARNESS2_MODEL` | current session model | Solver model, `provider/id` |
| `HARNESS2_IMPROVER_MODEL` | solver model | Editor and reflector model |
| `HARNESS2_SELECTOR_MODEL` | improver model | Selector model |
| `HARNESS2_K` | `1` | Recursion budget, clamped to 1 to 8 |
| `HARNESS2_MODE` | `parallel` | `parallel` or `sequential` |
| `HARNESS2_SEED` | unset | Shuffle candidate ids |
| `HARNESS2_CONCURRENCY` | `2` | Parallel probes and editor sessions |
| `HARNESS2_ROLLOUT_TIMEOUT` | `1800` | Seconds per probe |
| `HARNESS2_PROPOSER_TIMEOUT` | `3600` | Seconds per editor session |
| `HARNESS2_PROPOSER_ATTEMPTS` | `2` | Validation attempts per proposal |
| `HARNESS2_TRANSPORT_ATTEMPTS` | `2` | Retries for a failed child transport |
| `HARNESS2_VERIFY_TIMEOUT` | `600` | Seconds for a task's verify command |
| `HARNESS2_OBS_TRUNC` | `50000` | Characters per observation in evidence |
| `HARNESS2_ALWAYS_ON_MAX` | `16000` | Always-on character cap |
| `HARNESS2_KEEP_WORKSPACES` | `0` | Keep probe worktrees |
| `HARNESS2_WORKSPACE_COPY` | `0` | Use a plain copy instead of a Git worktree |
| `HARNESS2_LIBRARY_SCOPE` | `shared` | `shared` across runs or `run`-local |
| `HARNESS2_NO_REFLECT` | `0` | Skip reflection |
| `HARNESS2_EARLY_STOP` | `0` | Stop when `k>1` base probes deliver identical artifacts |
| `HARNESS2_LEAK_MARKERS` | on | Set `0` to disable the grader-marker tripwire |
| `HARNESS2_PI_BIN` | auto | Explicit Pi executable for child sessions |

## Validation

Every proposal is repaired and validated before it is probed. A proposal that
fails gets one retry with the error text as feedback. If it fails again, the stage
inherits the current harness and is marked `fellBack`.

The validator rejects the whole tree when:

- the concatenated always-on text is empty or over the cap;
- a skill lacks `description:`, a matching `name:`, or a trigger line naming the
  skill in the always-on text;
- a referenced script is missing;
- a Python script does not parse;
- a path is outside the allowlisted surface;
- evidence would include a file matching `leakGlobs`.

When a skill has no trigger line, the validator can add one if there is room.

## Safety

- Probes run with your OS permissions and unrestricted network access, as the
  upstream release does.
- Plugins are executable code. A proposal can create one. Read `plugins/` before
  adopting or activating a harness.
- The extension never writes to your project's `.pi/` or `AGENTS.md`. Adoption
  and activation are explicit.
- Session shutdown terminates child Pi processes.

## Development

```bash
npm install --ignore-scripts
npx tsc --noEmit
pi -e ./src/index.ts --help
```

See [AGENTS.md](AGENTS.md) for the coding rules used in this repository.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). The method and
prompt structure are adapted from Google's Harness². The Pi implementation is
new.
