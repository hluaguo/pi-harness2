/** Task packages: the Pi analogue of a benchmark adapter's static spec. */

import fs from "node:fs";
import path from "node:path";
import type { TaskSpec } from "./types.ts";
import {
	asStringArray,
	ensureDir,
	exists,
	isDir,
	listDirs,
	readJson,
	readText,
	slugify,
	timestamp,
	writeJson,
	writeText,
} from "./util.ts";

interface TaskFile {
	id?: string;
	prompt?: string;
	domain?: string;
	deliverables?: string[];
	leakGlobs?: string[];
	yardstick?: string;
	verify?: string;
	sourceDir?: string;
}

export function taskDir(home: string, id: string): string {
	return path.join(home, "tasks", slugify(id, "task"));
}

export function loadTaskFromDir(dir: string): TaskSpec {
	const jsonPath = path.join(dir, "task.json");
	const mdPath = path.join(dir, "task.md");
	const raw = readJson<TaskFile>(jsonPath, {});
	const prompt = (raw.prompt ?? readText(mdPath)).trim();
	if (!prompt) throw new Error(`task ${dir} has no prompt (task.json prompt or task.md)`);
	const id = raw.id?.trim() || path.basename(dir);
	const sourceRel = raw.sourceDir?.trim();
	let sourceDir = sourceRel
		? path.resolve(dir, sourceRel)
		: isDir(path.join(dir, "source"))
			? path.join(dir, "source")
			: undefined;
	if (sourceDir && !isDir(sourceDir)) sourceDir = undefined;
	return {
		id,
		prompt,
		domain: raw.domain?.trim() || "default",
		deliverables: asStringArray(raw.deliverables),
		leakGlobs: asStringArray(raw.leakGlobs),
		yardstick: raw.yardstick?.trim() || "",
		verify: raw.verify?.trim() || undefined,
		sourceDir,
		dir,
	};
}

export function resolveTask(
	cwd: string,
	home: string,
	selector?: string,
): TaskSpec | undefined {
	if (!selector?.trim()) return undefined;
	const raw = selector.trim();
	const candidates = [
		path.resolve(cwd, raw),
		path.join(home, "tasks", slugify(raw, "task")),
	];
	for (const candidate of candidates) {
		if (isDir(candidate)) {
			if (exists(path.join(candidate, "task.json")) || exists(path.join(candidate, "task.md"))) {
				return loadTaskFromDir(candidate);
			}
		}
		if (exists(candidate) && fs.statSync(candidate).isFile()) {
			if (candidate.endsWith(".json")) {
				const rawTask = readJson<TaskFile>(candidate, {});
				const prompt = (rawTask.prompt ?? "").trim();
				if (!prompt) throw new Error(`${candidate} has no prompt`);
				return {
					id: rawTask.id?.trim() || path.basename(candidate, ".json"),
					prompt,
					domain: rawTask.domain?.trim() || "default",
					deliverables: asStringArray(rawTask.deliverables),
					leakGlobs: asStringArray(rawTask.leakGlobs),
					yardstick: rawTask.yardstick?.trim() || "",
					verify: rawTask.verify?.trim() || undefined,
					sourceDir: rawTask.sourceDir
						? path.resolve(path.dirname(candidate), rawTask.sourceDir)
						: undefined,
				};
			}
			const prompt = readText(candidate).trim();
			if (prompt) {
				return {
					id: slugify(path.basename(candidate, path.extname(candidate))),
					prompt,
					domain: "default",
					deliverables: [],
					leakGlobs: [],
					yardstick: "",
					sourceDir: undefined,
				};
			}
		}
	}
	return undefined;
}

export interface CreateTaskOptions {
	id?: string;
	prompt: string;
	domain?: string;
	deliverables?: string[];
	yardstick?: string;
	verify?: string;
	sourceDir?: string;
}

export function createTask(cwd: string, home: string, opts: CreateTaskOptions): TaskSpec {
	const id = slugify(opts.id || `${timestamp()}-task`, "task");
	const dir = taskDir(home, id);
	ensureDir(dir);
	const sourceRel = opts.sourceDir ? path.relative(dir, path.resolve(cwd, opts.sourceDir)) : undefined;
	writeText(path.join(dir, "task.md"), `${opts.prompt.trim()}\n`);
	writeJson(path.join(dir, "task.json"), {
		id,
		prompt: opts.prompt.trim(),
		domain: opts.domain?.trim() || "default",
		deliverables: opts.deliverables ?? [],
		leakGlobs: [],
		yardstick: opts.yardstick?.trim() || "",
		verify: opts.verify?.trim() || "",
		...(sourceRel ? { sourceDir: sourceRel } : {}),
	});
	return loadTaskFromDir(dir);
}

export function latestTask(home: string): TaskSpec | undefined {
	const dirs = listDirs(path.join(home, "tasks"));
	for (const name of dirs.reverse()) {
		const dir = path.join(home, "tasks", name);
		if (exists(path.join(dir, "task.json")) || exists(path.join(dir, "task.md"))) {
			return loadTaskFromDir(dir);
		}
	}
	return undefined;
}

export function listTasks(home: string): Array<{ id: string; domain: string; prompt: string; dir: string }> {
	const root = path.join(home, "tasks");
	return listDirs(root).map((name) => {
		const dir = path.join(root, name);
		let task: TaskSpec | undefined;
		try {
			task = loadTaskFromDir(dir);
		} catch {
			task = undefined;
		}
		return {
			id: task?.id ?? name,
			domain: task?.domain ?? "?",
			prompt: (task?.prompt ?? "").replace(/\s+/g, " ").slice(0, 100),
			dir,
		};
	});
}
