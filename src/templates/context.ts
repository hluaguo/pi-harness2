/**
 * Template copied into an exported harness package.
 *
 * It is not loaded by this extension. At runtime it reads the package's
 * always-on.md and appends it to every request, replacing discovered AGENTS.md
 * context so the same instructions do not appear twice.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harnessDir = path.join(pkgDir, "harness");

function readAlwaysOn(): string {
	try {
		return fs.readFileSync(path.join(pkgDir, "always-on.md"), "utf8").trim();
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	const alwaysOn = readAlwaysOn();
	const block = [
		"# HARNESS (Harness² export)",
		"",
		alwaysOn,
		"",
		"# HARNESS LOCATION",
		"",
		`This harness lives at \`${harnessDir}\`. Scripts, when present, are under \`${harnessDir}/scripts/\`; run them by absolute path.`,
	]
		.filter((part) => part !== "")
		.join("\n");

	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		// The package owns the always-on layer; do not duplicate AGENTS.md.
		options.contextFiles = [];
		options.appendSystemPrompt = options.appendSystemPrompt?.trim()
			? `${options.appendSystemPrompt.trimEnd()}\n\n${block}`
			: block;
	});
}
