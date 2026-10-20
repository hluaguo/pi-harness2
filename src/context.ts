/**
 * Evidence trees handed to editors and selectors.
 *
 * Port of `core/context.py`: the mission points at `context/`; the layout in the
 * mission mentions only what actually landed on disk. Trajectories are written
 * in full; observation truncation happened earlier, when they were rendered.
 */

import fs from "node:fs";
import path from "node:path";
import type { RunView, TaskSpec, Tree } from "./types.ts";
import { unifiedDiff } from "./diff.ts";
import { writeTree, alwaysOnText } from "./tree.ts";
import { copyTaskSource } from "./workspace.ts";
import {
	copyDir,
	ensureDir,
	isDir,
	listFilesRecursive,
	readText,
	relPosix,
	rmrf,
	safeJoin,
	writeText,
} from "./util.ts";

export interface PoolEntry {
	label: string;
	harnessDir: string;
	run?: RunView;
}

export interface ContextTree {
	root: string;
	taskId: string;
	rollouts: string[];
	deliverables: string[];
	harnessFiles: number;
	library: boolean;
	pool: string[];
	failed: string[];
	sourceFiles: number;
	decisions: number;
	layout: string;
}

interface BuildOptions {
	task: TaskSpec;
	harness: Tree;
	rollouts: RunView[];
	pool?: PoolEntry[];
	libraryDir?: string;
	decisions?: Record<string, string>;
	dest: string;
}

function copyDeliverable(run: RunView, dest: string): boolean {
	if (!isDir(run.deliverableDir)) {
		writeText(path.join(dest, "INDEX.md"), "# No deliverable\n\nThis rollout produced no deliverable.\n");
		return false;
	}
	const files = listFilesRecursive(run.deliverableDir);
	if (!files.length) return false;
	ensureDir(dest);
	for (const file of files) {
		const rel = relPosix(run.deliverableDir, file);
		const target = safeJoin(dest, rel);
		ensureDir(path.dirname(target));
		fs.copyFileSync(file, target);
	}
	return true;
}

function layoutOf(tree: Omit<ContextTree, "layout">): string {
	const lines = ["context/task.md                  the task as the agent received it"];
	if (tree.sourceFiles) lines.push("context/source/                 task source materials");
	if (tree.decisions) lines.push("context/decisions/              earlier edits and composition decisions");
	if (tree.rollouts.length) {
		const names = tree.rollouts.slice(0, 6).map((r) => `${r}.md`);
		const more = tree.rollouts.length > 6 ? ` (+${tree.rollouts.length - 6} more)` : "";
		lines.push(`context/rollouts/               FULL trajectories: ${names.join(", ")}${more}`);
	}
	if (tree.deliverables.length) {
		lines.push(
			"context/deliverables/<label>/    the files each rollout produced (browse INDEX.md for the set)",
		);
	}
	if (tree.harnessFiles) {
		lines.push(
			`context/harness/                the harness you are editing (${tree.harnessFiles} files)`,
		);
	}
	if (tree.pool.length) {
		lines.push(
			`context/pool/                   ${tree.pool.length} candidates, each with its harness, diff, rollout and product`,
		);
	}
	if (tree.library) {
		lines.push(
			"context/library/                earlier tasks in this area — browse INDEX.md first, then open what looks relevant",
		);
	}
	return lines.join("\n");
}

export function buildContext(opts: BuildOptions): ContextTree {
	const { task, harness, rollouts, pool = [], decisions = {}, dest } = opts;
	rmrf(dest);
	ensureDir(dest);
	writeText(path.join(dest, "task.md"), `${task.prompt.trim()}\n`);
	const sourceFiles = copyTaskSource(task.sourceDir, path.join(dest, "source"));
	writeTree(harness, path.join(dest, "harness"));

	for (const [label, notes] of Object.entries(decisions)) {
		writeText(path.join(dest, "decisions", `${label}.md`), notes || "No decision notes returned.");
	}

	const gotRollouts: string[] = [];
	const gotDeliverables: string[] = [];
	const failed: string[] = [];
	if (rollouts.length) ensureDir(path.join(dest, "rollouts"));
	for (const run of rollouts) {
		const traj = readText(run.trajectoryPath, "");
		if (traj.trim()) {
			writeText(path.join(dest, "rollouts", `${run.label}.md`), traj);
			gotRollouts.push(run.label);
		} else {
			writeText(
				path.join(dest, "rollouts", `${run.label}.md`),
				`(trajectory unavailable: ${run.error || "no trajectory written"})`,
			);
			failed.push(run.label);
		}
		const ddir = path.join(dest, "deliverables", run.label);
		copyDeliverable(run, ddir);
		gotDeliverables.push(run.label);
	}

	const gotPool: string[] = [];
	for (const entry of pool) {
		const d = path.join(dest, "pool", entry.label);
		ensureDir(d);
		if (isDir(entry.harnessDir)) {
			copyDir(entry.harnessDir, path.join(d, "harness"));
			const cand = readTreeForDiff(entry.harnessDir);
			const diff = Object.keys({ ...harness, ...cand })
				.sort()
				.map((rel) =>
					unifiedDiff(
						harness[rel] ?? "",
						cand[rel] ?? "",
						`current/${rel}`,
						`${entry.label}/${rel}`,
					),
				)
				.filter(Boolean)
				.join("\n");
			writeText(path.join(d, "harness.diff"), diff || "(no changes)\n");
		}
		if (entry.run) {
			const traj = readText(entry.run.trajectoryPath, "");
			writeText(path.join(d, "rollout.md"), traj || "(unavailable)");
			const produced = readText(entry.run.deliverableTextPath, "(nothing produced)");
			writeText(path.join(d, "produced.md"), produced);
		}
		gotPool.push(entry.label);
	}

	let library = false;
	if (opts.libraryDir && isDir(opts.libraryDir) && fs.readdirSync(opts.libraryDir).length) {
		copyDir(opts.libraryDir, path.join(dest, "library"));
		library = true;
	}

	const partial = {
		root: dest,
		taskId: task.id,
		rollouts: gotRollouts,
		deliverables: gotDeliverables,
		harnessFiles: Object.keys(harness).length,
		library,
		pool: gotPool,
		failed,
		sourceFiles,
		decisions: Object.keys(decisions).length,
	};
	assertNoLeaks(dest, task.leakGlobs);
	if (rollouts.length && !gotRollouts.length) {
		throw new Error(
			`no trajectory could be rendered for ANY rollout — the editor would be adapting on nothing: ${failed.join(", ")}`,
		);
	}
	return { ...partial, layout: layoutOf(partial) };
}

function readTreeForDiff(dir: string): Tree {
	const out: Tree = {};
	for (const file of listFilesRecursive(dir)) {
		const rel = relPosix(dir, file);
		if (
			rel.startsWith("skills/") ||
			rel.startsWith("agents/") ||
			rel.startsWith("scripts/") ||
			rel.startsWith("plugins/") ||
			[
				"systemprompt.md",
				"guardrails.md",
				"LongTermMEMORY.md",
				"tool_descriptions/tool_guidance.md",
			].includes(rel)
		) {
			out[rel] = readText(file);
		}
	}
	return out;
}

export interface SelectionPoolEntry {
	id: string;
	label: string;
	text: string;
}

export function buildSelectionContext(
	dest: string,
	task: TaskSpec,
	candidates: Array<{ id: string; label: string; text: string }>,
): SelectionPoolEntry[] {
	rmrf(dest);
	ensureDir(path.join(dest, "candidates"));
	writeText(path.join(dest, "task.md"), `${task.prompt.trim()}\n`);
	copyTaskSource(task.sourceDir, path.join(dest, "source"));
	for (const c of candidates) {
		writeText(path.join(dest, "candidates", `${c.id}.md`), c.text || "(no deliverable produced)");
	}
	assertNoLeaks(dest, task.leakGlobs);
	return candidates.map((c) => ({ id: c.id, label: c.label, text: c.text }));
}

export function libraryContextDir(libraryDir: string | undefined): string | undefined {
	if (!libraryDir || !isDir(libraryDir)) return undefined;
	const hasExperience = listFilesRecursive(libraryDir).some((f) => f.endsWith("EXPERIENCE.md"));
	return hasExperience ? libraryDir : undefined;
}

export function harnessIndex(harness: Tree): string {
	const on = alwaysOnText(harness).length;
	const skills = Object.keys(harness).filter((r) => r.endsWith("/SKILL.md")).length;
	const agents = Object.keys(harness).filter((r) => /^agents\/.+\.md$/.test(r)).length;
	const scripts = Object.keys(harness).filter((r) => r.endsWith(".py")).length;
	const plugins = Object.keys(harness).filter((r) => r.startsWith("plugins/")).length;
	return `always-on ${on.toLocaleString()} chars; ${skills} skills; ${agents} agents; ${scripts} scripts; ${plugins} plugins`;
}

/* ------------------------------------------------------------------ */
/* Leak tripwires                                                      */
/* ------------------------------------------------------------------ */

export const GRADER_VERDICT_MARKERS = [
	"deterministic_eval_summary",
	"deterministic_eval_result",
	"judge_scope_and_deterministic_status",
	"Judge findings on the rendered result",
	'"passed_count"',
	'"pass_rate"',
	'"test_pass_rate"',
];

const SCAN_SUFFIXES = new Set([
	".md",
	".txt",
	".json",
	".csv",
	".tsv",
	".yaml",
	".yml",
	".html",
	".htm",
	".log",
	".py",
	".js",
	".sh",
	".xml",
	".ini",
	".toml",
	".patch",
	".diff",
	"",
]);

function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/\\/g, "/")
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

export function assertNoLeaks(root: string, leakGlobs: string[]): void {
	if (!isDir(root)) return;
	const globs = leakGlobs.map((g) => globToRegExp(g.replace(/^\.?\//, "")));
	const hit: string[] = [];
	for (const file of listFilesRecursive(root)) {
		const rel = relPosix(root, file);
		if (rel === "source" || rel.startsWith("source/")) {
			for (const g of globs) {
				if (g.test(rel.replace(/^source\//, "")) || g.test(rel)) {
					hit.push(rel);
					break;
				}
			}
		}
		if (hit.length) break;
	}
	if (hit.length) {
		throw new Error(
			`answer-key path(s) would enter model context: ${hit.slice(0, 8).join(", ")}`,
		);
	}
	if (/^(0|false|no|off)$/i.test(process.env.HARNESS2_LEAK_MARKERS ?? "")) return;
	for (const file of listFilesRecursive(root)) {
		const rel = relPosix(root, file);
		for (const marker of GRADER_VERDICT_MARKERS) {
			if (rel.includes(marker)) {
				throw new Error(
					`grader verdict would enter model context: ${rel} matched marker ${JSON.stringify(marker)} in its NAME. This is a leak, not a false positive to widen around.`,
				);
			}
		}
		if (!SCAN_SUFFIXES.has(path.extname(file).toLowerCase())) continue;
		let body: string;
		try {
			body = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const marker of GRADER_VERDICT_MARKERS) {
			const at = body.indexOf(marker);
			if (at >= 0) {
				throw new Error(
					`grader verdict would enter model context: ${rel} contains ${JSON.stringify(marker)} at offset ${at}. This is a leak, not a false positive to widen around.`,
				);
			}
		}
	}
}
