/**
 * Template copied into an exported harness package when the harness has agents.
 *
 * Self-contained: it only imports the host package and Node builtins. Each
 * subagent runs in a fresh Pi process with its own context and returns text.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
}

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = path.join(pkgDir, "agents");

function toolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
	return tools.length ? tools : undefined;
}

function discoverAgents(): AgentConfig[] {
	if (!fs.existsSync(agentsDir)) return [];
	const out: AgentConfig[] = [];
	for (const file of fs.readdirSync(agentsDir).sort()) {
		if (!file.endsWith(".md")) continue;
		let content: string;
		try {
			content = fs.readFileSync(path.join(agentsDir, file), "utf8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const name =
			typeof frontmatter.name === "string" && frontmatter.name.trim()
				? frontmatter.name.trim()
				: file.replace(/\.md$/, "");
		const description =
			typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
		if (!description || !body.trim()) continue;
		out.push({
			name,
			description,
			tools: toolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined,
			systemPrompt: body,
		});
	}
	return out;
}

function invocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	const virtual = script?.startsWith("/$bunfs/root/");
	if (script && !virtual && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function finalText(eventsFile: string): string {
	if (!fs.existsSync(eventsFile)) return "";
	let final = "";
	for (const line of fs.readFileSync(eventsFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line);
			if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
			const text = Array.isArray(event.message.content)
				? event.message.content
						.filter((part: any) => part?.type === "text")
						.map((part: any) => String(part.text ?? ""))
						.join("\n")
				: "";
			if (text.trim()) final = text;
		} catch {
			/* ignore malformed event */
		}
	}
	return final;
}

async function runAgent(
	agent: AgentConfig,
	task: string,
	cwd: string,
	parentModel: string | undefined,
): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness2-agent-"));
	const promptFile = path.join(dir, "system.md");
	const eventsFile = path.join(dir, "events.jsonl");
	fs.writeFileSync(promptFile, agent.systemPrompt, "utf8");
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
	const model = agent.model ?? parentModel;
	if (model) args.push("--model", model);
	args.push("--", `Task: ${task}`);

	const call = invocation(args);
	const child = spawn(call.command, call.args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
	const stream = fs.createWriteStream(eventsFile, { flags: "w" });
	let buffer = "";
	let stderr = "";
	child.stdout?.on("data", (data: Buffer) => {
		buffer += data.toString("utf8");
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) stream.write(`${line}\n`);
	});
	child.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString("utf8");
		if (stderr.length > 40_000) stderr = stderr.slice(-40_000);
	});
	const code = await new Promise<number>((resolve) => {
		child.on("close", (value) => resolve(value ?? 0));
		child.on("error", () => resolve(1));
	});
	if (buffer.trim()) stream.write(`${buffer}\n`);
	await new Promise<void>((resolve) => stream.end(resolve));
	const text = finalText(eventsFile);
	fs.rmSync(dir, { recursive: true, force: true });
	if (text.trim()) return text;
	return code === 0
		? "(subagent produced no text)"
		: `subagent failed (exit ${code})${stderr ? `: ${stderr.slice(-800)}` : ""}`;
}

export default function (pi: ExtensionAPI) {
	const agents = discoverAgents();
	if (!agents.length) return;
	const listing = agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");

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
				const agent = agents.find((item) => item.name === params.agent);
				if (!agent) {
					throw new Error(
						`unknown agent ${JSON.stringify(params.agent)}; available: ${agents
							.map((item) => item.name)
							.join(", ")}`,
					);
				}
				const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const text = await runAgent(agent, params.task, ctx.cwd, parentModel);
				if (signal?.aborted) throw new Error("subagent aborted");
				return { content: [{ type: "text", text }], details: { agent: agent.name } };
			},
		}),
	);
}
