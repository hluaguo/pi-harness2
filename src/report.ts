/** Local run reports: result.json plus a human-readable report.md. */

import fs from "node:fs";
import path from "node:path";
import type { H2Config, TaskSpec, Tree } from "./types.ts";
import type { RefineResult } from "./recursion.ts";
import { diffSummary, inventory, alwaysOnText } from "./tree.ts";
import { unifiedDiff } from "./diff.ts";
import { timestamp, writeJson, writeText } from "./util.ts";

export function writeRunConfig(
	runDir: string,
	cfg: H2Config,
	task: TaskSpec,
	runId: string,
	baseTree: Tree,
): void {
	writeJson(path.join(runDir, "run.json"), {
		runId,
		createdAt: new Date().toISOString(),
		task: { id: task.id, domain: task.domain, deliverables: task.deliverables },
		config: {
			mode: cfg.mode,
			k: cfg.k,
			seed: cfg.seed,
			model: cfg.model,
			improverModel: cfg.improverModel,
			selectorModel: cfg.selectorModel,
			concurrency: cfg.concurrency,
			alwaysOnMax: cfg.alwaysOnMax,
			obsTrunc: cfg.obsTrunc,
			libraryScope: cfg.libraryScope,
			reflect: cfg.reflect,
		},
		baseHarness: inventory(baseTree),
	});
}

export function writeReport(
	runDir: string,
	cfg: H2Config,
	task: TaskSpec,
	runId: string,
	baseTree: Tree,
	result: RefineResult,
): string {
	const { modeResult, selection, adoptedLabel, adoptedTree, costs, errors } = result;
	const diff = diffSummary(baseTree, adoptedTree);
	const allRuns = new Map<string, (typeof result.baseRuns)[number]>();
	for (const run of [...result.baseRuns, ...Object.values(modeResult.rollouts)]) allRuns.set(run.label, run);
	const stageRows = modeResult.stages
		.map(
			(s) =>
				`| \`${s.label}\` | ${s.dim} | ${s.fellBack ? "FELL BACK" : s.keptBase ? "KEEP_BASE" : "changed"} | ${s.cached ? "cached" : "fresh"} | $${s.usd.toFixed(4)} | ${s.error ? s.error.replace(/\|/g, "\\|").slice(0, 160) : ""} |`,
		)
		.join("\n");
	const rolloutRows = [...allRuns.values()]
		.map(
			(r) =>
				`| \`${r.label}\` | ${r.ok ? "ok" : "failed"} | ${r.delivered ? "yes" : "no"} | ${r.changedFiles.length} | ${r.usage.turns} | $${r.usage.cost.toFixed(4)} | ${r.error ? r.error.replace(/\|/g, "\\|").slice(0, 120) : ""} |`,
		)
		.join("\n");
	const diffText = Object.keys({ ...baseTree, ...adoptedTree })
		.sort()
		.map((rel) =>
			unifiedDiff(baseTree[rel] ?? "", adoptedTree[rel] ?? "", `base/${rel}`, `adopted/${rel}`),
		)
		.filter(Boolean)
		.join("\n");

	const md = [
		`# Harness² run \`${runId}\``,
		"",
		`- created: ${timestamp()}`,
		`- task: \`${task.id}\` (domain: \`${task.domain}\`)`,
		`- mode: \`${cfg.mode}\`, k = ${cfg.k}`,
		`- solver model: \`${cfg.model ?? "current"}\``,
		`- improver model: \`${cfg.improverModel ?? cfg.model ?? "current"}\``,
		`- costs recorded: $${costs.toFixed(4)}`,
		`- adopted: \`${adoptedLabel || "(none)"}\``,
		"",
		"## The work",
		"",
		"> " + task.prompt.trim().replace(/\n/g, "\n> "),
		"",
		"## Base probes",
		"",
		"| label | ok | delivered | changed files | turns | cost | error |",
		"|---|---|---|---|---|---|---|",
		rolloutRows,
		"",
		"## Improvement stages",
		"",
		"| label | dim | state | source | cost | error |",
		"|---|---|---|---|---|---|",
		stageRows,
		"",
		"## Candidate diversity",
		"",
		`- finals: ${modeResult.similarity.n}`,
		`- distinct trees: ${modeResult.similarity.nDistinct}`,
		`- mean pairwise line Jaccard: ${modeResult.similarity.meanLineJaccard}`,
		"",
		"## Selection",
		"",
		`- chosen: \`${selection.chosenLabel || "(none)"}\`` +
			(selection.chosenId ? ` (anonymous id \`${selection.chosenId}\`)` : ""),
		`- ok: ${selection.ok}`,
		`- cost: $${selection.cost.toFixed(4)}`,
		...(selection.error ? [`- error: ${selection.error}`] : []),
		"",
		"```text",
		selection.reason || "(no reason returned)",
		"```",
		"",
		"## Adopted harness",
		"",
		`- ${inventory(adoptedTree)}`,
		`- always-on: ${alwaysOnText(adoptedTree).length.toLocaleString()} chars`,
		`- added: ${diff.added.length ? diff.added.map((x) => `\`${x}\``).join(", ") : "(none)"}`,
		`- removed: ${diff.removed.length ? diff.removed.map((x) => `\`${x}\``).join(", ") : "(none)"}`,
		`- modified: ${diff.modified.length ? diff.modified.map((x) => `\`${x}\``).join(", ") : "(none)"}`,
		"",
		diffText
			? `### Diff against base\n\n\`\`\`diff\n${diffText}\n\`\`\``
			: "_The adopted harness is identical to the base._",
		"",
		...(result.libraryEntry
			? ["## Library", "", `- entry: \`${result.libraryEntry}\``, ""]
			: []),
		...(result.reflection
			? ["## Reflection", "", "```text", result.reflection.trim(), "```", ""]
			: []),
		...(errors.length
			? ["## Errors", "", ...errors.map((e) => `- ${e}`), ""]
			: []),
		"## Paths",
		"",
		`- run: \`${runDir}\``,
		`- adopted tree: \`${path.join(runDir, "adopted", "harness")}\``,
		`- selection evidence: \`${path.join(runDir, "selection", "context")}\``,
		"",
	].join("\n");
	const report = path.join(runDir, "report.md");
	writeText(report, md);
	writeJson(path.join(runDir, "result.json"), {
		runId,
		createdAt: new Date().toISOString(),
		task: { id: task.id, domain: task.domain, prompt: task.prompt },
		config: {
			mode: cfg.mode,
			k: cfg.k,
			seed: cfg.seed,
			model: cfg.model,
			improverModel: cfg.improverModel,
			selectorModel: cfg.selectorModel,
		},
		modeResult: {
			mode: modeResult.mode,
			finals: modeResult.finals,
			base: modeResult.base,
			similarity: modeResult.similarity,
			stages: modeResult.stages.map((s) => ({
				label: s.label,
				dim: s.dim,
				keptBase: s.keptBase,
				fellBack: s.fellBack,
				attempts: s.attempts,
				cached: s.cached,
				usd: s.usd,
				wallS: s.wallS,
				error: s.error,
				notes: s.notes,
			})),
		},
		rollouts: Object.fromEntries(
			[...allRuns.values()].map((r) => [
				r.label,
				{
					ok: r.ok,
					delivered: r.delivered,
					exitCode: r.exitCode,
					changedFiles: r.changedFiles,
					usage: r.usage,
					wallS: r.wallS,
					model: r.model,
					error: r.error,
					paths: {
						events: r.eventsPath,
						trajectory: r.trajectoryPath,
						deliverable: r.deliverableTextPath,
					},
				},
			]),
		),
		selection: {
			ok: selection.ok,
			chosenLabel: selection.chosenLabel,
			chosenId: selection.chosenId,
			reason: selection.reason,
			cost: selection.cost,
			error: selection.error,
			pools: selection.pools,
		},
		adopted: {
			label: adoptedLabel,
			treeDir: path.join(runDir, "adopted", "harness"),
			inventory: inventory(adoptedTree),
			diff,
		},
		costs,
		errors,
		libraryEntry: result.libraryEntry ?? null,
		reflection: result.reflection,
		reportPath: report,
	});
	return report;
}

export function latestRun(runsRoot: string): string | undefined {
	try {
		const dirs = fs
			.readdirSync(runsRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => path.join(runsRoot, e.name))
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return dirs[0];
	} catch {
		return undefined;
	}
}
