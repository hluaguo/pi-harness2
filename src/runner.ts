/**
 * Solver probes: one isolated Pi subprocess per candidate harness.
 *
 * The JSON event stream is both the audit log and the raw material for the
 * shared trajectory grammar. No score, rubric, or grader enters this file.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import type { H2Config, RunView, TaskSpec, Tree } from "./types.ts";
import {
	ALWAYS_ON_FILES,
	agentNames,
	alwaysOnText,
} from "./tree.ts";
import {
	ensureDir,
	getPiInvocation,
	readText,
	truncate,
	writeJson,
	writeText,
} from "./util.ts";
import { extractDeliverable, type WorkspaceInfo } from "./workspace.ts";
import { registerChild } from "./processes.ts";

export interface ProbeOptions {
	label: string;
	task: TaskSpec;
	tree: Tree;
	harnessDir: string;
	workspace: WorkspaceInfo;
	runDir: string;
	cfg: H2Config;
	model?: string;
	thinking?: string;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

interface TrajectoryItem {
	kind: "ACTION" | "OBSERVATION" | "ERROR" | "ASSISTANT" | "NOTE";
	name?: string;
	text: string;
}

interface ParsedEvent {
	type?: string;
	message?: any;
	toolName?: string;
	args?: unknown;
	toolCallId?: string;
	result?: any;
	isError?: boolean;
	durationMs?: number;
	assistantMessageEvent?: any;
	aborted?: boolean;
}

function eventText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if (part.type === "text") return String(part.text ?? "");
			if (part.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function renderTrajectory(
	label: string,
	task: TaskSpec,
	model: string | undefined,
	items: TrajectoryItem[],
	obsTrunc: number,
): string {
	const out = [
		`# Rollout ${label}`,
		"",
		`- task: \`${task.id}\``,
		`- model: \`${model ?? "current"}\``,
		"",
		"Trajectory grammar: `[ACTION]` is a tool call, `[OBSERVATION]` is its result, `[ERROR]` is a failed call or run, `[ASSISTANT]` is agent prose.",
		"",
	];
	for (const item of items) {
		if (item.kind === "ACTION") out.push(`[ACTION] ${item.name ?? "tool"} ${item.text}`.trim());
		else if (item.kind === "ERROR") out.push(`[ERROR] ${truncate(item.text, obsTrunc)}`);
		else if (item.kind === "OBSERVATION")
			out.push(`[OBSERVATION] ${truncate(item.text, obsTrunc)}`);
		else if (item.kind === "ASSISTANT") out.push(`[ASSISTANT] ${truncate(item.text, obsTrunc)}`);
		else out.push(`[NOTE] ${item.text}`);
		out.push("");
	}
	return out.join("\n");
}

function probeSubagentPath(): string {
	return fileURLToPath(new URL("./probe-subagent.ts", import.meta.url));
}

export async function runProbe(opts: ProbeOptions): Promise<RunView> {
	const { cfg, task, tree, harnessDir, workspace, runDir, label } = opts;
	const workspaceDir = workspace.dir;
	const rolloutDir = path.join(runDir, "rollouts", label);
	ensureDir(rolloutDir);
	const eventsPath = path.join(rolloutDir, "events.jsonl");
	const trajectoryPath = path.join(rolloutDir, "trajectory.md");
	const deliverableDir = path.join(rolloutDir, "deliverable");
	const alwaysOnPath = path.join(rolloutDir, "always-on.md");

	const alwaysOn = alwaysOnText(tree);
	const harnessNote = [
		alwaysOn,
		"",
		"# HARNESS LOCATION",
		"",
		`This harness lives at \`${harnessDir}\`.`,
		"Skills are available through Pi's skill mechanism. Scripts, when present, are under the harness's `scripts/` directory; run them with `python3 <absolute path>`.",
		"",
	].join("\n");
	writeText(alwaysOnPath, harnessNote);

	const model = opts.model ?? cfg.model;
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"-ne",
		"-ns",
		"-nc",
		"-np",
		"--no-mcp",
		"--tools",
		"+ls,+grep,+find",
		"--append-system-prompt",
		alwaysOnPath,
	];
	if (model) args.push("--model", model);
	if (opts.thinking) args.push("--thinking", opts.thinking);

	const skillsDir = path.join(harnessDir, "skills");
	if (fs.existsSync(skillsDir)) {
		for (const name of fs.readdirSync(skillsDir).sort()) {
			const dir = path.join(skillsDir, name);
			if (fs.existsSync(path.join(dir, "SKILL.md"))) args.push("--skill", dir);
		}
	}

	const agentsDir = path.join(harnessDir, "agents");
	if (agentNames(tree).length && fs.existsSync(agentsDir)) {
		args.push("-e", probeSubagentPath());
	}

	const pluginsDir = path.join(harnessDir, "plugins");
	if (fs.existsSync(pluginsDir)) {
		for (const name of fs.readdirSync(pluginsDir).sort()) {
			if (name.endsWith(".ts") || name.endsWith(".js")) {
				args.push("-e", path.join(pluginsDir, name));
			}
		}
	}

	args.push("--", task.prompt);

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HARNESS2_PROBE: "1",
		HARNESS2_AGENTS_DIR: agentsDir,
	};
	const invocation = getPiInvocation(args);
	ensureDir(path.dirname(eventsPath));
	const eventStream = fs.createWriteStream(eventsPath, { flags: "w" });

	const items: TrajectoryItem[] = [];
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	let stopReason: string | undefined;
	let resultModel: string | undefined;
	let aborted = false;
	let spawnError = "";
	let stderr = "";
	let exitCode = 0;
	const started = Date.now();

	const child = spawn(invocation.command, invocation.args, {
		cwd: workspaceDir,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	registerChild(child);

	let buffer = "";
	const processLine = (line: string) => {
		if (!line.trim()) return;
		eventStream.write(`${line}\n`);
		let event: ParsedEvent;
		try {
			event = JSON.parse(line) as ParsedEvent;
		} catch {
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const msg = event.message;
			usage.turns++;
			const u = msg.usage;
			if (u) {
				usage.input += u.input ?? 0;
				usage.output += u.output ?? 0;
				usage.cacheRead += u.cacheRead ?? 0;
				usage.cacheWrite += u.cacheWrite ?? 0;
				usage.cost += u.cost?.total ?? 0;
			}
			if (msg.model) resultModel = msg.model;
			if (msg.stopReason) stopReason = msg.stopReason;
			if (msg.errorMessage) items.push({ kind: "ERROR", text: String(msg.errorMessage) });
			const text = eventText(msg.content);
			if (text.trim()) items.push({ kind: "ASSISTANT", text });
		} else if (event.type === "tool_execution_start") {
			items.push({
				kind: "ACTION",
				name: event.toolName,
				text: truncate(JSON.stringify(event.args ?? {}), 4_000),
			});
		} else if (event.type === "tool_execution_end") {
			const text = eventText(event.result?.content);
			if (event.isError) {
				items.push({ kind: "ERROR", text: text || "tool call failed" });
			} else {
				items.push({
					kind: "OBSERVATION",
					text: `${text}${event.durationMs !== undefined ? `\n(duration ${event.durationMs}ms)` : ""}`,
				});
			}
		} else if (event.type === "auto_retry_start") {
			items.push({ kind: "NOTE", text: "provider retry started" });
		} else if (event.type === "agent_settled" && event.aborted) {
			items.push({ kind: "ERROR", text: "agent settled after an abort" });
		}
	};

	const timeout = setTimeout(() => {
		aborted = true;
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!child.killed) child.kill("SIGKILL");
		}, 5_000).unref?.();
	}, cfg.rolloutTimeoutMs);

	const onAbort = () => {
		aborted = true;
		child.kill("SIGTERM");
	};
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	const closed = await new Promise<number>((resolve) => {
		child.stdout?.on("data", (data: Buffer) => {
			buffer += data.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line.replace(/\r$/, ""));
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString("utf8");
			if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
		});
		child.on("close", (code) => {
			if (buffer.trim()) processLine(buffer.replace(/\r$/, ""));
			resolve(code ?? 0);
		});
		child.on("error", (err) => {
			spawnError = `${err.name}: ${err.message}`;
			resolve(1);
		});
	});
	clearTimeout(timeout);
	opts.signal?.removeEventListener("abort", onAbort);
	await new Promise<void>((resolve) => eventStream.end(resolve));

	exitCode = closed;
	if (aborted) spawnError = spawnError || "probe aborted or timed out";
	else if (exitCode !== 0 && !spawnError) {
		spawnError = `pi exited ${exitCode}${stderr.trim() ? `: ${truncate(stderr.trim().slice(-800), 800)}` : ""}`;
	}
	if (stopReason === "error" || stopReason === "aborted") {
		spawnError = spawnError || `model stop reason: ${stopReason}`;
	}
	if (spawnError) items.push({ kind: "ERROR", text: spawnError });
	else if (!items.length && stderr.trim()) items.push({ kind: "NOTE", text: stderr.slice(-4000) });

	writeText(
		trajectoryPath,
		renderTrajectory(label, task, resultModel ?? model, items, cfg.obsTrunc),
	);
	const deliverable = extractDeliverable(workspace, task, deliverableDir);

	const wallS = Math.round((Date.now() - started) / 100) / 10;
	const view: RunView = {
		label,
		taskId: task.id,
		runDir: rolloutDir,
		workspaceDir,
		eventsPath,
		trajectoryPath,
		deliverableDir,
		deliverableTextPath: path.join(deliverableDir, "deliverable.md"),
		ok: !aborted && !spawnError,
		delivered: deliverable.delivered,
		exitCode,
		error: spawnError,
		stopReason,
		model: resultModel ?? model,
		usage,
		wallS,
		changedFiles: deliverable.changedFiles,
	};
	writeJson(path.join(rolloutDir, "run.json"), {
		...view,
		stderrTail: stderr.slice(-4000),
		harnessFiles: Object.keys(tree).length,
		alwaysOnChars: alwaysOn.length,
	});
	return view;
}

export function readTrajectory(run: RunView): string {
	return readText(run.trajectoryPath, "(trajectory unavailable)");
}

export function harnessAlwaysOnSummary(tree: Tree): string {
	return ALWAYS_ON_FILES.map((rel) => `${rel}: ${(tree[rel] ?? "").length} chars`).join(", ");
}
