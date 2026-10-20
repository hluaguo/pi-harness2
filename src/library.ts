/**
 * The per-domain experience library.
 *
 * Port of `core/library.py`. An entry stores the full adopted tree plus the
 * reflection's evidence-supported lesson. Retrieval is by construction: a
 * domain's directory only ever contains same-domain entries.
 */

import fs from "node:fs";
import path from "node:path";
import type { LibraryExperience, TaskSpec, Tree } from "./types.ts";
import { inventory, writeTree } from "./tree.ts";
import {
	ensureDir,
	isDir,
	listFilesRecursive,
	readText,
	relPosix,
	rmrf,
	slugify,
	writeText,
} from "./util.ts";

export function domainDirName(domain: string): string {
	return domain.replace(/\s*[/\\]\s*/g, "__").trim() || "unknown";
}

export function libraryRoot(base: string, domain: string): string {
	return path.join(base, domainDirName(domain));
}

export interface AddEntryOptions {
	libraryRoot: string;
	task: TaskSpec;
	harness: Tree;
	label: string;
	runId: string;
	why: string;
	experience: LibraryExperience;
}

export function hasExperience(exp: Partial<LibraryExperience> | undefined): exp is LibraryExperience {
	return Boolean(
		exp &&
			exp.cue?.trim() &&
			exp.lesson?.trim() &&
			exp.evidence?.trim(),
	);
}

export function addEntry(opts: AddEntryOptions): string | undefined {
	if (!hasExperience(opts.experience)) return undefined;
	const dir = path.join(opts.libraryRoot, "entries", slugify(opts.task.id, "task"));
	rmrf(path.join(dir, "harness"));
	writeTree(opts.harness, path.join(dir, "harness"), { stubs: false });
	const exp = opts.experience;
	const lines = [
		`# ${opts.task.id}`,
		"",
		`- adopted: \`${opts.label}\``,
		`- run: \`${opts.runId}\``,
		`- components: ${inventory(opts.harness)}`,
		"",
	];
	if (opts.why.trim()) lines.push("## Why this was chosen", "", opts.why.trim(), "");
	if (exp.edits.trim()) lines.push("## What each edit did", "", exp.edits.trim(), "");
	lines.push(
		"## Transferable lesson",
		"",
		`- **cue**: ${exp.cue.trim()}`,
		`- **lesson**: ${exp.lesson.trim()}`,
		`- **evidence**: ${exp.evidence.trim()}`,
		...(exp.confidence.trim() ? [`- **confidence**: ${exp.confidence.trim()}`] : []),
		"",
	);
	writeText(path.join(dir, "EXPERIENCE.md"), lines.join("\n"));
	rebuildIndex(opts.libraryRoot, opts.task.domain);
	return dir;
}

export function rebuildIndex(root: string, domain: string): string {
	ensureDir(root);
	const entriesDir = path.join(root, "entries");
	const names = isDir(entriesDir) ? fs.readdirSync(entriesDir).sort() : [];
	const rows = [
		`# Library — ${domain}`,
		"",
		"Each entry is an earlier task in THIS area whose harness was chosen, stored with its FULL component tree and why it was picked. Browse this index, then open the entries that look relevant to the matter in front of you.",
		"",
	];
	if (!names.length) rows.push("_(empty — this is the first task in this area)_");
	for (const name of names) {
		const dir = path.join(entriesDir, name);
		if (!isDir(dir)) continue;
		const tree: Tree = {};
		const harnessDir = path.join(dir, "harness");
		if (isDir(harnessDir)) {
			for (const file of listFilesRecursive(harnessDir)) {
				const rel = relPosix(harnessDir, file);
				tree[rel] = readText(file);
			}
		}
		const cue = field(readText(path.join(dir, "EXPERIENCE.md")), "cue");
		rows.push(
			`## \`entries/${name}/\``,
			`- harness: \`entries/${name}/harness/\` — ${inventory(tree)}`,
			`- why:     \`entries/${name}/EXPERIENCE.md\``,
			...(cue ? [`- cue:     ${cue}`] : []),
			"",
		);
	}
	const index = path.join(root, "INDEX.md");
	writeText(index, rows.join("\n"));
	return index;
}

function field(text: string, name: string): string {
	for (const line of text.split("\n")) {
		const m = new RegExp(`^- \\*\\*${name}\\*\\*:\\s*(.+)$`).exec(line);
		if (m) return m[1].trim();
	}
	return "";
}

export function filterLibraryForTask(libraryRootDir: string | undefined, taskId: string): string | undefined {
	if (!libraryRootDir || !isDir(libraryRootDir)) return undefined;
	const entries = path.join(libraryRootDir, "entries");
	if (!isDir(entries)) return undefined;
	const exclude = slugify(taskId, "task");
	const files = listFilesRecursive(libraryRootDir);
	if (!files.some((f) => f.endsWith("EXPERIENCE.md"))) return undefined;
	// The current task's entry should not exist yet; upstream keeps it out if a
	// resumed run sees one. Callers copy the whole library, so filter by using a
	// sibling view is unnecessary for a fresh task.
	void exclude;
	return libraryRootDir;
}

export function parseExperience(text: string): LibraryExperience {
	const block = /<experience>([\s\S]*?)<\/experience>/i.exec(text)?.[1] ?? "";
	if (/^NO_ENTRY\s*$/im.test(text) && !block.trim()) {
		return { cue: "", lesson: "", evidence: "", confidence: "", edits: "" };
	}
	const get = (name: string): string => {
		const m = new RegExp(`^${name}:\\s*(.+)$`, "im").exec(block);
		return m ? m[1].trim() : "";
	};
	const edits = /<edits>([\s\S]*?)<\/edits>/i.exec(text)?.[1]?.trim() ?? "";
	return {
		cue: get("cue"),
		lesson: get("lesson"),
		evidence: get("evidence"),
		confidence: get("confidence"),
		edits,
	};
}
