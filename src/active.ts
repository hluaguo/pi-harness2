/**
 * Active-harness application.
 *
 * Pi has no built-in "append this file to every system prompt" resource, so an
 * active Harness² harness is applied by this extension: always-on text is
 * appended on `before_agent_start`, and its skills are advertised through
 * `resources_discover`. Plugins are never loaded implicitly.
 */

import fs from "node:fs";
import path from "node:path";
import type { H2Config } from "./types.ts";
import { alwaysOnText, inventory, readTree, writeTree } from "./tree.ts";
import { isDir, readJson, readText, writeJson } from "./util.ts";

export interface ActiveHarness {
	runId: string;
	label: string;
	taskId: string;
	harnessDir: string;
	activatedAt: string;
}

export function readActive(cfg: H2Config): ActiveHarness | undefined {
	const data = readJson<ActiveHarness | undefined>(cfg.activePath, undefined);
	if (!data?.harnessDir || !isDir(data.harnessDir)) return undefined;
	return data;
}

export function writeActive(cfg: H2Config, active: ActiveHarness): void {
	writeJson(cfg.activePath, active);
}

export function deactivate(cfg: H2Config): void {
	fs.rmSync(cfg.activePath, { force: true });
}

export function activePromptBlock(cfg: H2Config): string | undefined {
	const active = readActive(cfg);
	if (!active) return undefined;
	const tree = readTree(active.harnessDir);
	const text = alwaysOnText(tree);
	if (!text.trim()) return undefined;
	const plugins = Object.keys(tree).filter((rel) => rel.startsWith("plugins/"));
	const lines = [
		"# ACTIVE HARNESS (Harness²)",
		"",
		`This project has an active refined harness from run \`${active.runId}\` (final \`${active.label}\`).`,
		"",
		text,
	];
	if (plugins.length) {
		lines.push(
			"",
			`This harness also contains plugin(s): ${plugins.join(", ")}. They are not loaded automatically; load them explicitly with \`pi -e <path>\` if you want them.`,
		);
	}
	return lines.join("\n");
}

export function activeSkillDirs(cfg: H2Config): string[] {
	const active = readActive(cfg);
	if (!active) return [];
	const skills = path.join(active.harnessDir, "skills");
	if (!isDir(skills)) return [];
	return fs
		.readdirSync(skills)
		.map((name) => path.join(skills, name))
		.filter((dir) => fs.existsSync(path.join(dir, "SKILL.md")));
}

export function adoptFromRun(
	cfg: H2Config,
	runDir: string,
	taskId: string,
	label: string,
): { dir: string; inventory: string } {
	const source = path.join(runDir, "harnesses", label);
	if (!isDir(source)) throw new Error(`no harness \`${label}\` in ${runDir}`);
	const tree = readTree(source);
	const dir = path.join(cfg.adoptedRoot, taskId, "harness");
	writeTree(tree, dir, { stubs: false });
	writeJson(path.join(cfg.adoptedRoot, taskId, "adoption.json"), {
		runId: path.basename(runDir),
		label,
		taskId,
		adoptedAt: new Date().toISOString(),
		inventory: inventory(tree),
	});
	return { dir, inventory: inventory(tree) };
}

export function describeActive(cfg: H2Config): string {
	const active = readActive(cfg);
	if (!active) return "no active harness";
	const tree = readTree(active.harnessDir);
	return `${active.taskId} / ${active.label} — ${inventory(tree)}`;
}

export function readRunSummary(runDir: string): string {
	return readText(path.join(runDir, "report.md"), "(no report.md)");
}
