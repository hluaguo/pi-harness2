/**
 * Subagent helper loaded only into probe sessions whose harness has `agents/`.
 *
 * Pi ships without built-in subagents. This is the c5 port: each agent runs in a
 * fresh Pi process with its own context and returns text.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { killAllChildren, registerChild } from "./processes.ts";
import { asString, asStringArray, frontmatter, getPiInvocation } from "./util.ts";

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
}

function discoverAgents(dir: string | undefined): AgentConfig[] {
	if (!dir || !fs.existsSync(dir)) return [];
	const out: AgentConfig[] = [];
	for (const name of fs.readdirSync(dir).sort()) {
		if (!name.endsWith(".md")) continue;
		const file = path.join(dir, name);
		let content: string;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const { frontmatter: fm, body } = frontmatter(content);
		const agentName = asString(fm.name).trim() || name.replace(/\.md$/, "");
		const description = asString(fm.description).trim();
		if (!agentName || !description || !body.trim()) continue;
		out.push({
			name: agentName,
			description,
			tools: asStringArray(fm.tools),
			model: asString(fm.model).trim() || undefined,
			systemPrompt: body,
		});
	}
	return out;
}

function getFinalText(eventsPath: string): { text: string; exit: number } {
	const lines = fs.existsSync(eventsPath)
		? fs.readFileSync(eventsPath, "utf8").split("\n")
		: [];
	let final = "";
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
			const text = Array.isArray(event.message.content)
				? event.message.content
						.filter((p: any) => p?.type === "text")
						.map((p: any) => String(p.text ?? ""))
						.join("\n")
				: "";
			if (text.trim()) final = text;
		} catch {
			/* ignore */
		}
	}
	return { text: final, exit: 0 };
}

async function runAgent(
	agent: AgentConfig,
	task: string,
	cwd: string,
	model: string | undefined,
	timeoutMs = 15 * 60 * 1000,
): Promise<string> {
	const promptFile = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "h2-subagent-")),
		"prompt.md",
	);
	fs.writeFileSync(promptFile, agent.systemPrompt, "utf8");
	const eventsFile = `${promptFile}.events.jsonl`;
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
		(agent.tools?.length ? agent.tools : ["read", "bash", "edit", "write", "ls", "grep", "find"]).join(","),
		"--append-system-prompt",
		promptFile,
	];
	const chosenModel = agent.model ?? model;
	if (chosenModel) args.push("--model", chosenModel);
	args.push("--", `Task: ${task}`);

	const invocation = getPiInvocation(args);
	const out = fs.createWriteStream(eventsFile, { flags: "w" });
	const child = spawn(invocation.command, invocation.args, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	registerChild(child);
	let stderr = "";
	let buffer = "";
	child.stdout?.on("data", (data: Buffer) => {
		buffer += data.toString("utf8");
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) out.write(`${line}\n`);
	});
	child.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString("utf8");
		if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
	});
	const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
	const code = await new Promise<number>((resolve) => {
		child.on("close", (c) => resolve(c ?? 0));
		child.on("error", () => resolve(1));
	});
	clearTimeout(timer);
	if (buffer.trim()) out.write(`${buffer}\n`);
	await new Promise<void>((resolve) => out.end(resolve));
	const { text } = getFinalText(eventsFile);
	fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
	if (text.trim()) return text;
	return code === 0
		? "(subagent produced no text)"
		: `subagent failed (exit ${code})${stderr ? `: ${stderr.slice(-800)}` : ""}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_shutdown", () => killAllChildren());
	const agents = discoverAgents(process.env.HARNESS2_AGENTS_DIR);
	if (!agents.length) {
		console.error(
			`pi-harness2: no subagents found in ${process.env.HARNESS2_AGENTS_DIR ?? "(unset)"}`,
		);
		return;
	}
	const listing = agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");

	pi.registerTool(
		defineTool({
			name: "task",
			label: "Task",
			description: `Delegate a bounded sub-task to a subagent. Each runs in its own context and returns text.\n\nAvailable agents:\n${listing}`,
			promptSnippet: "Delegate a bounded sub-task to a subagent",
			promptGuidelines: [
				"Use the `task` tool for a bounded sub-task whose input is large and whose answer is small; the subagent cannot see this conversation.",
			],
			parameters: Type.Object({
				agent: Type.String({ description: "Agent name" }),
				task: Type.String({ description: "The sub-task, with all needed input" }),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					throw new Error(
						`unknown agent ${JSON.stringify(params.agent)}; available: ${agents
							.map((a) => a.name)
							.join(", ")}`,
					);
				}
				const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const text = await runAgent(agent, params.task, ctx.cwd, model);
				if (signal?.aborted) throw new Error("subagent aborted");
				return {
					content: [{ type: "text", text }],
					details: { agent: agent.name },
				};
			},
		}),
	);
}
