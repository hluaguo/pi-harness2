/** Configuration: defaults, environment overrides, and per-invocation overrides. */

import path from "node:path";
import type { H2Config, Mode } from "./types.ts";

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback = false): boolean {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	return /^(1|true|yes|on)$/i.test(raw);
}

function envString(name: string): string | undefined {
	const raw = process.env[name];
	return raw && raw.trim() ? raw.trim() : undefined;
}

export function normalizeMode(value: string | undefined): Mode {
	const v = String(value ?? "parallel").toLowerCase();
	if (v === "parallel" || v === "agg") return "parallel";
	if (v === "sequential" || v === "seq") return "sequential";
	throw new Error(`unknown mode ${JSON.stringify(value)}; expected parallel or sequential`);
}

export function loadConfig(cwd: string, overrides: Partial<H2Config> = {}): H2Config {
	const home = path.resolve(cwd, envString("HARNESS2_HOME") ?? ".harness2");
	const seedRaw = envString("HARNESS2_SEED");
	const seed = seedRaw !== undefined ? Number.parseInt(seedRaw, 10) : undefined;
	const mode = normalizeMode(overrides.mode ?? envString("HARNESS2_MODE"));
	const model = overrides.model ?? envString("HARNESS2_MODEL");
	const improver = overrides.improverModel ?? envString("HARNESS2_IMPROVER_MODEL");
	const kRaw = overrides.k ?? envInt("HARNESS2_K", 1);
	const k = Number.isFinite(kRaw) ? Math.floor(kRaw) : 1;
	const concurrencyRaw = overrides.concurrency ?? envInt("HARNESS2_CONCURRENCY", 2);
	const concurrency = Number.isFinite(concurrencyRaw) ? Math.floor(concurrencyRaw) : 2;

	return {
		cwd,
		home,
		runsRoot: path.join(home, "runs"),
		tasksRoot: path.join(home, "tasks"),
		libraryRoot: path.join(home, "library"),
		baseDir: path.join(home, "base"),
		adoptedRoot: path.join(home, "adopted"),
		activePath: path.join(home, "active.json"),
		k: Math.max(1, Math.min(8, k)),
		mode,
		seed: overrides.seed ?? (Number.isFinite(seed) ? seed : undefined),
		model,
		improverModel: improver,
		selectorModel: overrides.selectorModel ?? envString("HARNESS2_SELECTOR_MODEL") ?? improver,
		thinking: overrides.thinking,
		concurrency: Math.max(1, Math.min(8, concurrency)),
		rolloutTimeoutMs: overrides.rolloutTimeoutMs ?? envInt("HARNESS2_ROLLOUT_TIMEOUT", 1800) * 1000,
		proposerTimeoutMs:
			overrides.proposerTimeoutMs ?? envInt("HARNESS2_PROPOSER_TIMEOUT", 3600) * 1000,
		obsTrunc: Math.max(10_000, overrides.obsTrunc ?? envInt("HARNESS2_OBS_TRUNC", 50_000)),
		alwaysOnMax: Math.max(
			1_000,
			overrides.alwaysOnMax ?? envInt("HARNESS2_ALWAYS_ON_MAX", 16_000),
		),
		keepWorkspaces: overrides.keepWorkspaces ?? envBool("HARNESS2_KEEP_WORKSPACES", false),
		workspaceCopy: overrides.workspaceCopy ?? envBool("HARNESS2_WORKSPACE_COPY", false),
		libraryScope:
			(overrides.libraryScope ?? envString("HARNESS2_LIBRARY_SCOPE")) === "run"
				? "run"
				: "shared",
		reflect: overrides.reflect ?? !envBool("HARNESS2_NO_REFLECT", false),
		select: overrides.select ?? "auto",
		proposerAttempts: Math.max(1, overrides.proposerAttempts ?? envInt("HARNESS2_PROPOSER_ATTEMPTS", 2)),
		transportAttempts: Math.max(
			1,
			overrides.transportAttempts ?? envInt("HARNESS2_TRANSPORT_ATTEMPTS", 2),
		),
		verifyTimeoutMs: overrides.verifyTimeoutMs ?? envInt("HARNESS2_VERIFY_TIMEOUT", 600) * 1000,
		earlyStop: overrides.earlyStop ?? envBool("HARNESS2_EARLY_STOP", false),
	};
}

export function modelArgFromContext(model: { provider?: string; id?: string } | undefined): string | undefined {
	if (!model?.provider || !model.id) return undefined;
	return `${model.provider}/${model.id}`;
}
