/**
 * Isolated probe workspaces.
 *
 * A probe must start from exactly the state the user is in, but must not touch
 * the user's files. When the project is a Git repository we use a detached
 * worktree, apply the uncommitted working-tree diff, copy untracked files, and
 * commit that as a local baseline. The probe's own changes are then `git diff HEAD`.
 * Otherwise we fall back to a filtered copy plus a file-stat snapshot.
 */

import fs from "node:fs";
import path from "node:path";
import type { H2Config, TaskSpec } from "./types.ts";
import {
	ensureDir,
	isDir,
	isProbablyText,
	relPosix,
	rmrf,
	run,
	safeJoin,
	truncate,
	writeText,
} from "./util.ts";

export interface WorkspaceInfo {
	dir: string;
	git: boolean;
	worktree: boolean;
	repoRoot?: string;
	/** For the non-Git fallback: rel -> "size:mtimeMs" before the probe. */
	snapshot?: Record<string, string>;
}

const SKIP_DIRS = new Set([
	".git",
	".harness2",
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	"dist",
	"build",
	"target",
	".next",
	".cache",
	".turbo",
	"coverage",
]);

function findGitRoot(cwd: string): string | undefined {
	const r = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 20_000 });
	if (r.code !== 0) return undefined;
	const root = r.stdout.trim();
	return root || undefined;
}

function copyFiltered(src: string, dest: string): number {
	let count = 0;
	const walk = (from: string, to: string, depth: number) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(from, { withFileTypes: true });
		} catch {
			return;
		}
		ensureDir(to);
		for (const e of entries) {
			if (SKIP_DIRS.has(e.name)) continue;
			const a = path.join(from, e.name);
			const b = path.join(to, e.name);
			if (a === dest || dest.startsWith(`${a}${path.sep}`)) continue;
			if (e.isDirectory()) walk(a, b, depth + 1);
			else if (e.isFile()) {
				try {
					fs.copyFileSync(a, b);
					count++;
				} catch {
					/* ignore */
				}
			}
		}
	};
	walk(src, dest, 0);
	return count;
}

function statSnapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (SKIP_DIRS.has(e.name)) continue;
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) {
				try {
					const s = fs.statSync(p);
					out[relPosix(dir, p)] = `${s.size}:${Math.floor(s.mtimeMs)}`;
				} catch {
					/* ignore */
				}
			}
		}
	};
	walk(dir);
	return out;
}

export function createWorkspace(cwd: string, dest: string, cfg: H2Config): WorkspaceInfo {
	ensureDir(path.dirname(dest));
	rmrf(dest);
	const root = cfg.workspaceCopy ? undefined : findGitRoot(cwd);
	if (root && path.resolve(root) === path.resolve(cwd)) {
		const add = run("git", ["-C", cwd, "worktree", "add", "--detach", dest, "HEAD"], {
			timeoutMs: 120_000,
		});
		if (add.code === 0) {
			try {
				const diff = run("git", ["-C", cwd, "diff", "--binary", "HEAD"], {
					timeoutMs: 120_000,
				});
				if (diff.stdout.trim()) {
					const applied = run("git", ["-C", dest, "apply", "--whitespace=nowarn", "-"], {
						input: diff.stdout,
						timeoutMs: 120_000,
					});
					if (applied.code !== 0) throw new Error(`git apply failed: ${applied.stderr.slice(0, 300)}`);
				}
				const untracked = run(
					"git",
					["-C", cwd, "ls-files", "--others", "--exclude-standard", "-z"],
					{ timeoutMs: 120_000 },
				);
				for (const rel of untracked.stdout.split("\0")) {
					if (!rel || rel.startsWith(".harness2/")) continue;
					const src = path.join(cwd, rel);
					const dst = safeJoin(dest, rel);
					if (!fs.existsSync(src)) continue;
					ensureDir(path.dirname(dst));
					fs.copyFileSync(src, dst);
				}
				run("git", ["-C", dest, "add", "-A"], { timeoutMs: 120_000 });
				const commit = run(
					"git",
					[
						"-C",
						dest,
						"-c",
						"user.name=harness2",
						"-c",
						"user.email=harness2@localhost",
						"-c",
						"commit.gpgsign=false",
						"commit",
						"--allow-empty",
						"--no-verify",
						"-m",
						"harness2 baseline",
					],
					{ timeoutMs: 120_000 },
				);
				if (commit.code !== 0) {
					throw new Error(`git baseline commit failed: ${commit.stderr.slice(0, 300)}`);
				}
				return { dir: dest, git: true, worktree: true, repoRoot: root };
			} catch {
				run("git", ["-C", cwd, "worktree", "remove", "--force", dest], { timeoutMs: 60_000 });
				rmrf(dest);
			}
		} else {
			rmrf(dest);
		}
	}

	copyFiltered(cwd, dest);
	return { dir: dest, git: false, worktree: false, snapshot: statSnapshot(dest) };
}

export function removeWorkspace(ws: WorkspaceInfo): void {
	if (ws.worktree && ws.repoRoot) {
		run("git", ["-C", ws.repoRoot, "worktree", "remove", "--force", ws.dir], { timeoutMs: 60_000 });
	}
	rmrf(ws.dir);
}

export interface Deliverable {
	text: string;
	filesDir: string;
	changedFiles: string[];
	delivered: boolean;
}

const MAX_FILE_CHARS = 60_000;
const MAX_TOTAL_CHARS = 400_000;

function readMaybeText(file: string): string | undefined {
	try {
		const buf = fs.readFileSync(file);
		if (!isProbablyText(buf)) return undefined;
		return truncate(buf.toString("utf8"), MAX_FILE_CHARS);
	} catch {
		return undefined;
	}
}

function copyArtifact(ws: WorkspaceInfo, rel: string, filesDir: string): boolean {
	const src = safeJoin(ws.dir, rel);
	if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return false;
	const dst = safeJoin(filesDir, rel);
	ensureDir(path.dirname(dst));
	fs.copyFileSync(src, dst);
	return true;
}

export function extractDeliverable(
	ws: WorkspaceInfo,
	task: TaskSpec,
	destDir: string,
): Deliverable {
	const filesDir = path.join(destDir, "files");
	ensureDir(filesDir);
	const changed = new Set<string>();
	const sections: string[] = ["# What this rollout produced", ""];
	let total = 0;
	const push = (s: string) => {
		if (total >= MAX_TOTAL_CHARS) return;
		const room = MAX_TOTAL_CHARS - total;
		sections.push(truncate(s, room, "\n…[overall deliverable truncated]\n"));
		total += Math.min(s.length, room);
	};

	let declaredOk = false;
	if (task.deliverables.length) {
		push("## Declared artifacts\n");
		let present = 0;
		for (const rel of task.deliverables) {
			const ok = copyArtifact(ws, rel, filesDir);
			if (ok) {
				present++;
				changed.add(rel);
				const text = readMaybeText(safeJoin(ws.dir, rel));
				push(`### \`${rel}\`\n\n${text ?? "(binary artifact copied under `files/`)"}\n`);
			} else {
				push(`### \`${rel}\`\n\nMISSING — the task asked for this artifact and the rollout did not produce it.\n`);
			}
		}
		declaredOk = present === task.deliverables.length;
	}

	if (ws.git) {
		const diff = run("git", ["-C", ws.dir, "diff", "--binary", "HEAD"], { timeoutMs: 60_000 });
		const status = run("git", ["-C", ws.dir, "status", "--porcelain", "-z"], { timeoutMs: 30_000 });
		for (const entry of status.stdout.split("\0")) {
			if (!entry.trim()) continue;
			const rel = entry.slice(3).trim();
			if (rel) changed.add(rel);
		}
		if (diff.stdout.trim()) {
			push("## Workspace diff\n\n```diff\n" + truncate(diff.stdout, MAX_FILE_CHARS * 2) + "\n```\n");
		}
		const untracked = run(
			"git",
			["-C", ws.dir, "ls-files", "--others", "--exclude-standard", "-z"],
			{ timeoutMs: 30_000 },
		);
		for (const rel of untracked.stdout.split("\0")) {
			if (!rel) continue;
			changed.add(rel);
			copyArtifact(ws, rel, filesDir);
			const text = readMaybeText(safeJoin(ws.dir, rel));
			if (text !== undefined) push(`## Added: \`${rel}\`\n\n\`\`\`\n${text}\n\`\`\`\n`);
		}
	} else if (ws.snapshot) {
		const after = statSnapshot(ws.dir);
		const all = new Set([...Object.keys(ws.snapshot), ...Object.keys(after)]);
		const modified: string[] = [];
		const added: string[] = [];
		const deleted: string[] = [];
		for (const rel of all) {
			const before = ws.snapshot[rel];
			const now = after[rel];
			if (!before && now) added.push(rel);
			else if (before && !now) deleted.push(rel);
			else if (before !== now) modified.push(rel);
		}
		for (const rel of [...modified, ...added]) {
			changed.add(rel);
			copyArtifact(ws, rel, filesDir);
		}
		for (const rel of deleted) changed.add(rel);
		if (modified.length || added.length || deleted.length) {
			push("## Workspace changes\n");
			for (const rel of modified) {
				const text = readMaybeText(safeJoin(ws.dir, rel));
				push(`### Modified: \`${rel}\`\n\n\`\`\`\n${text ?? "(binary)"}\n\`\`\`\n`);
			}
			for (const rel of added) {
				const text = readMaybeText(safeJoin(ws.dir, rel));
				push(`### Added: \`${rel}\`\n\n\`\`\`\n${text ?? "(binary)"}\n\`\`\`\n`);
			}
			for (const rel of deleted) push(`### Deleted: \`${rel}\`\n`);
		}
	}

	if (!sections.some((s) => s.startsWith("## "))) {
		push("The rollout produced no workspace changes and no declared artifacts.\n");
	}
	const text = sections.join("\n");
	writeText(path.join(destDir, "deliverable.md"), text);
	return {
		text,
		filesDir,
		changedFiles: [...changed].sort(),
		delivered: task.deliverables.length ? declaredOk : changed.size > 0,
	};
}

export function copyTaskSource(sourceDir: string | undefined, dest: string): number {
	if (!sourceDir || !isDir(sourceDir)) return 0;
	let n = 0;
	const walk = (from: string, to: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(from, { withFileTypes: true });
		} catch {
			return;
		}
		ensureDir(to);
		for (const e of entries) {
			if (e.name === "__pycache__") continue;
			const a = path.join(from, e.name);
			const b = path.join(to, e.name);
			if (e.isDirectory()) walk(a, b);
			else if (e.isFile()) {
				fs.copyFileSync(a, b);
				n++;
			}
		}
	};
	walk(sourceDir, dest);
	return n;
}
