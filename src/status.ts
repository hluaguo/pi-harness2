/** Footer status + in-run progress widget for Harness². */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { H2Config, Mode } from "./types.ts";
import { readActive } from "./active.ts";
import { truncate } from "./util.ts";

export interface RunStatus {
	taskId: string;
	mode: Mode;
	k: number;
	phase: string;
	fraction: number;
	startedAt: number;
}

const KEY = "harness2";
const WIDGET_KEY = "harness2-run";

function clock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function bar(theme: ExtensionContext["ui"]["theme"], fraction: number, width = 18): string {
	const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
	const filled = Math.round(pct * width);
	return (
		theme.fg("accent", "█".repeat(filled)) +
		theme.fg("dim", "░".repeat(Math.max(0, width - filled)))
	);
}

export function setIdleStatus(ctx: ExtensionContext, cfg: H2Config): void {
	const active = readActive(cfg);
	if (active) {
		ctx.ui.setStatus(
			KEY,
			`${ctx.ui.theme.fg("accent", "H² active")} ${ctx.ui.theme.fg("dim", `${active.taskId}/${active.label}`)}`,
		);
		return;
	}
	ctx.ui.setStatus(KEY, ctx.ui.theme.fg("dim", "H² ready"));
}

export function updateRunStatus(ctx: ExtensionContext, status: RunStatus): void {
	const theme = ctx.ui.theme;
	const pct = Math.round(Math.max(0, Math.min(1, status.fraction)) * 100);
	const phase = truncate(status.phase.replace(/\s+/g, " "), 72);
	const elapsed = clock(Date.now() - status.startedAt);

	ctx.ui.setStatus(
		KEY,
		`${theme.fg("accent", "H²")} ${theme.fg("dim", `${status.mode} k=${status.k}`)} ${theme.fg("accent", `${pct}%`)} ${theme.fg("dim", phase)}`,
	);

	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget(
		WIDGET_KEY,
		[
			`${theme.bold(theme.fg("accent", "Harness²"))} ${theme.fg("dim", `${status.taskId} · ${status.mode} k=${status.k}`)}`,
			`${bar(theme, status.fraction)} ${theme.fg("accent", `${String(pct).padStart(3)}%`)}  ${theme.fg("dim", `elapsed ${elapsed}`)}`,
			theme.fg("muted", phase),
		],
		{ placement: "aboveEditor" },
	);
}

export function clearRunWidget(ctx: ExtensionContext): void {
	if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
}

export function setFailedStatus(ctx: ExtensionContext, message: string): void {
	clearRunWidget(ctx);
	ctx.ui.setStatus(
		KEY,
		ctx.ui.theme.fg("error", truncate(`H² failed: ${message.replace(/\s+/g, " ")}`, 100)),
	);
}
