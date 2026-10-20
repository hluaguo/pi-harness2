/**
 * Harness editor sessions.
 *
 * The editor is a Pi subprocess in an isolated evidence directory. Its edits to
 * `context/harness/` are the proposal. A cache keyed by (label, mission,
 * evidence bytes) makes retries and re-runs cheap without hiding invalid trees.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { H2Config } from "./types.ts";
import {
	copyDir,
	ensureDir,
	getPiInvocation,
	hashDir,
	isDir,
	listFilesRecursive,
	readJson,
	relPosix,
	sha256,
	sleep,
	writeJson,
	writeText,
} from "./util.ts";
import { registerChild } from "./processes.ts";

export interface Reply {
	label: string;
	text: string;
	ok: boolean;
	costUsd: number;
	wallS: number;
	attempts: number;
	cached: boolean;
	error: string;
	workspace?: string;
	eventsPath?: string;
}

interface CallOptions {
	system?: string;
	timeoutMs?: number;
	maxAttempts?: number;
	harvest?: string | null;
	tools?: string[];
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

interface CachedReply {
	text: string;
	costUsd: number;
	wallS: number;
	attempts: number;
	error?: string;
}

export class Proposer {
	constructor(
		private cfg: H2Config,
		private model: string | undefined,
		private auditRoot: string,
	) {}

	async call(
		mission: string,
		contextDir: string,
		label: string,
		opts: CallOptions = {},
	): Promise<Reply> {
		const harvest = opts.harvest === null ? null : (opts.harvest ?? "context/harness");
		const key = sha256(
			`${label}\0${mission}\0${opts.system ?? ""}\0${hashDir(contextDir)}`,
		);
		const cacheDir = path.join(this.auditRoot, "cache", key);
		const cached = this.readCache(cacheDir, label);
		if (cached) {
			const cachedHarness = path.join(cacheDir, "harness");
			if (isDir(cachedHarness)) {
				const target = path.join(contextDir, harvest ?? "context/harness");
				fs.rmSync(target, { recursive: true, force: true });
				copyDir(cachedHarness, target);
				return { ...cached, workspace: target };
			}
			return cached;
		}

		const attempts = Math.max(1, opts.maxAttempts ?? this.cfg.transportAttempts);
		let lastError = "";
		let spent = 0;
		const started = Date.now();
		for (let attempt = 1; attempt <= attempts; attempt++) {
			if (attempt > 1) await sleep(2_000 * (attempt - 1));
			opts.onProgress?.(`${label}: editor session ${attempt}/${attempts}`);
			const result = await this.runOnce(mission, contextDir, label, attempt, opts);
			spent += result.costUsd;
			if (result.ok && result.text.trim()) {
				const workspace = harvest && isDir(path.join(contextDir, harvest))
					? path.join(contextDir, harvest)
					: undefined;
				const reply: Reply = {
					label,
					text: result.text,
					ok: true,
					costUsd: spent,
					wallS: Math.round((Date.now() - started) / 100) / 10,
					attempts: attempt,
					cached: false,
					error: "",
					workspace,
					eventsPath: result.eventsPath,
				};
				this.writeCache(cacheDir, reply, workspace);
				return reply;
			}
			lastError = result.error || "empty reply";
			if (opts.signal?.aborted) break;
		}
		return {
			label,
			text: "",
			ok: false,
			costUsd: spent,
			wallS: Math.round((Date.now() - started) / 100) / 10,
			attempts,
			cached: false,
			error: lastError,
		};
	}

	private async runOnce(
		mission: string,
		contextDir: string,
		label: string,
		attempt: number,
		opts: CallOptions,
	): Promise<{ ok: boolean; text: string; error: string; costUsd: number; eventsPath: string }> {
		const auditDir = path.join(this.auditRoot, safeLabel(label));
		ensureDir(auditDir);
		writeText(path.join(auditDir, `mission.a${attempt}.md`), mission);
		const eventsPath = path.join(auditDir, `events.a${attempt}.jsonl`);
		const stream = fs.createWriteStream(eventsPath, { flags: "w" });

		let promptPath: string | undefined;
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
			opts.tools ? opts.tools.join(",") : "read,edit,write,bash,ls,grep,find",
		];
		if (this.model) args.push("--model", this.model);
		if (opts.system?.trim()) {
			promptPath = path.join(auditDir, `system.a${attempt}.md`);
			writeText(promptPath, opts.system);
			args.push("--append-system-prompt", promptPath);
		}
		args.push("--", mission);

		const invocation = getPiInvocation(args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: contextDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, HARNESS2_PROPOSER: "1" },
		});
		registerChild(child);

		let buffer = "";
		let stderr = "";
		let finalText = "";
		let cost = 0;
		let aborted = false;
		const onLine = (line: string) => {
			if (!line.trim()) return;
			stream.write(`${line}\n`);
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message?.role === "assistant") {
					cost += event.message.usage?.cost?.total ?? 0;
					const text = Array.isArray(event.message.content)
						? event.message.content
								.filter((p: any) => p?.type === "text")
								.map((p: any) => String(p.text ?? ""))
								.join("\n")
						: "";
					if (text.trim()) finalText = text;
				}
			} catch {
				/* ignore malformed line */
			}
		};
		child.stdout?.on("data", (data: Buffer) => {
			buffer += data.toString("utf8");
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) onLine(line.replace(/\r$/, ""));
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString("utf8");
			if (stderr.length > 100_000) stderr = stderr.slice(-100_000);
		});

		const timeout = setTimeout(() => {
			aborted = true;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!child.killed) child.kill("SIGKILL");
			}, 5_000).unref?.();
		}, opts.timeoutMs ?? this.cfg.proposerTimeoutMs);
		const onAbort = () => {
			aborted = true;
			child.kill("SIGTERM");
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		const code = await new Promise<number>((resolve) => {
			child.on("close", (c) => {
				if (buffer.trim()) onLine(buffer.replace(/\r$/, ""));
				resolve(c ?? 0);
			});
			child.on("error", () => resolve(1));
		});
		clearTimeout(timeout);
		opts.signal?.removeEventListener("abort", onAbort);
		await new Promise<void>((resolve) => stream.end(resolve));

		writeText(path.join(auditDir, `reply.a${attempt}.txt`), finalText);
		writeText(path.join(auditDir, `stderr.a${attempt}.txt`), stderr);
		if (finalText.trim()) {
			return { ok: true, text: finalText, error: "", costUsd: cost, eventsPath };
		}
		return {
			ok: false,
			text: "",
			error: aborted
				? "editor session aborted or timed out"
				: `editor exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(-600)}` : ""}`,
			costUsd: cost,
			eventsPath,
		};
	}

	private readCache(cacheDir: string, label: string): Reply | undefined {
		const meta = path.join(cacheDir, "reply.json");
		if (!fs.existsSync(meta)) return undefined;
		const data = readJson<CachedReply | undefined>(meta, undefined);
		if (!data?.text?.trim()) return undefined;
		return {
			label,
			text: data.text,
			ok: true,
			costUsd: 0,
			wallS: 0,
			attempts: data.attempts ?? 0,
			cached: true,
			error: "",
			workspace: path.join(cacheDir, "harness"),
		};
	}

	private writeCache(cacheDir: string, reply: Reply, workspace: string | undefined): void {
		ensureDir(cacheDir);
		writeJson(path.join(cacheDir, "reply.json"), {
			text: reply.text,
			costUsd: reply.costUsd,
			wallS: reply.wallS,
			attempts: reply.attempts,
		});
		if (workspace && isDir(workspace)) {
			fs.rmSync(path.join(cacheDir, "harness"), { recursive: true, force: true });
			copyDir(workspace, path.join(cacheDir, "harness"));
		}
	}
}

function safeLabel(label: string): string {
	return label.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

export function readReplyNotes(text: string): string {
	const m = /<notes>([\s\S]*?)<\/notes>/i.exec(text);
	return (m ? m[1] : text).trim();
}

export function parseFenced(text: string, tag: string): string {
	const m = new RegExp("```" + tag + "\\s*([\\s\\S]*?)```", "i").exec(text);
	return (m ? m[1] : "").trim();
}

export function parseTag(text: string, tag: string): string {
	const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(text);
	return (m ? m[1] : "").trim();
}

export function visibleTree(dir: string): string[] {
	return listFilesRecursive(dir).map((f) => relPosix(dir, f));
}
