/**
 * The editable harness tree.
 *
 * This is the Pi port of `core/tree.py`. The surface is deliberately small and
 * allowlisted: anything else a proposer writes is dropped before it can run.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Tree } from "./types.ts";
import {
	asString,
	copyDir,
	ensureDir,
	exists,
	frontmatter,
	isDir,
	listFilesRecursive,
	readText,
	relPosix,
	safeJoin,
	writeText,
} from "./util.ts";

export const ALWAYS_ON_FILES = [
	"systemprompt.md",
	"guardrails.md",
	"LongTermMEMORY.md",
	"tool_descriptions/tool_guidance.md",
] as const;

export const RESERVED_SCRIPTS = new Set(["read_doc.py", "pack.py", "unpack.py"]);

const SKILL_RE = /^skills\/([a-z0-9][a-z0-9_-]*)\/SKILL\.md$/;
const SKILL_SCRIPT_RE = /^skills\/[a-z0-9][a-z0-9_-]*\/scripts\/[A-Za-z0-9_.-]+$/;
const AGENT_RE = /^agents\/([a-z0-9][a-z0-9_-]*)\.md$/;
const SCRIPT_RE = /^scripts\/[a-z0-9_][a-z0-9_]*\.py$/;
const PLUGIN_RE = /^plugins\/([a-z0-9][a-z0-9_-]*)\.ts$/;
const SCRIPT_REF_RE = /(?:python3?\s+)((?:skills\/[\w.-]+\/)?scripts\/[\w.-]+\.py)/g;

export function normalizeRel(rel: string): string {
	const r = String(rel).trim().replace(/\\/g, "/");
	if (r.startsWith("/") || r.split("/").includes("..")) {
		throw new Error(`path escapes the harness: ${rel}`);
	}
	return r.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

export function isAllowed(rel: string): boolean {
	let r: string;
	try {
		r = normalizeRel(rel);
	} catch {
		return false;
	}
	return (
		(ALWAYS_ON_FILES as readonly string[]).includes(r) ||
		SKILL_RE.test(r) ||
		SKILL_SCRIPT_RE.test(r) ||
		AGENT_RE.test(r) ||
		SCRIPT_RE.test(r) ||
		PLUGIN_RE.test(r)
	);
}

export function skillNames(tree: Tree): string[] {
	const names = new Set<string>();
	for (const rel of Object.keys(tree)) {
		const m = SKILL_RE.exec(rel);
		if (m) names.add(m[1]);
	}
	return [...names].sort();
}

export function agentNames(tree: Tree): string[] {
	const names = new Set<string>();
	for (const rel of Object.keys(tree)) {
		const m = AGENT_RE.exec(rel);
		if (m) names.add(m[1]);
	}
	return [...names].sort();
}

export function readTree(
	dir: string,
	rejected: string[] = [],
): Tree {
	const out: Tree = {};
	if (!isDir(dir)) return out;
	for (const file of listFilesRecursive(dir)) {
		const rel = relPosix(dir, file);
		if (rel.split("/").includes("__pycache__") || rel.endsWith(".pyc")) continue;
		if (!isAllowed(rel)) {
			rejected.push(rel);
			continue;
		}
		out[normalizeRel(rel)] = readText(file);
	}
	return out;
}

export function writeTree(tree: Tree, dest: string, opts: { stubs?: boolean } = {}): string {
	ensureDir(dest);
	// Remove only editable files; anything else in the destination is preserved.
	for (const file of listFilesRecursive(dest)) {
		const rel = relPosix(dest, file);
		if (isAllowed(rel) || (opts.stubs !== false && rel === "README.md")) rmFile(file);
	}
	for (const rel of ALWAYS_ON_FILES) {
		if (!(rel in tree) && !exists(path.join(dest, rel))) writeText(path.join(dest, rel), "");
	}
	for (const [rel, body] of Object.entries(tree)) {
		writeText(safeJoin(dest, normalizeRel(rel)), body);
	}
	return dest;
}

function rmFile(file: string): void {
	try {
		fs.unlinkSync(file);
	} catch {
		/* ignore */
	}
}

export function alwaysOnText(tree: Tree): string {
	return ALWAYS_ON_FILES.map((rel) => tree[rel] ?? "")
		.filter((s) => s.trim().length > 0)
		.join("\n\n")
		.trim();
}

export function autotrigger(tree: Tree, cap: number): string[] {
	const body = alwaysOnText(tree);
	const fixed: string[] = [];
	for (const name of skillNames(tree)) {
		if (body.includes(name)) continue;
		const src = tree[`skills/${name}/SKILL.md`] ?? "";
		const { frontmatter: fm } = frontmatter(src);
		const desc = asString(fm.description).trim().replace(/\.$/, "");
		const line = desc
			? `- When ${desc} applies, load the \`${name}\` skill.`
			: `- When the ${name} workflow applies, load the \`${name}\` skill.`;
		if (body.length + line.length + 2 > cap) continue;
		tree["guardrails.md"] = tree["guardrails.md"] ?? "";
		tree["guardrails.md"] = `${tree["guardrails.md"].trimEnd()}\n${line}`.trim();
		fixed.push(name);
	}
	return fixed;
}

export interface ValidateOptions {
	alwaysOnMax: number;
	allowAgents?: boolean;
	allowPlugins?: boolean;
	reservedScripts?: Set<string>;
	compilePython?: boolean;
}

export interface Census {
	alwaysOnChars: number;
	files: number;
	skills: number;
	agents: number;
	scripts: number;
	plugins: number;
	warnings: string[];
}

function pyCompiles(rel: string, src: string, warnings: string[]): string | undefined {
	const p = spawnSync(
		process.env.HARNESS2_PYTHON ?? "python3",
		["-c", "import ast,sys; ast.parse(sys.stdin.read())"],
		{ input: src, encoding: "utf8", timeout: 10_000 },
	);
	if (p.error) {
		warnings.push(`could not run python3 to compile-check ${rel}`);
		return undefined;
	}
	if (p.status !== 0) {
		const detail = (p.stderr || p.stdout || "").trim().split("\n").pop() ?? "syntax error";
		return `${rel} does not compile: ${detail.slice(0, 180)}`;
	}
	return undefined;
}

/**
 * Validate a tree. Throws one Error listing every problem; the message is fed
 * back to the proposer verbatim as retry feedback.
 */
export function validate(tree: Tree, opts: ValidateOptions): Census {
	const errs: string[] = [];
	const warnings: string[] = [];
	const cap = opts.alwaysOnMax;
	const body = alwaysOnText(tree);

	if (!Object.keys(tree).length) {
		errs.push("the harness tree is empty — edit the files in `context/harness/` in place");
	}
	if (!body.trim()) {
		errs.push(
			"always-on content is empty; systemprompt.md/guardrails.md/LongTermMEMORY.md/tool_descriptions/tool_guidance.md must contain some standing instruction",
		);
	}
	if (body.length > cap) {
		errs.push(
			`always-on content is ${body.length.toLocaleString()} chars, over the ${cap.toLocaleString()} cap; always-on text is paid for on every model call, so cut something before adding`,
		);
	}

	// Off-surface files are rejected by readTree, but a hand-edited tree can still
	// contain one; name it rather than silently dropping it.
	for (const rel of Object.keys(tree)) {
		if (!isAllowed(rel)) errs.push(`${rel} is off the editable surface and was not applied`);
	}

	const skills = skillNames(tree);
	for (const name of skills) {
		const rel = `skills/${name}/SKILL.md`;
		const src = tree[rel] ?? "";
		const { frontmatter: fm, body: skillBody } = frontmatter(src);
		if (!asString(fm.description).trim()) {
			errs.push(`${rel} needs a \`description:\` in its frontmatter, or Pi drops the skill silently`);
		}
		const declared = asString(fm.name).trim();
		if (declared !== name) {
			errs.push(
				`${rel} frontmatter \`name: ${declared || "(missing)"}\` must be \`name: ${name}\` to match its directory; a mismatch is dropped silently at load`,
			);
		}
		if (!skillBody.trim()) errs.push(`${rel} has no instructions after its frontmatter`);
		if (!body.includes(name)) {
			errs.push(
				`skill '${name}' is never named in always-on text, so the agent will not know to invoke it — an untriggered skill is dead weight. Add a line naming it to systemprompt.md or guardrails.md`,
			);
		}
	}

	const scripts = Object.keys(tree).filter((rel) => SCRIPT_RE.test(rel));
	if (opts.compilePython !== false) {
		for (const rel of Object.keys(tree)) {
			if (!rel.endsWith(".py")) continue;
			if (!SCRIPT_RE.test(rel) && !SKILL_SCRIPT_RE.test(rel)) continue;
			const bad = pyCompiles(rel, tree[rel], warnings);
			if (bad) errs.push(bad);
		}
	}
	for (const rel of scripts) {
		const base = rel.split("/").pop() ?? rel;
		if ((opts.reservedScripts ?? RESERVED_SCRIPTS).has(base)) {
			errs.push(`${rel} uses a reserved script name`);
		}
	}

	const haveScripts = new Set(
		Object.keys(tree).filter((rel) => SCRIPT_RE.test(rel) || SKILL_SCRIPT_RE.test(rel)),
	);
	for (const [rel, src] of Object.entries(tree)) {
		if (!/^skills\/[^/]+\/SKILL\.md$/.test(rel) && !(ALWAYS_ON_FILES as readonly string[]).includes(rel)) {
			continue;
		}
		for (const m of src.matchAll(SCRIPT_REF_RE)) {
			const ref = m[1];
			if ((opts.reservedScripts ?? RESERVED_SCRIPTS).has(ref.split("/").pop() ?? "")) continue;
			if (!haveScripts.has(ref)) errs.push(`${rel} invokes \`${ref}\` but that file is not in the harness`);
		}
	}

	const agents = agentNames(tree);
	if (agents.length && opts.allowAgents === false) {
		errs.push(`subagents are disabled for this run: ${agents.join(", ")}`);
	}
	for (const name of agents) {
		const rel = `agents/${name}.md`;
		const { frontmatter: fm, body: agentBody } = frontmatter(tree[rel] ?? "");
		if (!asString(fm.description).trim()) errs.push(`${rel} needs a \`description:\``);
		if (!agentBody.trim()) errs.push(`${rel} has no system prompt after its frontmatter`);
	}

	const plugins = Object.keys(tree).filter((rel) => PLUGIN_RE.test(rel));
	if (plugins.length && opts.allowPlugins === false) {
		errs.push(`plugins are disabled for this run: ${plugins.join(", ")}`);
	}
	for (const rel of Object.keys(tree)) {
		if (rel.startsWith("plugins/") && !PLUGIN_RE.test(rel)) {
			errs.push(`${rel} is not a valid plugin path; use plugins/<name>.ts`);
		}
		if (PLUGIN_RE.test(rel) && !(tree[rel] ?? "").trim()) errs.push(`${rel} is empty`);
	}

	if (errs.length) throw new Error(errs.join(" | "));
	return {
		alwaysOnChars: body.length,
		files: Object.keys(tree).length,
		skills: skills.length,
		agents: agents.length,
		scripts: scripts.length,
		plugins: plugins.length,
		warnings,
	};
}

export interface TreeDiff {
	added: string[];
	removed: string[];
	modified: string[];
	alwaysOnCharDelta: number;
}

export function diffSummary(before: Tree, after: Tree): TreeDiff {
	const added = Object.keys(after).filter((rel) => !(rel in before)).sort();
	const removed = Object.keys(before).filter((rel) => !(rel in after)).sort();
	const modified = Object.keys(before)
		.filter((rel) => rel in after && before[rel] !== after[rel])
		.sort();
	return {
		added,
		removed,
		modified,
		alwaysOnCharDelta: alwaysOnText(after).length - alwaysOnText(before).length,
	};
}

export function isUnchanged(before: Tree, after: Tree): boolean {
	const d = diffSummary(before, after);
	return !d.added.length && !d.removed.length && !d.modified.length;
}

export function diversity(trees: Record<string, Tree>): {
	n: number;
	nDistinct: number;
	meanLineJaccard: number;
} {
	const names = Object.keys(trees).sort();
	if (names.length < 2) return { n: names.length, nDistinct: names.length, meanLineJaccard: 1 };
	const lines = (t: Tree) => {
		const s = new Set<string>();
		for (const [rel, body] of Object.entries(t)) {
			for (const line of body.split("\n")) if (line.trim()) s.add(`${rel}:${line}`);
		}
		return s;
	};
	const sets = new Map(names.map((n) => [n, lines(trees[n])]));
	let sum = 0;
	let count = 0;
	for (let i = 0; i < names.length; i++) {
		for (let j = i + 1; j < names.length; j++) {
			const a = sets.get(names[i])!;
			const b = sets.get(names[j])!;
			const union = new Set([...a, ...b]);
			sum += union.size ? [...a].filter((x) => b.has(x)).length / union.size : 1;
			count++;
		}
	}
	const distinct = new Set(names.map((n) => JSON.stringify(Object.entries(trees[n]).sort()))).size;
	return {
		n: names.length,
		nDistinct: distinct,
		meanLineJaccard: count ? Math.round((sum / count) * 10000) / 10000 : 1,
	};
}

export function inventory(tree: Tree): string {
	const on = alwaysOnText(tree).length;
	const bits: string[] = [];
	const sk = skillNames(tree).length;
	const ag = agentNames(tree).length;
	const sc = Object.keys(tree).filter((r) => SCRIPT_RE.test(r)).length;
	const pl = Object.keys(tree).filter((r) => PLUGIN_RE.test(r)).length;
	if (sk) bits.push(`${sk} skill${sk === 1 ? "" : "s"}`);
	if (ag) bits.push(`${ag} agent${ag === 1 ? "" : "s"}`);
	if (sc) bits.push(`${sc} script${sc === 1 ? "" : "s"}`);
	if (pl) bits.push(`${pl} plugin${pl === 1 ? "" : "s"}`);
	if (!bits.length) bits.push("always-on edits only");
	return `${bits.join(", ")}; ${on.toLocaleString()} always-on chars`;
}

/**
 * The base harness: an explicit `.harness2/base/` tree when present, otherwise
 * the project's current Pi context, and finally a minimal seed.
 */
export function baseHarness(cwd: string, home: string): Tree {
	const explicit = path.join(home, "base");
	if (isDir(explicit)) {
		const tree = readTree(explicit);
		if (Object.keys(tree).length) return tree;
	}

	const tree: Tree = {};
	const parts: string[] = [];
	const globalAgents = path.join(getAgentDir(), "AGENTS.md");
	if (exists(globalAgents)) {
		const body = readText(globalAgents).trim();
		if (body) parts.push(`<!-- from ${globalAgents} -->\n${body}`);
	}
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const file = path.join(cwd, name);
		if (!exists(file)) continue;
		const body = readText(file).trim();
		if (body) parts.push(`<!-- from ${name} -->\n${body}`);
	}
	if (parts.length) tree["systemprompt.md"] = parts.join("\n\n");

	// Carry the project's existing on-demand components into the base harness.
	for (const rel of [".pi/skills", ".agents/skills"]) {
		const src = path.join(cwd, rel);
		if (!isDir(src)) continue;
		const tmp: Tree = {};
		const rejected: string[] = [];
		for (const skillDir of fs.readdirSync(src, { withFileTypes: true })) {
			if (!skillDir.isDirectory()) continue;
			const s = path.join(src, skillDir.name);
			const local: Tree = {};
			for (const file of listFilesRecursive(s)) {
				const r = relPosix(s, file);
				if (r === "SKILL.md" || /^scripts\/[A-Za-z0-9_.-]+$/.test(r)) {
					local[`skills/${skillDir.name}/${r}`] = readText(file);
				}
			}
			Object.assign(tmp, local);
		}
		for (const [relKey, body] of Object.entries(tmp)) {
			if (isAllowed(relKey)) tree[relKey] = body;
			else rejected.push(relKey);
		}
	}
	for (const rel of [".pi/agents", ".agents/agents"]) {
		const src = path.join(cwd, rel);
		if (!isDir(src)) continue;
		for (const name of fs.readdirSync(src)) {
			if (!name.endsWith(".md")) continue;
			const body = readText(path.join(src, name));
			const { frontmatter: fm } = frontmatter(body);
			const agentName = asString(fm.name).trim() || name.replace(/\.md$/, "");
			if (!/^[a-z0-9][a-z0-9_-]*$/.test(agentName)) continue;
			if (!asString(fm.description).trim()) continue;
			tree[`agents/${agentName}.md`] = body;
		}
	}

	if (!tree["systemprompt.md"]?.trim()) {
		tree["systemprompt.md"] =
			"# ROLE\n\nYou are an autonomous agent working directly in the workspace. Complete the task you are given; do not stop at a plan.";
	}
	if (!tree["guardrails.md"]?.trim()) {
		tree["guardrails.md"] =
			"- Work to completion, verify the result, and leave the workspace in a usable state.\n";
	}
	for (const rel of ALWAYS_ON_FILES) tree[rel] = tree[rel] ?? "";
	return tree;
}

export function copyTreeTo(srcDir: string, destDir: string): number {
	return copyDir(srcDir, destDir);
}
