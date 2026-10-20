#!/usr/bin/env node
/**
 * A stand-in for the `pi` executable used by probe tests.
 *
 * It accepts the subset of CLI flags this repository passes, runs a real Pi
 * agent session against pi-ai's faux provider, and writes the same JSON event
 * stream the CLI writes. Set HARNESS2_FAUX_FILE and HARNESS2_FAUX_CONTENT to
 * script a write tool call.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

function flagValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const separator = process.argv.indexOf("--");
const prompt = separator >= 0 ? (process.argv[separator + 1] ?? "") : "";
const appendPath = flagValue("--append-system-prompt");
const append = appendPath && fs.existsSync(appendPath) ? fs.readFileSync(appendPath, "utf8") : "";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-faux-agent-"));
process.on("exit", () => fs.rmSync(agentDir, { recursive: true, force: true }));

const faux = fauxProvider();
const modelRuntime = await ModelRuntime.create({
	modelsPath: null,
	refreshOnCreate: false,
	allowModelNetwork: false,
});
modelRuntime.registerNativeProvider(faux.provider);

const resourceLoader: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => "You are a test worker. Complete the task with the tools you have.",
	getSystemPromptSource: () => undefined,
	getAppendSystemPrompt: () => (append ? [append] : []),
	getAppendSystemPromptSources: () => (appendPath ? [{ path: appendPath }] : []),
	extendResources: () => {},
	reload: async () => {},
};

const cwd = process.cwd();
const { session } = await createAgentSession({
	cwd,
	agentDir,
	model: faux.getModel(),
	thinkingLevel: "off",
	modelRuntime,
	resourceLoader,
	tools: ["write"],
	sessionManager: SessionManager.inMemory(cwd),
	settingsManager: SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	}),
});

const file = process.env.HARNESS2_FAUX_FILE;
const content = process.env.HARNESS2_FAUX_CONTENT ?? "";
faux.setResponses(
	file
		? [
				fauxAssistantMessage(
					[fauxToolCall("write", { path: file, content })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(`Wrote ${file}.`),
			]
		: [fauxAssistantMessage("Done.")],
);

session.subscribe((event) => {
	process.stdout.write(`${JSON.stringify(event)}\n`);
});

try {
	await session.prompt(prompt);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
} finally {
	session.dispose();
}
