/**
 * Parallel and sequential task-level recursion.
 *
 * Port of `core/recursion.py`. A `k=1` parallel run is one Propose–Probe–Compose
 * step. Invalid proposals get one retry, then inherit the current harness and are
 * marked `fellBack`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	H2Config,
	ModeResult,
	RunView,
	SelectionResult,
	StageResult,
	TaskSpec,
	Tree,
} from "./types.ts";
import {
	alwaysOnText,
	autotrigger,
	diversity,
	hashTree,
	isUnchanged,
	readTree,
	validate,
	writeTree,
} from "./tree.ts";
import { buildContext, libraryContextDir, type PoolEntry } from "./context.ts";
import {
	aggregate,
	composeRound,
	experience,
	mission,
	profileOf,
	propose,
} from "./prompts.ts";
import { Proposer, readReplyNotes } from "./proposer.ts";
import { addEntry, hasExperience, libraryRoot, parseExperience } from "./library.ts";
import { runProbe } from "./runner.ts";
import { createWorkspace, removeWorkspace } from "./workspace.ts";
import { runSelection } from "./selection.ts";
import {
	copyDir,
	ensureDir,
	isDir,
	mapLimit,
	readText,
	rmrf,
	slugify,
	writeText,
} from "./util.ts";

export interface RefineOptions {
	cfg: H2Config;
	task: TaskSpec;
	baseTree: Tree;
	runDir: string;
	runId: string;
	libraryDir?: string;
	solverModel?: string;
	improverModel?: string;
	signal?: AbortSignal;
	onProgress?: (message: string, fraction?: number) => void;
	ask?: (title: string, options: string[]) => Promise<string | undefined>;
}

export interface RefineResult {
	modeResult: ModeResult;
	selection: SelectionResult;
	adoptedLabel: string;
	adoptedTree: Tree;
	baseRuns: RunView[];
	costs: number;
	errors: string[];
	libraryEntry?: string;
	reflection: string;
}

function tempEvidence(label: string, sourceContext: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `harness2-${slugify(label, "stage")}-`));
	copyDir(sourceContext, path.join(root, "context"));
	return root;
}

function syncHarnessBack(tempRoot: string, stageRoot: string): void {
	const src = path.join(tempRoot, "context", "harness");
	const dst = path.join(stageRoot, "context", "harness");
	if (!isDir(src)) return;
	rmrf(dst);
	copyDir(src, dst);
}

export async function refine(opts: RefineOptions): Promise<RefineResult> {
	const { cfg, task, baseTree, runDir, runId } = opts;
	ensureDir(runDir);
	const profile = profileOf(task);
	const improver = opts.improverModel ?? cfg.improverModel ?? cfg.model;
	const proposer = new Proposer(cfg, improver, path.join(runDir, "events"));
	const errors: string[] = [];
	const progress = opts.onProgress ?? (() => {});
	const rolloutCache = new Map<string, RunView>();

	progress("creating base harness", 0.01);
	writeTree(baseTree, path.join(runDir, "harnesses", "base"));

	const baseLabels = Array.from({ length: cfg.k }, (_, i) => `base${i + 1}`);
	progress(`running ${baseLabels.length} base probe${baseLabels.length === 1 ? "" : "s"}`, 0.03);
	const baseRuns = await mapLimit(baseLabels, cfg.concurrency, (label) =>
		roll(label, baseTree),
	);
	for (let i = 0; i < baseRuns.length; i++) {
		if (!baseRuns[i].ok) errors.push(`${baseRuns[i].label}: ${baseRuns[i].error}`);
	}

	const noSignal = cfg.earlyStop ? baseNoSignal(baseRuns) : undefined;
	if (noSignal) progress(`stopping early: ${noSignal}`, 0.5);

	const libraryForTask =
		cfg.libraryScope === "run"
			? libraryRoot(path.join(runDir, "library"), task.domain)
			: opts.libraryDir ?? libraryRoot(cfg.libraryRoot, task.domain);
	const libCtx = libraryContextDir(libraryForTask);

	let modeResult: ModeResult | undefined;
	if (noSignal) {
		const first = baseRuns[0];
		modeResult = {
			mode: cfg.mode,
			taskId: task.id,
			k: cfg.k,
			stages: [],
			trees: { [first.label]: baseTree },
			rollouts: Object.fromEntries(baseRuns.map((r) => [r.label, r])),
			finals: [first.label],
			base: baseRuns.map((r) => r.label),
			similarity: { n: 1, nDistinct: 1, meanLineJaccard: 1 },
			stoppedEarly: noSignal,
		};
	} else if (cfg.mode === "parallel") {
		modeResult = await runParallel(baseRuns);
	} else {
		modeResult = await runSequential(baseRuns);
	}
	modeResult.errors = errors;

	progress("selecting the delivered artifact", 0.9);
	const finalRuns = modeResult.finals
		.map((label) => modeResult.rollouts[label])
		.filter((r): r is RunView => Boolean(r));
	const selection = await runSelection({
		cfg,
		task,
		runDir,
		finals: finalRuns.map((r) => ({
			label: r.label,
			deliverableTextPath: r.deliverableTextPath,
			verify: r.verify,
		})),
		proposer,
		signal: opts.signal,
		ask: opts.ask,
		onProgress: progress,
	});
	if (!selection.ok) errors.push(`selection: ${selection.error}`);
	const adoptedLabel = selection.ok ? selection.chosenLabel : modeResult.finals[0] ?? "";
	const adoptedTree = adoptedLabel ? (modeResult.trees[adoptedLabel] ?? baseTree) : baseTree;

	// Persist the adopted tree under the run and under the task's latest slot.
	writeTree(adoptedTree, path.join(runDir, "adopted", "harness"), { stubs: false });
	const globalAdopted = path.join(cfg.adoptedRoot, slugify(task.id, "task"));
	writeTree(adoptedTree, path.join(globalAdopted, "harness"), { stubs: false });

	let reflection = "";
	let libraryEntry: string | undefined;
	if (cfg.reflect && !modeResult.stoppedEarly) {
		progress("reflecting on the round", 0.94);
		try {
			const reflectionReply = await reflect(
				baseTree,
				adoptedTree,
				modeResult,
				selection,
				libCtx,
			);
			reflection = reflectionReply.text;
			writeText(path.join(runDir, "reflection.md"), reflection || "(no reflection)");
			const exp = parseExperience(reflection);
			if (hasExperience(exp)) {
				libraryEntry = addEntry({
					libraryRoot: libraryForTask,
					task,
					harness: adoptedTree,
					label: adoptedLabel,
					runId,
					why: selection.reason,
					experience: exp,
				});
			}
		} catch (err) {
			errors.push(`reflection: ${(err as Error).message}`);
		}
	}

	const billedRuns = new Map<string, RunView>();
	for (const run of [...baseRuns, ...Object.values(modeResult.rollouts)]) {
		billedRuns.set(run.label, run);
	}
	const costs =
		[...billedRuns.values()]
			.filter((run) => !run.reusedFrom)
			.reduce((n, run) => n + run.usage.cost, 0) +
		modeResult.stages.reduce((n, s) => n + s.usd, 0) +
		selection.cost;

	return {
		modeResult,
		selection,
		adoptedLabel,
		adoptedTree,
		baseRuns,
		costs,
		errors,
		libraryEntry,
		reflection,
	};

	/* ------------------------------------------------------------------ */

	async function roll(label: string, tree: Tree): Promise<RunView> {
		const artifactKey = hashTree(tree);
		const cached = rolloutCache.get(artifactKey);
		if (cached) {
			writeTree(tree, path.join(runDir, "harnesses", label));
			return {
				...cached,
				label,
				artifactKey,
				reusedFrom: cached.reusedFrom ?? cached.label,
			};
		}
		const harnessDir = writeTree(tree, path.join(runDir, "harnesses", label));
		const wsDir = path.join(runDir, "workspaces", label);
		try {
			const ws = createWorkspace(cfg.cwd, wsDir, cfg);
			progress(`probe ${label} (${alwaysOnText(tree).length.toLocaleString()} always-on chars)`);
			const run = await runProbe({
				label,
				task,
				tree,
				harnessDir,
				workspace: ws,
				runDir,
				cfg,
				model: opts.solverModel ?? cfg.model,
				thinking: cfg.thinking,
				signal: opts.signal,
				onProgress: (m) => progress(m),
			});
			if (!cfg.keepWorkspaces) removeWorkspace(ws);
			run.artifactKey = artifactKey;
			if (run.ok) rolloutCache.set(artifactKey, run);
			return run;
		} catch (err) {
			const rolloutDir = path.join(runDir, "rollouts", label);
			ensureDir(rolloutDir);
			writeText(path.join(rolloutDir, "trajectory.md"), `[ERROR] probe failed: ${(err as Error).message}\n`);
			writeText(path.join(rolloutDir, "deliverable", "deliverable.md"), "(probe failed before producing a deliverable)\n");
			if (!cfg.keepWorkspaces) rmrf(wsDir);
			return {
				label,
				taskId: task.id,
				runDir: rolloutDir,
				workspaceDir: wsDir,
				eventsPath: path.join(rolloutDir, "events.jsonl"),
				trajectoryPath: path.join(rolloutDir, "trajectory.md"),
				deliverableDir: path.join(rolloutDir, "deliverable"),
				deliverableTextPath: path.join(rolloutDir, "deliverable", "deliverable.md"),
				ok: false,
				delivered: false,
				exitCode: 1,
				error: (err as Error).message,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				wallS: 0,
				changedFiles: [],
				artifactKey,
			};
		}
	}

	function baseNoSignal(runs: RunView[]): string | undefined {
		if (runs.length < 2 || !runs.every((r) => r.ok && r.delivered)) return undefined;
		const signatures = runs.map((r) => readText(r.deliverableTextPath, "").trim());
		if (signatures.some((s) => !s)) return undefined;
		if (new Set(signatures).size > 1) return undefined;
		return `${runs.length} base probes delivered identical artifacts; no behavioral contrast to act on`;
	}

	function syntheticStage(
		label: string,
		dim: StageResult["dim"],
		tree: Tree,
		notes: string,
	): StageResult {
		return {
			label,
			dim,
			tree: { ...tree },
			keptBase: true,
			fellBack: false,
			error: "",
			notes,
			usd: 0,
			wallS: 0,
			attempts: 0,
			cached: false,
		};
	}

	async function runStage(args: {
		label: string;
		dim: StageResult["dim"];
		job: string;
		fallback: Tree;
		harness: Tree;
		rollouts: RunView[];
		pool?: PoolEntry[];
		decisions?: Record<string, string>;
	}): Promise<StageResult> {
		const stageRoot = path.join(runDir, "evidence", args.label);
		const ctxDir = path.join(stageRoot, "context");
		let tree: ReturnType<typeof buildContext>;
		try {
			tree = buildContext({
				dest: ctxDir,
				task,
				harness: args.harness,
				rollouts: args.rollouts,
				pool: args.pool ?? [],
				libraryDir: libCtx,
				decisions: args.decisions ?? {},
			});
		} catch (err) {
			return {
				label: args.label,
				dim: args.dim,
				tree: { ...args.fallback },
				keptBase: false,
				fellBack: true,
				error: `could not build evidence: ${(err as Error).message}`.slice(0, 800),
				notes: "",
				usd: 0,
				wallS: 0,
				attempts: 0,
				cached: false,
			};
		}

		const job = mission(args.job, tree.layout);
		const tempRoot = tempEvidence(args.label, ctxDir);
		let err = "";
		let spent = 0;
		let attempts = 0;
		let cached = true;
		try {
		for (let attempt = 1; attempt <= cfg.proposerAttempts; attempt++) {
			const text = err
				? `${job}\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${err}\n\nFix it in \`context/harness/\` and reply again.`
				: job;
			const reply = await proposer.call(text, tempRoot, `${args.label}.a${attempt}`, {
				signal: opts.signal,
				onProgress: (m) => progress(m),
			});
			spent += reply.costUsd;
			attempts += reply.cached ? 0 : Math.max(1, reply.attempts);
			cached = cached && reply.cached;
			if (!reply.ok || !reply.workspace) {
				err = reply.error || "the harness directory did not come back from the session";
				continue;
			}
			const rejected: string[] = [];
			const next = readTree(reply.workspace, rejected);
			if (!Object.keys(next).length) {
				err = "`context/harness/` came back empty — edit the files, do not delete them all";
				continue;
			}
			if (rejected.length) {
				err = `these files are off the editable surface and were not applied: ${rejected
					.slice(0, 8)
					.join(", ")}. Component names must be lowercase letters, digits, \`_\` or \`-\` (for example \`skills/doc_review/SKILL.md\`, \`scripts/check_totals.py\`).`;
				writeTree(next, path.join(tempRoot, "context", "harness"));
				syncHarnessBack(tempRoot, stageRoot);
				continue;
			}
			const triggered = autotrigger(next, cfg.alwaysOnMax);
			if (triggered.length) progress(`auto-triggered skill(s): ${triggered.join(", ")}`);
			try {
				validate(next, {
					alwaysOnMax: cfg.alwaysOnMax,
					allowAgents: true,
					allowPlugins: true,
					compilePython: true,
				});
			} catch (validation) {
				err = (validation as Error).message;
				writeTree(next, path.join(tempRoot, "context", "harness"));
				syncHarnessBack(tempRoot, stageRoot);
				continue;
			}
			syncHarnessBack(tempRoot, stageRoot);
			return {
				label: args.label,
				dim: args.dim,
				tree: next,
				keptBase: isUnchanged(args.fallback, next),
				fellBack: false,
				error: "",
				notes: readReplyNotes(reply.text),
				usd: spent,
				wallS: reply.wallS,
				attempts,
				cached,
			};
		}
		syncHarnessBack(tempRoot, stageRoot);
		return {
			label: args.label,
			dim: args.dim,
			tree: { ...args.fallback },
			keptBase: false,
			fellBack: true,
			error: err.slice(0, 800),
			notes: "",
			usd: spent,
			wallS: 0,
			attempts,
			cached,
		};
		} finally {
			rmrf(tempRoot);
		}
	}

	async function rollStages(
		stages: StageResult[],
		startFraction: number,
		result: ModeResult,
	): Promise<void> {
		await mapLimit(stages, cfg.concurrency, async (stage) => {
			const run = await roll(stage.label, stage.tree);
			result.rollouts[stage.label] = run;
		});
		progress(`probed ${stages.length} candidate${stages.length === 1 ? "" : "s"}`, startFraction);
	}

	async function runParallel(base: RunView[]): Promise<ModeResult> {
		const result: ModeResult = {
			mode: cfg.mode,
			taskId: task.id,
			k: cfg.k,
			stages: [],
			trees: {},
			rollouts: Object.fromEntries(base.map((r) => [r.label, r])),
			finals: [],
			base: base.map((r) => r.label),
			similarity: { n: 0, nDistinct: 0, meanLineJaccard: 1 },
		};
		const specs: Array<{ label: string; dim: "INV" | "DOM"; index: number }> = [];
		for (let i = 1; i <= cfg.k; i++) {
			specs.push({ label: `inv${i}`, dim: "INV", index: i });
			specs.push({ label: `dom${i}`, dim: "DOM", index: i });
		}
		progress(`proposing ${specs.length} dimension candidates`, 0.2);
		const stages = await mapLimit(specs, cfg.concurrency, (s) =>
			runStage({
				label: s.label,
				dim: s.dim,
				job: propose(profile, s.dim, { k: cfg.k, index: s.index }),
				fallback: baseTree,
				harness: baseTree,
				rollouts: base,
			}),
		);
		for (const stage of stages) {
			result.stages.push(stage);
			result.trees[stage.label] = stage.tree;
		}
		await rollStages(stages, 0.45, result);

		const pool: PoolEntry[] = stages.map((s) => ({
			label: s.label,
			harnessDir: path.join(runDir, "harnesses", s.label),
			run: result.rollouts[s.label],
		}));
		const decisions = Object.fromEntries(stages.map((s) => [s.label, s.notes || s.error]));
		const noCandidateChange = stages.every((s) => isUnchanged(baseTree, s.tree));
		const aggLabels = Array.from({ length: cfg.k }, (_, i) => `agg${i + 1}`);
		progress(
			noCandidateChange
				? "skipping composition: every candidate kept the base"
				: `composing ${cfg.k} final harness${cfg.k === 1 ? "" : "es"}`,
			0.55,
		);
		const aggs = noCandidateChange
			? aggLabels.map((label) =>
					syntheticStage(
						label,
						"AGG",
						baseTree,
						"skipped composition: every dimension candidate was identical to the base",
					),
				)
			: await mapLimit(aggLabels, cfg.concurrency, (label) => {
					const index = Number.parseInt(label.slice(3), 10);
					return runStage({
						label,
						dim: "AGG",
						job: aggregate(profile, { k: cfg.k, index }),
						fallback: baseTree,
						harness: baseTree,
						rollouts: base,
						pool,
						decisions,
					});
				});
		if (noCandidateChange) {
			result.stoppedEarly =
				"every dimension candidate was identical to the base; composition skipped";
		}
		for (const stage of aggs) {
			result.stages.push(stage);
			result.trees[stage.label] = stage.tree;
			result.finals.push(stage.label);
		}
		await rollStages(aggs, 0.85, result);
		result.similarity = diversity(Object.fromEntries(aggs.map((s) => [s.label, s.tree])));
		return result;
	}

	async function runSequential(base: RunView[]): Promise<ModeResult> {
		const result: ModeResult = {
			mode: cfg.mode,
			taskId: task.id,
			k: cfg.k,
			stages: [],
			trees: {},
			rollouts: Object.fromEntries(base.map((r) => [r.label, r])),
			finals: [],
			base: base.map((r) => r.label),
			similarity: { n: 0, nDistinct: 0, meanLineJaccard: 1 },
		};
		let current = baseTree;
		let history: PoolEntry[] = [];
		const decisions: Record<string, string> = {};
		const finals: string[] = [];
		for (let t = 1; t <= cfg.k; t++) {
			const fraction = 0.15 + (0.65 * (t - 1)) / cfg.k;
			progress(`round ${t}/${cfg.k}: proposing INV and DOM`, fraction);
			const stages = await mapLimit(
				[
					{ label: `inv${t}`, dim: "INV" as const },
					{ label: `dom${t}`, dim: "DOM" as const },
				],
				2,
				(s) =>
					runStage({
						label: s.label,
						dim: s.dim,
						job: propose(profile, s.dim, {
							k: cfg.k,
							index: t,
							round: cfg.k > 1 ? t : undefined,
						}),
						fallback: current,
						harness: current,
						rollouts: base,
						pool: history,
						decisions,
					}),
			);
			for (const stage of stages) {
				result.stages.push(stage);
				result.trees[stage.label] = stage.tree;
				decisions[stage.label] = stage.notes || stage.error;
			}
			await rollStages(stages, fraction + 0.1, result);

			const roundPool: PoolEntry[] = [
				...history,
				...stages.map((s) => ({
					label: s.label,
					harnessDir: path.join(runDir, "harnesses", s.label),
					run: result.rollouts[s.label],
				})),
			];
			const compLabel = `c${t}`;
			const noRoundChange = stages.every((s) => isUnchanged(current, s.tree));
			progress(
				noRoundChange
					? `round ${t}/${cfg.k}: skipping composition, both candidates kept the checkpoint`
					: `round ${t}/${cfg.k}: composing checkpoint ${t}`,
				fraction + 0.15,
			);
			const comp = noRoundChange
				? syntheticStage(
						compLabel,
						"COMPOSE",
						current,
						"skipped composition: both candidates were identical to the current checkpoint",
					)
				: await runStage({
						label: compLabel,
						dim: "COMPOSE",
						job:
							cfg.k === 1
								? aggregate(profile, { k: 1, index: 1 })
								: composeRound(profile, { t, k: cfg.k }),
						fallback: current,
						harness: current,
						rollouts: base,
						pool: roundPool,
						decisions,
					});
			result.stages.push(comp);
			result.trees[compLabel] = comp.tree;
			decisions[compLabel] = comp.notes || comp.error;
			const compRun = await roll(compLabel, comp.tree);
			result.rollouts[compLabel] = compRun;
			finals.push(compLabel);
			history = [
				...roundPool,
				{ label: compLabel, harnessDir: path.join(runDir, "harnesses", compLabel), run: compRun },
			];
			current = comp.tree;
			if (noRoundChange) {
				result.stoppedEarly =
					"both dimension candidates kept the checkpoint; remaining rounds skipped";
				break;
			}
		}
		result.finals = finals;
		result.similarity = diversity(
			Object.fromEntries(result.finals.map((label) => [label, result.trees[label] ?? baseTree])),
		);
		return result;
	}

	async function reflect(
		base: Tree,
		adopted: Tree,
		mode: ModeResult,
		sel: SelectionResult,
		lib: string | undefined,
	): Promise<{ text: string }> {
		const stageRoot = path.join(runDir, "evidence", "reflect");
		const ctxDir = path.join(stageRoot, "context");
		const pool: PoolEntry[] = mode.stages
			.map((s) => ({
				label: s.label,
				harnessDir: path.join(runDir, "harnesses", s.label),
				run: mode.rollouts[s.label],
			}))
			.filter((p) => fs.existsSync(p.harnessDir));
		buildContext({
			dest: ctxDir,
			task,
			harness: base,
			rollouts: baseRuns,
			pool,
			libraryDir: lib,
			decisions: Object.fromEntries(mode.stages.map((s) => [s.label, s.notes || s.error])),
		});
		writeTree(base, path.join(ctxDir, "base_harness"), { stubs: false });
		writeTree(adopted, path.join(ctxDir, "adopted", "harness"), { stubs: false });
		writeText(
			path.join(ctxDir, "selection.md"),
			`# Selection\n\n- chosen: \`${sel.chosenLabel}\`${sel.chosenId ? ` (anonymous id \`${sel.chosenId}\`)` : ""}\n- reason:\n\n${sel.reason || "(none)"}\n`,
		);
		const tempRoot = tempEvidence("reflect", ctxDir);
		try {
			const reply = await proposer.call(experience(profile), tempRoot, "reflect", {
				tools: ["read", "ls", "grep"],
				harvest: null,
				signal: opts.signal,
				onProgress: (m) => progress(m),
			});
			if (!reply.ok) throw new Error(reply.error || "reflection session failed");
			return { text: reply.text };
		} finally {
			rmrf(tempRoot);
		}
	}
}
