/**
 * Harness² for Pi.
 *
 * Task-level recursion: base probes → INV/DOM proposals → candidate probes →
 * composition. Harnessing-level recursion: blind selection → reflection →
 * per-domain library. Everything runs as isolated Pi subprocesses; this
 * extension only orchestrates and stores evidence.
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { H2Config, Mode, TaskSpec } from "./types.ts";
import { loadConfig, modelArgFromContext } from "./config.ts";
import { autotrigger, baseHarness, inventory, readTree, validate } from "./tree.ts";
import { createTask, latestTask, listTasks, resolveTask } from "./task.ts";
import { libraryRoot } from "./library.ts";
import { refine, type RefineResult } from "./recursion.ts";
import { latestRun, writeReport, writeRunConfig } from "./report.ts";
import {
	adoptFromRun,
	activePromptBlock,
	activeSkillDirs,
	deactivate,
	describeActive,
	readActive,
	writeActive,
} from "./active.ts";
import { killAllChildren } from "./processes.ts";
import { clearRunWidget, setFailedStatus, setIdleStatus, updateRunStatus } from "./status.ts";
import { exportHarness } from "./materialize.ts";
import {
	ensureDir,
	exists,
	isDir,
	readJson,
	readText,
	slugify,
	timestamp,
} from "./util.ts";

const VERSION = "0.1.0";

type Ctx = ExtensionContext | ExtensionCommandContext;

interface ParsedArgs {
	positional: string[];
	flags: Record<string, string | boolean>;
}

function parseArgs(input: string): ParsedArgs {
	const tokens: string[] = [];
	let cur = "";
	let quote: string | undefined;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			else cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (/\s/.test(ch)) {
			if (cur) {
				tokens.push(cur);
				cur = "";
			}
		} else {
			cur += ch;
		}
	}
	if (cur) tokens.push(cur);
	const out: ParsedArgs = { positional: [], flags: {} };
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t.startsWith("--")) {
			out.positional.push(t);
			continue;
		}
		const eq = t.indexOf("=");
		if (eq > 0) {
			out.flags[t.slice(2, eq)] = t.slice(eq + 1);
		} else {
			const key = t.slice(2);
			const next = tokens[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				out.flags[key] = next;
				i++;
			} else {
				out.flags[key] = true;
			}
		}
	}
	return out;
}

function flagString(args: ParsedArgs, name: string): string | undefined {
	const v = args.flags[name];
	return typeof v === "string" ? v : undefined;
}

function flagNumber(args: ParsedArgs, name: string): number | undefined {
	const v = flagString(args, name);
	if (!v) return undefined;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) ? n : undefined;
}

function flagBool(args: ParsedArgs, name: string): boolean {
	return args.flags[name] === true || args.flags[name] === "true";
}

function lastUserPrompt(ctx: Ctx): string | undefined {
	let found: string | undefined;
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		const text = Array.isArray(content)
			? content
					.filter((p: any) => p?.type === "text")
					.map((p: any) => String(p.text ?? ""))
					.join("\n")
			: typeof content === "string"
				? content
				: "";
		if (text.trim()) found = text.trim();
	}
	return found;
}

interface RunParams {
	task?: string;
	prompt?: string;
	domain?: string;
	k?: number;
	mode?: Mode;
	seed?: number;
	select?: "auto" | "ask" | "first";
	reflect?: boolean;
	dryRun?: boolean;
}

interface RunOutcome {
	runId: string;
	runDir: string;
	reportPath: string;
	task: TaskSpec;
	result?: RefineResult;
	dryRun: boolean;
}

let activeRun = false;

function resolveTaskForRun(ctx: Ctx, cfg: H2Config, params: RunParams): TaskSpec {
	if (params.prompt?.trim()) {
		return createTask(cfg.cwd, cfg.home, {
			prompt: params.prompt,
			domain: params.domain,
			id: `${timestamp()}-task`,
		});
	}
	if (params.task?.trim()) {
		const task = resolveTask(cfg.cwd, cfg.home, params.task);
		if (!task) throw new Error(`task not found: ${params.task}`);
		return task;
	}
	const fromSession = lastUserPrompt(ctx);
	if (fromSession) {
		return createTask(cfg.cwd, cfg.home, {
			prompt: fromSession,
			domain: params.domain,
			id: `${timestamp()}-task`,
		});
	}
	const latest = latestTask(cfg.home);
	if (latest) return latest;
	throw new Error(
		"no task given. Use --task <id>, --prompt \"...\", or create one with /harness2 init",
	);
}

function nextRunId(cfg: H2Config, task: TaskSpec): string {
	const base = `${timestamp()}-${slugify(task.id, "task")}-${cfg.mode}k${cfg.k}`;
	let id = base;
	let n = 2;
	while (exists(path.join(cfg.runsRoot, id))) id = `${base}-${n++}`;
	return id;
}

function buildConfig(
	ctx: Ctx,
	pi: ExtensionAPI,
	params: RunParams,
): H2Config {
	const currentModel = modelArgFromContext(ctx.model);
	// Explicit environment models win over the session model; otherwise a
	// mid-session `/model` switch carries into probes and editor sessions.
	const envModel = process.env.HARNESS2_MODEL?.trim();
	const envImprover = process.env.HARNESS2_IMPROVER_MODEL?.trim();
	const overrides: Partial<H2Config> = {
		k: params.k,
		mode: params.mode,
		seed: params.seed,
		select: params.select,
		reflect: params.reflect,
		model: envModel ? undefined : currentModel,
		improverModel: envImprover ? undefined : currentModel,
		thinking: ctx.thinkingLevel,
	};
	const flagK = pi.getFlag("harness2-k");
	if (typeof flagK === "string" && flagK.trim() && params.k === undefined) {
		const n = Number.parseInt(flagK, 10);
		if (Number.isFinite(n)) overrides.k = n;
	}
	const flagMode = pi.getFlag("harness2-mode");
	if (typeof flagMode === "string" && flagMode.trim() && params.mode === undefined) {
		overrides.mode = flagMode as Mode;
	}
	return loadConfig(ctx.cwd, overrides);
}

async function executeRefine(
	ctx: Ctx,
	pi: ExtensionAPI,
	params: RunParams,
	onProgress?: (message: string) => void,
): Promise<RunOutcome> {
	if (activeRun) throw new Error("a Harness² run is already in progress");
	activeRun = true;
	let cfg: H2Config | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let failed = false;
	try {
		cfg = buildConfig(ctx, pi, params);
		const task = resolveTaskForRun(ctx, cfg, params);
		const runId = nextRunId(cfg, task);
		const runDir = path.join(cfg.runsRoot, runId);
		ensureDir(runDir);
		const baseTree = baseHarness(cfg.cwd, cfg.home);
		autotrigger(baseTree, cfg.alwaysOnMax);
		writeRunConfig(runDir, cfg, task, runId, baseTree);
		try {
			validate(baseTree, { alwaysOnMax: cfg.alwaysOnMax, compilePython: true });
		} catch (err) {
			ctx.ui.notify(`Base harness warning: ${(err as Error).message.slice(0, 500)}`, "warning");
		}
		const libraryDir = libraryRoot(cfg.libraryRoot, task.domain);

		if (params.dryRun) {
			return { runId, runDir, reportPath: "", task, dryRun: true, result: undefined };
		}

		const startedAt = Date.now();
		let phase = "starting";
		let fraction = 0;
		const paint = () => {
			if (!cfg) return;
			updateRunStatus(ctx, {
				taskId: task.id,
				mode: cfg.mode,
				k: cfg.k,
				phase,
				fraction,
				startedAt,
			});
		};
		const progress = (message: string, f?: number) => {
			phase = message;
			if (f !== undefined) fraction = f;
			paint();
			onProgress?.(message);
		};
		progress("starting", 0);
		if (ctx.mode === "tui") {
			timer = setInterval(paint, 1000);
			timer.unref?.();
		}

		const result = await refine({
			cfg,
			task,
			baseTree,
			runDir,
			runId,
			libraryDir,
			solverModel: cfg.model,
			improverModel: cfg.improverModel,
			signal: ctx.signal,
			onProgress: progress,
			ask:
				cfg.select === "ask" && ctx.hasUI
					? async (title, options) => ctx.ui.select(title, options)
					: undefined,
		});
		const reportPath = writeReport(runDir, cfg, task, runId, baseTree, result);
		clearRunWidget(ctx);
		ctx.ui.notify(
			[
				`Harness² ${runId} complete`,
				`adopted: ${result.adoptedLabel || "(none)"}`,
				`cost: $${result.costs.toFixed(4)}`,
				`report: ${reportPath}`,
				...result.errors.slice(0, 3).map((e) => `! ${e}`),
			].join("\n"),
			result.errors.length ? "warning" : "info",
		);
		return { runId, runDir, reportPath, task, result, dryRun: false };
	} catch (err) {
		failed = true;
		setFailedStatus(ctx, (err as Error).message);
		throw err;
	} finally {
		activeRun = false;
		if (timer) clearInterval(timer);
		if (!failed && cfg) setIdleStatus(ctx, cfg);
	}
}

function helpText(): string {
	return `Harness² ${VERSION} — recursive harness optimization for the task in front of you

/harness2 run [--task id] [--prompt "text"] [--k N] [--mode parallel|sequential]
               [--seed N] [--domain name] [--select auto|ask|first]
               [--no-reflect] [--dry-run]
/harness2 init [id]              create a task package
/harness2 list                   list tasks, runs, and active harness
/harness2 report [run]           show the latest report
/harness2 adopt [run] [label]    copy a final harness to .harness2/adopted/
/harness2 adopt [run] [label] --use
/harness2 export [run] [label]   export a final as a native Pi package
/harness2 use [run] [label]      apply a harness to this project
/harness2 use --off              stop applying the active harness
/harness2 status                 show the active harness and latest run
/harness2 help                   this text

k is the task-level recursion budget. k=1 is one Propose–Probe–Compose step.
parallel explores k INV + k DOM candidates; sequential refines through k rounds.
The model can call the harness2_refine tool with the same options.`;
}

function latestRunDir(cfg: H2Config): string | undefined {
	const dir = latestRun(cfg.runsRoot);
	return dir;
}

function adoptedLabelFromResult(runDir: string): string | undefined {
	const data = readJson<any>(path.join(runDir, "result.json"), undefined);
	return data?.adopted?.label || data?.selection?.chosenLabel;
}

function resolveRunDir(cfg: H2Config, selector?: string): string {
	if (!selector?.trim()) {
		const latest = latestRunDir(cfg);
		if (!latest) throw new Error(`no runs under ${cfg.runsRoot}`);
		return latest;
	}
	const candidates = [
		path.resolve(cfg.cwd, selector),
		path.join(cfg.runsRoot, selector),
	];
	for (const c of candidates) {
		if (isDir(c) && (exists(path.join(c, "result.json")) || exists(path.join(c, "run.json")))) return c;
	}
	const matches = fs.existsSync(cfg.runsRoot)
		? fs
				.readdirSync(cfg.runsRoot)
				.filter((name) => name.includes(selector))
				.sort()
		: [];
	const last = matches[matches.length - 1];
	if (last) return path.join(cfg.runsRoot, last);
	throw new Error(`run not found: ${selector}`);
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("harness2-k", {
		description: "Harness² recursion budget (default 1)",
		type: "string",
	});
	pi.registerFlag("harness2-mode", {
		description: "Harness² recursion mode: parallel or sequential",
		type: "string",
	});

	pi.registerTool(
		defineTool({
			name: "harness2_refine",
			label: "Harness² refine",
			description:
				"Recursively refine Pi's harness for a task: probe the current harness, propose INV/DOM edits, probe them, compose finals, select an artifact, and record a transferable lesson. Expensive: each probe is a full Pi run and each editor stage is another Pi session. Use k=1 first.",
			parameters: Type.Object({
				task: Type.Optional(Type.String({ description: "Task id or path (from /harness2 init)" })),
				prompt: Type.Optional(
					Type.String({
						description: "Task prompt. If omitted, the latest user message is used as the task.",
					}),
				),
				k: Type.Optional(Type.Number({ description: "Task-level recursion budget, 1-8" })),
				mode: Type.Optional(
					Type.Union([Type.Literal("parallel"), Type.Literal("sequential")], {
						description: "parallel explores wider; sequential refines deeper",
					}),
				),
				domain: Type.Optional(Type.String({ description: "Experience-library domain" })),
				seed: Type.Optional(Type.Number({ description: "Deterministic candidate-id shuffle seed" })),
				select: Type.Optional(
					Type.Union([Type.Literal("auto"), Type.Literal("ask"), Type.Literal("first")]),
				),
				reflect: Type.Optional(Type.Boolean({ description: "Write a library lesson (default true)" })),
				dryRun: Type.Optional(Type.Boolean({ description: "Preview selection and cost, no model calls" })),
			}),
			async execute(_toolCallId, params, _signal, onUpdate, ctx) {
				const outcome = await executeRefine(
					ctx,
					pi,
					{
						task: params.task,
						prompt: params.prompt,
						domain: params.domain,
						k: params.k,
						mode: params.mode,
						seed: params.seed,
						select: params.select,
						reflect: params.reflect,
						dryRun: params.dryRun,
					},
					(message) => onUpdate?.({
						content: [{ type: "text", text: message }],
						details: undefined,
					}),
				);
				if (outcome.dryRun) {
					return {
						content: [
							{
								type: "text",
								text: `Dry run for \`${outcome.task.id}\` (${outcome.task.domain}). No model calls were made. Base harness: ${inventory(baseHarness(ctx.cwd, loadConfig(ctx.cwd).home))}.`,
							},
						],
						details: { runId: outcome.runId, runDir: outcome.runDir, dryRun: true, task: outcome.task },
					};
				}
				const result = outcome.result!;
				return {
					content: [
						{
							type: "text",
							text: [
								`Harness² run \`${outcome.runId}\` complete.`,
								`Adopted final: \`${result.adoptedLabel || "(none)"}\``,
								`Recorded cost: $${result.costs.toFixed(4)}`,
								`Report: \`${outcome.reportPath}\``,
								`Adopted tree: \`${path.join(outcome.runDir, "adopted", "harness")}\``,
								...result.errors.slice(0, 5).map((e) => `Error: ${e}`),
							].join("\n"),
						},
					],
					details: {
						runId: outcome.runId,
						runDir: outcome.runDir,
						reportPath: outcome.reportPath,
						adoptedLabel: result.adoptedLabel,
						cost: result.costs,
						errors: result.errors,
						libraryEntry: result.libraryEntry,
					},
				};
			},
		}),
	);

	pi.registerCommand("harness2", {
		description: "Harness²: recursively refine the harness for a task",
		getArgumentCompletions: (prefix) => {
			const commands = ["run", "init", "list", "report", "adopt", "export", "use", "status", "help"];
			const filtered = commands.filter((c) => c.startsWith(prefix.trim()));
			return filtered.length ? filtered.map((c) => ({ value: c, label: c })) : null;
		},
		handler: async (raw, ctx) => {
			const parsed = parseArgs(raw.trim());
			const sub = parsed.positional.shift() ?? "help";
			const cfg = loadConfig(ctx.cwd);

			if (sub === "help" || sub === "?") {
				ctx.ui.notify(helpText(), "info");
				return;
			}
			if (sub === "run") {
				await ctx.waitForIdle();
				const params: RunParams = {
					task: flagString(parsed, "task"),
					prompt: flagString(parsed, "prompt"),
					domain: flagString(parsed, "domain"),
					k: flagNumber(parsed, "k"),
					mode: (flagString(parsed, "mode") as Mode | undefined) ?? undefined,
					seed: flagNumber(parsed, "seed"),
					select:
						(flagString(parsed, "select") as "auto" | "ask" | "first" | undefined) ??
						(flagBool(parsed, "ask") ? "ask" : flagBool(parsed, "no-select") ? "first" : undefined),
					reflect: flagBool(parsed, "no-reflect") ? false : true,
					dryRun: flagBool(parsed, "dry-run"),
				};
				const outcome = await executeRefine(ctx, pi, params);
				if (outcome.dryRun) {
					const c = loadConfig(ctx.cwd, {
						k: params.k,
						mode: params.mode,
					});
					ctx.ui.notify(
						[
							`Harness² dry run: ${outcome.runId}`,
							`task: ${outcome.task.id} (${outcome.task.domain})`,
							`mode: ${c.mode}, k=${c.k}`,
							`base: ${inventory(baseHarness(ctx.cwd, c.home))}`,
							`estimated probes: ${4 * c.k}; editor sessions: ${3 * c.k}`,
						].join("\n"),
						"info",
					);
				}
				return;
			}
			if (sub === "init") {
				const id = parsed.positional[0];
				let prompt = flagString(parsed, "prompt");
				if (!prompt && ctx.mode === "tui") {
					prompt = await ctx.ui.editor("Harness² task prompt", "");
				}
				if (!prompt?.trim()) {
					ctx.ui.notify("A prompt is required: /harness2 init [id] --prompt \"...\"", "warning");
					return;
				}
				const task = createTask(ctx.cwd, cfg.home, {
					id,
					prompt,
					domain: flagString(parsed, "domain"),
					deliverables: flagString(parsed, "deliverables")
						? flagString(parsed, "deliverables")!
								.split(",")
								.map((x) => x.trim())
								.filter(Boolean)
						: undefined,
					yardstick: flagString(parsed, "yardstick"),
					verify: flagString(parsed, "verify"),
					sourceDir: flagString(parsed, "source"),
				});
				ctx.ui.notify(`Created task \`${task.id}\` in ${task.dir}`, "info");
				return;
			}
			if (sub === "list") {
				const tasks = listTasks(cfg.home);
				const runs = exists(cfg.runsRoot)
					? fs.readdirSync(cfg.runsRoot).filter((n) => isDir(path.join(cfg.runsRoot, n))).sort().reverse()
					: [];
				const active = describeActive(cfg);
				const libDomains = isDir(cfg.libraryRoot)
					? fs.readdirSync(cfg.libraryRoot).filter((n) => isDir(path.join(cfg.libraryRoot, n)))
					: [];
				const lines = [
					`active: ${active}`,
					"",
					`tasks (${tasks.length}):`,
					...tasks.slice(0, 12).map((t) => `  ${t.id} [${t.domain}] ${t.prompt.slice(0, 70)}`),
					"",
					`runs (${runs.length}):`,
					...runs.slice(0, 12).map((r) => `  ${r}`),
					"",
					`library domains (${libDomains.length}): ${libDomains.join(", ") || "(empty)"}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (sub === "report") {
				const runDir = resolveRunDir(cfg, parsed.positional[0]);
				const report = readText(path.join(runDir, "report.md"));
				if (!report.trim()) {
					ctx.ui.notify(`No report at ${runDir}`, "warning");
					return;
				}
				if (ctx.mode === "tui") await ctx.ui.editor(`Report ${path.basename(runDir)}`, report);
				else ctx.ui.notify(report.slice(0, 6000), "info");
				return;
			}
			if (sub === "export") {
				const runDir = resolveRunDir(cfg, parsed.positional[0]);
				const label = parsed.positional[1] || adoptedLabelFromResult(runDir);
				if (!label) throw new Error("no final label; pass one explicitly");
				const harnessDir = path.join(runDir, "harnesses", label);
				const tree = readTree(harnessDir);
				if (!Object.keys(tree).length) throw new Error(`harness \`${label}\` is empty`);
				validate(tree, { alwaysOnMax: cfg.alwaysOnMax, compilePython: false });
				const data = readJson<any>(path.join(runDir, "result.json"), {});
				const task: TaskSpec = {
					id: data?.task?.id ?? path.basename(runDir),
					prompt: data?.task?.prompt ?? "",
					domain: data?.task?.domain ?? "default",
					deliverables: [],
					leakGlobs: [],
					yardstick: "",
				};
				const exported = exportHarness({
					cfg,
					task,
					tree,
					runId: path.basename(runDir),
					label,
					outDir: flagString(parsed, "out"),
					force: flagBool(parsed, "force"),
				});
				ctx.ui.notify(
					[
						`Exported \`${label}\` as a Pi package:`,
						exported.dir,
						"",
						`Install: ${exported.installCommand}`,
						`Remove:  pi remove "${exported.dir}"`,
						"",
						"Plugins in the package are executable code; review them before installing.",
					].join("\n"),
					"info",
				);
				return;
			}
			if (sub === "adopt" || sub === "use") {
				const runSelector = parsed.positional[0];
				const labelArg = parsed.positional[1];
				if (sub === "use" && flagBool(parsed, "off")) {
					deactivate(cfg);
					ctx.ui.notify("Harness² active harness cleared", "info");
					await ctx.reload();
					return;
				}
				if (sub === "use" && !runSelector) {
					const latest = latestTask(cfg.home);
					const taskId = latest?.id ? slugify(latest.id, "task") : undefined;
					const dir = taskId ? path.join(cfg.adoptedRoot, taskId, "harness") : undefined;
					if (!dir || !isDir(dir)) {
						ctx.ui.notify("No adopted harness to use. Run /harness2 adopt first.", "warning");
						return;
					}
					writeActive(cfg, {
						runId: "adopted",
						label: "adopted",
						taskId: latest?.id ?? "unknown",
						harnessDir: dir,
						activatedAt: new Date().toISOString(),
					});
					ctx.ui.notify(`Activated adopted harness for \`${latest?.id ?? "task"}\``, "info");
					await ctx.reload();
					return;
				}
				const runDir = resolveRunDir(cfg, runSelector);
				const label = labelArg || adoptedLabelFromResult(runDir);
				if (!label) throw new Error("no adopted label; pass one explicitly");
				if (sub === "adopt") {
					const data = readJson<any>(path.join(runDir, "result.json"), {});
					const taskId = slugify(data?.task?.id ?? path.basename(runDir), "task");
					const adopted = adoptFromRun(cfg, runDir, taskId, label);
					ctx.ui.notify(`Adopted \`${label}\` → ${adopted.dir}\n${adopted.inventory}`, "info");
					if (flagBool(parsed, "use")) {
						writeActive(cfg, {
							runId: path.basename(runDir),
							label,
							taskId,
							harnessDir: adopted.dir,
							activatedAt: new Date().toISOString(),
						});
						ctx.ui.notify(`Activated adopted harness \`${label}\``, "info");
						await ctx.reload();
						return;
					}
					return;
				}
				const harnessDir = path.join(runDir, "harnesses", label);
				if (!isDir(harnessDir)) throw new Error(`no harness \`${label}\` in ${runDir}`);
				const tree = readTree(harnessDir);
				if (!Object.keys(tree).length) throw new Error(`harness \`${label}\` is empty`);
				validate(tree, { alwaysOnMax: cfg.alwaysOnMax, compilePython: false });
				writeActive(cfg, {
					runId: path.basename(runDir),
					label,
					taskId: readJson<any>(path.join(runDir, "result.json"), {})?.task?.id ?? "task",
					harnessDir,
					activatedAt: new Date().toISOString(),
				});
				ctx.ui.notify(
					`Activated \`${label}\` from ${path.basename(runDir)}\n${inventory(tree)}\nSkills reloaded. Plugins are not loaded automatically; use pi -e.`,
					"info",
				);
				await ctx.reload();
				return;
			}
			if (sub === "status") {
				const active = readActive(cfg);
				const runDir = latestRunDir(cfg);
				ctx.ui.notify(
					[
						`Harness² ${VERSION}`,
						`active: ${describeActive(cfg)}`,
						...(active ? [`active dir: ${active.harnessDir}`] : []),
						`latest run: ${runDir ?? "(none)"}`,
					].join("\n"),
					"info",
				);
				setIdleStatus(ctx, cfg);
				return;
			}
			ctx.ui.notify(`Unknown /harness2 command: ${sub}\n\n${helpText()}`, "warning");
		},
	});

	pi.on("resources_discover", (_event, ctx) => {
		const cfg = loadConfig(ctx.cwd);
		const skillPaths = activeSkillDirs(cfg);
		return { skillPaths, willRetry: false };
	});

	pi.on("before_agent_start", (event, ctx) => {
		const cfg = loadConfig(ctx.cwd);
		const block = activePromptBlock(cfg);
		if (!block) return;
		const options = event.systemPromptOptions;
		// The active harness is the always-on layer. Suppress discovered context
		// files so AGENTS.md does not appear twice when the harness was seeded from it.
		options.contextFiles = [];
		options.appendSystemPrompt = options.appendSystemPrompt?.trim()
			? `${options.appendSystemPrompt.trimEnd()}\n\n${block}`
			: block;
	});

	pi.on("session_start", (_event, ctx) => {
		const cfg = loadConfig(ctx.cwd);
		setIdleStatus(ctx, cfg);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearRunWidget(ctx);
		killAllChildren();
	});
}
