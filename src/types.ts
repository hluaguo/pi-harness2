/**
 * Shared types for the Harness² Pi extension.
 *
 * The names deliberately mirror the upstream Python method (`core/spec.py`,
 * `core/recursion.py`): TaskSpec ≈ BenchSpec + adapter, RunView, Stage, ModeResult.
 */

export type Tree = Record<string, string>;
export type Mode = "parallel" | "sequential";
export type Dimension = "INV" | "DOM" | "AGG" | "COMPOSE";

export interface TaskSpec {
	/** Stable id, also the task directory name. */
	id: string;
	/** The task as the solver receives it. */
	prompt: string;
	/** Grouping unit for the experience library. */
	domain: string;
	/** Optional declared artifact paths, relative to the workspace. */
	deliverables: string[];
	/** Optional answer-key globs kept out of evidence. */
	leakGlobs: string[];
	/** Optional description of good process, never a score. */
	yardstick: string;
	/** Optional deterministic check run in each probe workspace. Used for selection, never adaptation. */
	verify?: string;
	/** Optional directory of read-only source material. */
	sourceDir?: string;
	/** Directory holding task.json/task.md. */
	dir?: string;
}

export interface VerifyResult {
	command: string;
	ok: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
}

export interface RunView {
	label: string;
	taskId: string;
	runDir: string;
	workspaceDir: string;
	eventsPath: string;
	trajectoryPath: string;
	deliverableDir: string;
	deliverableTextPath: string;
	ok: boolean;
	delivered: boolean;
	exitCode: number;
	error: string;
	stopReason?: string;
	model?: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
	wallS: number;
	changedFiles: string[];
	verify?: VerifyResult;
	/** Canonical hash of the harness tree that produced this run, for rollout dedup. */
	artifactKey?: string;
	/** Label whose rollout this one reused, when the trees were byte-identical. */
	reusedFrom?: string;
}

export interface StageResult {
	label: string;
	dim: Dimension;
	tree: Tree;
	keptBase: boolean;
	fellBack: boolean;
	error: string;
	notes: string;
	usd: number;
	wallS: number;
	attempts: number;
	cached: boolean;
}

export interface ModeResult {
	mode: Mode;
	taskId: string;
	k: number;
	stages: StageResult[];
	trees: Record<string, Tree>;
	rollouts: Record<string, RunView>;
	finals: string[];
	base: string[];
	similarity: {
		n: number;
		nDistinct: number;
		meanLineJaccard: number;
	};
	errors?: string[];
	stoppedEarly?: string;
}

export interface LibraryExperience {
	cue: string;
	lesson: string;
	evidence: string;
	confidence: string;
	edits: string;
}

export interface SelectionResult {
	ok: boolean;
	chosenLabel: string;
	chosenId: string;
	reason: string;
	cost: number;
	pools: Array<{ id: string; label: string }>;
	error: string;
	verified?: {
		gated: boolean;
		passing: string[];
		failing: string[];
	};
}

export interface H2Config {
	cwd: string;
	home: string;
	runsRoot: string;
	tasksRoot: string;
	libraryRoot: string;
	baseDir: string;
	adoptedRoot: string;
	activePath: string;
	k: number;
	mode: Mode;
	seed?: number;
	model?: string;
	improverModel?: string;
	selectorModel?: string;
	thinking?: string;
	concurrency: number;
	rolloutTimeoutMs: number;
	proposerTimeoutMs: number;
	obsTrunc: number;
	alwaysOnMax: number;
	keepWorkspaces: boolean;
	workspaceCopy: boolean;
	libraryScope: "shared" | "run";
	reflect: boolean;
	select: "auto" | "ask" | "first";
	proposerAttempts: number;
	transportAttempts: number;
	verifyTimeoutMs: number;
	earlyStop: boolean;
}

export interface Progress {
	(message: string, fraction?: number): void;
}
