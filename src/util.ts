/** Small filesystem, process, hash, and concurrency helpers. */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export function ensureDir(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function readText(file: string, fallback = ""): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return fallback;
	}
}

export function writeText(file: string, text: string): void {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, text, "utf8");
}

export function writeJson(file: string, value: unknown): void {
	writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

export function rmrf(target: string): void {
	fs.rmSync(target, { recursive: true, force: true });
}

export function exists(file: string): boolean {
	return fs.existsSync(file);
}

export function isDir(file: string): boolean {
	try {
		return fs.statSync(file).isDirectory();
	} catch {
		return false;
	}
}

export function listDirs(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
	} catch {
		return [];
	}
}

export function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) out.push(p);
		}
	};
	if (isDir(dir)) walk(dir);
	return out.sort();
}

export function relPosix(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join("/");
}

export function safeJoin(root: string, rel: string): string {
	const normalized = rel.replace(/\\/g, "/").replace(/^\.\/+/, "");
	if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
		throw new Error(`path escapes root: ${rel}`);
	}
	const out = path.resolve(root, normalized);
	if (out !== path.resolve(root) && !out.startsWith(`${path.resolve(root)}${path.sep}`)) {
		throw new Error(`path escapes root: ${rel}`);
	}
	return out;
}

export interface CopyFilter {
	(src: string, rel: string): boolean;
}

export function copyDir(src: string, dest: string, filter?: CopyFilter): number {
	if (!isDir(src)) return 0;
	let n = 0;
	const walk = (from: string, to: string, rel: string) => {
		const entries = fs.readdirSync(from, { withFileTypes: true });
		ensureDir(to);
		for (const e of entries) {
			const childRel = rel ? `${rel}/${e.name}` : e.name;
			if (filter && !filter(path.join(from, e.name), childRel)) continue;
			const a = path.join(from, e.name);
			const b = path.join(to, e.name);
			if (e.isDirectory()) walk(a, b, childRel);
			else if (e.isFile()) {
				fs.copyFileSync(a, b);
				n++;
			} else if (e.isSymbolicLink()) {
				try {
					fs.copyFileSync(fs.realpathSync(a), b);
					n++;
				} catch {
					/* ignore broken links */
				}
			}
		}
	};
	walk(src, dest, "");
	return n;
}

export function writeTreeFiles(tree: Record<string, string>, dest: string): void {
	for (const [rel, body] of Object.entries(tree)) writeText(safeJoin(dest, rel), body);
}

export function isProbablyText(buf: Buffer): boolean {
	if (buf.length === 0) return true;
	const sample = buf.subarray(0, Math.min(buf.length, 4096));
	for (const b of sample) if (b === 0) return false;
	return true;
}

export function truncate(text: string, max: number, marker = "…[truncated]"): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function hashDir(dir: string): string {
	const h = createHash("sha256");
	for (const file of listFilesRecursive(dir)) {
		h.update(relPosix(dir, file));
		h.update("\0");
		h.update(fs.readFileSync(file));
		h.update("\0");
	}
	return h.digest("hex");
}

export function slugify(value: string, fallback = "item"): string {
	const s = value
		.toLowerCase()
		.replace(/[/\\]+/g, "__")
		.replace(/[^a-z0-9_.-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return s || fallback;
}

export function timestamp(): string {
	const d = new Date();
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface ProcResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function run(
	command: string,
	args: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {},
): ProcResult {
	const p = spawnSync(command, args, {
		cwd: opts.cwd,
		env: opts.env ?? process.env,
		input: opts.input,
		encoding: "utf8",
		timeout: opts.timeoutMs,
		maxBuffer: 64 * 1024 * 1024,
	});
	return {
		code: p.status ?? (p.error ? 1 : 0),
		stdout: p.stdout ?? "",
		stderr: p.stderr ?? String(p.error ?? ""),
	};
}

export interface ShellResult {
	code: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
}

/** Run a user-supplied shell command with a timeout and capped output. */
export function runShell(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ShellResult> {
	const started = Date.now();
	const isWindows = process.platform === "win32";
	const shell = isWindows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
	const args = isWindows ? ["/d", "/s", "/c", command] : ["-lc", command];
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const child = spawn(shell, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			}, 5_000).unref?.();
		}, timeoutMs);
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (code: number, error = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({
				code,
				stdout: truncate(stdout, 100_000),
				stderr: truncate(`${stderr}${error ? `\n${error}` : ""}`, 100_000),
				durationMs: Date.now() - started,
				timedOut,
			});
		};
		child.stdout?.on("data", (d: Buffer) => {
			if (stdout.length < 120_000) stdout += d.toString("utf8");
		});
		child.stderr?.on("data", (d: Buffer) => {
			if (stderr.length < 120_000) stderr += d.toString("utf8");
		});
		child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
		child.on("error", (err) => finish(1, `${err.name}: ${err.message}`));
	});
}

export async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const width = Math.max(1, Math.min(limit, items.length));
	const out = Array.from({ length: items.length }, () => undefined as R);
	let next = 0;
	const workers = Array.from({ length: width }, async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const explicit = process.env.HARNESS2_PI_BIN;
	if (explicit?.trim()) return { command: explicit.trim(), args };
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

export interface ParsedFrontmatter {
	frontmatter: Record<string, unknown>;
	body: string;
}

export function frontmatter(content: string): ParsedFrontmatter {
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(content);
		return { frontmatter: parsed.frontmatter ?? {}, body: parsed.body ?? content };
	} catch {
		return { frontmatter: {}, body: content };
	}
}

export function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function asStringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
	if (typeof value === "string") {
		return value
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean);
	}
	return [];
}
