/**
 * Blind selection over candidate deliverables.
 *
 * Port of `core/selection.py`. Candidate ids are shuffled and anonymous; the
 * selector never sees a harness or a score. With one final this is trivial and
 * spends no session.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { H2Config, SelectionResult, TaskSpec } from "./types.ts";
import { Proposer, parseFenced } from "./proposer.ts";
import { buildSelectionContext } from "./context.ts";
import { profileOf, select } from "./prompts.ts";
import { copyDir, readText, rmrf } from "./util.ts";

export interface SelectOptions {
	cfg: H2Config;
	task: TaskSpec;
	runDir: string;
	finals: Array<{ label: string; deliverableTextPath: string }>;
	proposer: Proposer;
	signal?: AbortSignal;
	ask?: (title: string, options: string[]) => Promise<string | undefined>;
	onProgress?: (message: string) => void;
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
	const candidates = shuffle(
		finals.map((f) => ({
			label: f.label,
			text: readText(f.deliverableTextPath, "(no deliverable produced)"),
		})),
		cfg.seed,
	).map((c, i) => ({ ...c, id: `c${i + 1}` }));

	if (candidates.length === 1 || cfg.select === "first") {
		const c = candidates[0];
		return {
			ok: true,
			chosenLabel: c.label,
			chosenId: c.id,
			reason: candidates.length === 1 ? "only one final candidate" : "selection set to first",
			cost: 0,
			pools: candidates.map((x) => ({ id: x.id, label: x.label })),
			error: "",
		};
	}

	if (cfg.select === "ask" && opts.ask) {
		const picked = await opts.ask(
			"Harness²: choose the final to adopt",
			candidates.map((c) => `${c.id} — ${c.label}`),
		);
		const id = picked?.split(" ")[0];
		const c = candidates.find((x) => x.id === id);
		if (c) {
			return {
				ok: true,
				chosenLabel: c.label,
				chosenId: c.id,
				reason: "chosen by the user",
				cost: 0,
				pools: candidates.map((x) => ({ id: x.id, label: x.label })),
				error: "",
			};
		}
	}

	const selectionRoot = path.join(runDir, "selection");
	const selectionDir = path.join(selectionRoot, "context");
	buildSelectionContext(selectionDir, task, candidates);
	opts.onProgress?.(`selector: comparing ${candidates.length} finals`);
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness2-select-"));
	copyDir(selectionDir, path.join(tempRoot, "context"));
	let reply;
	try {
		reply = await opts.proposer.call(
			select(profileOf(task), candidates.length),
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
			pools: candidates.map((x) => ({ id: x.id, label: x.label })),
			error: reply.error || "selector session failed",
		};
	}
	const parsed = parseFenced(reply.text, "choice");
	const chosen =
		candidates.find((c) => c.id === parsed) ??
		candidates.find((c) => new RegExp(`\\b${c.id}\\b`).test(reply.text));
	if (!chosen) {
		return {
			ok: false,
			chosenLabel: "",
			chosenId: "",
			reason: reply.text.slice(-2000),
			cost: reply.costUsd,
			pools: candidates.map((x) => ({ id: x.id, label: x.label })),
			error: `selector did not return a valid candidate id (got ${JSON.stringify(parsed)})`,
		};
	}
	const why = /<why>([\s\S]*?)<\/why>/i.exec(reply.text)?.[1]?.trim() ?? "";
	return {
		ok: true,
		chosenLabel: chosen.label,
		chosenId: chosen.id,
		reason: why || reply.text.slice(-2000),
		cost: reply.costUsd,
		pools: candidates.map((x) => ({ id: x.id, label: x.label })),
		error: "",
	};
}
