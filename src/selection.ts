/**
 * Blind selection over candidate deliverables.
 *
 * Port of `core/selection.py`. Candidate ids are shuffled and anonymous; the
 * selector never sees a harness or a score. With one final this is trivial and
 * spends no session.
 *
 * If the task declares a deterministic `verify` command, only candidates that
 * pass it enter the selector pool. Verification is a selection signal only: it
 * is never written into the trajectory evidence the editors see.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { H2Config, SelectionResult, TaskSpec, VerifyResult } from "./types.ts";
import { Proposer, parseFenced } from "./proposer.ts";
import { buildSelectionContext } from "./context.ts";
import { profileOf, select } from "./prompts.ts";
import { copyDir, readText, rmrf, truncate } from "./util.ts";
import { verificationGate } from "./verify-gate.ts";

export interface SelectOptions {
	cfg: H2Config;
	task: TaskSpec;
	runDir: string;
	finals: Array<{ label: string; deliverableTextPath: string; verify?: VerifyResult }>;
	proposer: Proposer;
	signal?: AbortSignal;
	ask?: (title: string, options: string[]) => Promise<string | undefined>;
	onProgress?: (message: string) => void;
}

interface Candidate {
	id: string;
	label: string;
	text: string;
	verify?: VerifyResult;
}

function shuffle<T>(items: T[], seed: number | undefined): T[] {
	const out = [...items];
	let s = (seed ?? 1) >>> 0;
	const rnd = () => {
		s += 0x6d2b79f5;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function verificationBlock(v: VerifyResult): string {
	return [
		"## Verification",
		"",
		`- command: \`${v.command}\``,
		`- result: ${v.ok ? "PASS" : v.timedOut ? "FAIL (timed out)" : "FAIL"}`,
		`- exit code: ${v.exitCode}`,
		"",
		"```text",
		truncate([v.stdout, v.stderr].filter(Boolean).join("\n"), 8_000) || "(no output)",
		"```",
		"",
	].join("\n");
}

export async function runSelection(opts: SelectOptions): Promise<SelectionResult> {
	const { cfg, task, finals, runDir } = opts;
	if (!finals.length) {
		return {
			ok: false,
			chosenLabel: "",
			chosenId: "",
			reason: "",
			cost: 0,
			pools: [],
			error: "no finals were produced",
		};
	}

	const candidates: Candidate[] = shuffle(
		finals.map((f) => ({ label: f.label, text: readText(f.deliverableTextPath, "(no deliverable produced)"), verify: f.verify })),
		cfg.seed,
	).map((c, i) => ({ ...c, id: `c${i + 1}` }));
	const poolsAll = candidates.map((x) => ({ id: x.id, label: x.label }));

	const gate = verificationGate(candidates);
	const { pool, gated, hasVerification, passing, failing } = gate;
	const verified = hasVerification ? { gated, passing, failing } : undefined;

	if (pool.length === 1) {
		const c = pool[0];
		return {
			ok: true,
			chosenLabel: c.label,
			chosenId: c.id,
			reason: hasVerification
				? passing.length === 1
					? "only candidate that passed the verification command"
					: "only candidate"
				: "only one final candidate",
			cost: 0,
			pools: poolsAll,
			error: "",
			verified,
		};
	}

	if (cfg.select === "first") {
		const c = pool[0];
		return {
			ok: true,
			chosenLabel: c.label,
			chosenId: c.id,
			reason: hasVerification ? "selection set to first (verification-gated)" : "selection set to first",
			cost: 0,
			pools: poolsAll,
			error: "",
			verified,
		};
	}

	if (cfg.select === "ask" && opts.ask) {
		const picked = await opts.ask(
			"Harness²: choose the final to adopt",
			pool.map((c) => `${c.id} — ${c.label}`),
		);
		const id = picked?.split(" ")[0];
		const c = pool.find((x) => x.id === id);
		if (c) {
			return {
				ok: true,
				chosenLabel: c.label,
				chosenId: c.id,
				reason: "chosen by the user",
				cost: 0,
				pools: poolsAll,
				error: "",
				verified,
			};
		}
	}

	const renderedPool = pool.map((c) => ({
		id: c.id,
		label: c.label,
		text: c.verify ? `${verificationBlock(c.verify)}\n\n${c.text}` : c.text,
	}));
	const selectionRoot = path.join(runDir, "selection");
	const selectionDir = path.join(selectionRoot, "context");
	buildSelectionContext(selectionDir, task, renderedPool);
	opts.onProgress?.(
		`selector: comparing ${renderedPool.length} final${renderedPool.length === 1 ? "" : "s"}${
			gated ? ` (${failing.length} failed verification)` : ""
		}`,
	);
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness2-select-"));
	copyDir(selectionDir, path.join(tempRoot, "context"));
	let reply: Awaited<ReturnType<Proposer["call"]>>;
	try {
		reply = await opts.proposer.call(
			select(profileOf(task), renderedPool.length),
			tempRoot,
			"select",
			{
				tools: ["read", "ls", "grep"],
				harvest: null,
				signal: opts.signal,
				onProgress: opts.onProgress,
			},
		);
	} finally {
		rmrf(tempRoot);
	}
	if (!reply.ok) {
		return {
			ok: false,
			chosenLabel: "",
			chosenId: "",
			reason: "",
			cost: reply.costUsd,
			pools: poolsAll,
			error: reply.error || "selector session failed",
			verified,
		};
	}
	const parsed = parseFenced(reply.text, "choice");
	const chosen =
		pool.find((c) => c.id === parsed) ??
		pool.find((c) => new RegExp(`\\b${c.id}\\b`).test(reply.text));
	if (!chosen) {
		return {
			ok: false,
			chosenLabel: "",
			chosenId: "",
			reason: reply.text.slice(-2000),
			cost: reply.costUsd,
			pools: poolsAll,
			error: `selector did not return a valid candidate id (got ${JSON.stringify(parsed)})`,
			verified,
		};
	}
	const why = /<why>([\s\S]*?)<\/why>/i.exec(reply.text)?.[1]?.trim() ?? "";
	return {
		ok: true,
		chosenLabel: chosen.label,
		chosenId: chosen.id,
		reason: why || reply.text.slice(-2000),
		cost: reply.costUsd,
		pools: poolsAll,
		error: "",
		verified,
	};
}
