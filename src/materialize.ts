/**
 * Materialize an adopted harness as a native Pi package.
 *
 * The package contains a generated always-on extension, the harness's skills,
 * agents (with a self-contained subagent extension), scripts, and plugins.
 * It is loaded with `pi install <dir>` and removed with `pi remove <dir>`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { H2Config, TaskSpec, Tree } from "./types.ts";
import { alwaysOnText, agentNames, inventory, skillNames } from "./tree.ts";
import {
	ensureDir,
	relPosix,
	rmrf,
	safeJoin,
	slugify,
	writeJson,
	writeText,
} from "./util.ts";

export interface ExportResult {
	dir: string;
	packageName: string;
	installCommand: string;
	files: string[];
}

export interface ExportOptions {
	cfg: H2Config;
	task: TaskSpec;
	tree: Tree;
	runId: string;
	label: string;
	outDir?: string;
	force?: boolean;
}

const TEMPLATE_DIR = path.dirname(fileURLToPath(import.meta.url));

function pluginFiles(tree: Tree): Array<{ name: string; dest: string }> {
	return Object.keys(tree)
		.filter((rel) => /^plugins\/[a-z0-9][a-z0-9_-]*\.ts$/.test(rel))
		.sort()
		.map((rel) => {
			const name = path.basename(rel, ".ts");
			return { name, dest: `extensions/plugin-${name}.ts` };
		});
}

export function exportHarness(opts: ExportOptions): ExportResult {
	const { cfg, task, tree, runId, label } = opts;
	if (!Object.keys(tree).length) throw new Error("cannot export an empty harness");
	const packageName = `pi-harness2-${slugify(task.id, "task")}`;
	const defaultDir = path.join(
		cfg.home,
		"exports",
		`${slugify(task.id, "task")}-${slugify(runId, "run")}`,
	);
	const dir = opts.outDir ? path.resolve(cfg.cwd, opts.outDir) : defaultDir;
	if (fs.existsSync(dir)) {
		if (!opts.force) throw new Error(`${dir} already exists; pass --force to replace it`);
		rmrf(dir);
	}
	ensureDir(dir);
	const files: string[] = [];
	const put = (rel: string, body: string) => {
		writeText(safeJoin(dir, rel), body);
		files.push(rel);
	};

	// Full tree, kept for audit and for scripts referenced by absolute path.
	for (const [rel, body] of Object.entries(tree).sort(([a], [b]) => a.localeCompare(b))) {
		put(`harness/${rel}`, body);
	}

	const alwaysOn = alwaysOnText(tree);
	put("always-on.md", `${alwaysOn}\n`);

	for (const rel of Object.keys(tree).filter((key) => key.startsWith("skills/")).sort()) {
		put(rel, tree[rel]);
	}
	for (const rel of Object.keys(tree).filter((key) => key.startsWith("agents/")).sort()) {
		put(rel, tree[rel]);
	}
	for (const rel of Object.keys(tree).filter((key) => /^scripts\//.test(key)).sort()) {
		put(rel, tree[rel]);
	}
	const plugins = pluginFiles(tree);
	for (const plugin of plugins) put(plugin.dest, tree[`plugins/${plugin.name}.ts`]);

	// Generated extensions.
	put("extensions/harness2-context.ts", readTemplate("context.ts"));
	const hasAgents = agentNames(tree).length > 0;
	if (hasAgents) put("extensions/harness2-subagent.ts", readTemplate("subagent.ts"));

	const extensions = ["./extensions/harness2-context.ts", ...plugins.map((p) => `./${p.dest}`)];
	if (hasAgents) extensions.push("./extensions/harness2-subagent.ts");
	const pkg: Record<string, unknown> = {
		name: packageName,
		version: "0.1.0",
		private: true,
		type: "module",
		description: `Harness² export for ${task.id} (${label})`,
		pi: {
			extensions,
			...(skillNames(tree).length ? { skills: ["./skills"] } : {}),
		},
		peerDependencies: {
			"@earendil-works/pi-ai": "*",
			"@earendil-works/pi-coding-agent": "*",
		},
	};
	put("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

	put(
		"README.md",
		[
			`# ${packageName}`,
			"",
			`Exported from Harness² run \`${runId}\`, final \`${label}\`, task \`${task.id}\`.`,
			"",
			"## Install",
			"",
			"```bash",
			`pi install "${dir}"`,
			"```",
			"",
			"The package appends its always-on harness on every run, loads its skills, and",
			"registers a `task` tool when the harness has agents.",
			"",
			"## Remove",
			"",
			"```bash",
			`pi remove "${dir}"`,
			"```",
			"",
			"## Contains",
			"",
			`- ${inventory(tree)}`,
			`- plugins: ${plugins.length ? plugins.map((p) => p.name).join(", ") : "none"}`,
			"",
			"Plugins are executable code. Review `extensions/plugin-*.ts` before installing.",
			"The full original tree is under `harness/` for reference.",
			"",
		].join("\n"),
	);
	put(
		"manifest.json",
		`${JSON.stringify(
			{
				packageName,
				task: { id: task.id, domain: task.domain },
				runId,
				label,
				exportedAt: new Date().toISOString(),
				inventory: inventory(tree),
				plugins: plugins.map((p) => p.name),
				agents: agentNames(tree),
				skills: skillNames(tree),
				files,
			},
			null,
			2,
		)}\n`,
	);

	return {
		dir,
		packageName,
		installCommand: `pi install "${dir}"`,
		files,
	};
}

function readTemplate(name: string): string {
	return fs.readFileSync(path.join(TEMPLATE_DIR, "templates", name), "utf8");
}

export function exportedInventory(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const file = path.join(d, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (entry.isFile()) out.push(relPosix(dir, file));
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return out.sort();
}
