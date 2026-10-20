import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { runProbe } from "../src/runner.ts";
import { writeTree } from "../src/tree.ts";
import type { TaskSpec, Tree } from "../src/types.ts";
import { createWorkspace, removeWorkspace } from "../src/workspace.ts";

test("runProbe records a faux agent's file as the deliverable", async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-probe-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));

	const project = path.join(root, "project");
	fs.mkdirSync(project);
	fs.writeFileSync(path.join(project, "README.md"), "demo\n");

	const tree: Tree = {
		"systemprompt.md": "You are a test worker. Complete the task with the tools you have.",
		"guardrails.md": "",
		"LongTermMEMORY.md": "",
		"tool_descriptions/tool_guidance.md": "",
	};
	const harnessDir = path.join(root, "harness");
	writeTree(tree, harnessDir);

	const cfg = loadConfig(project, { workspaceCopy: true, rolloutTimeoutMs: 30_000 });
	const workspace = createWorkspace(project, path.join(root, "workspace"), cfg);
	t.after(() => removeWorkspace(workspace));

	const oldBin = process.env.HARNESS2_PI_BIN;
	const oldFile = process.env.HARNESS2_FAUX_FILE;
	const oldContent = process.env.HARNESS2_FAUX_CONTENT;
	process.env.HARNESS2_PI_BIN = fileURLToPath(new URL("./support/pi-faux.ts", import.meta.url));
	process.env.HARNESS2_FAUX_FILE = "hello.txt";
	process.env.HARNESS2_FAUX_CONTENT = "hello harness2\n";
	t.after(() => {
		if (oldBin === undefined) delete process.env.HARNESS2_PI_BIN;
		else process.env.HARNESS2_PI_BIN = oldBin;
		if (oldFile === undefined) delete process.env.HARNESS2_FAUX_FILE;
		else process.env.HARNESS2_FAUX_FILE = oldFile;
		if (oldContent === undefined) delete process.env.HARNESS2_FAUX_CONTENT;
		else process.env.HARNESS2_FAUX_CONTENT = oldContent;
	});

	const task: TaskSpec = {
		id: "hello",
		prompt: "Create a file named hello.txt containing exactly: hello harness2",
		domain: "test",
		deliverables: ["hello.txt"],
		leakGlobs: [],
		yardstick: "",
	};

	const run = await runProbe({
		label: "base1",
		task,
		tree,
		harnessDir,
		workspace,
		runDir: path.join(root, "run"),
		cfg,
	});

	assert.equal(run.ok, true, run.error);
	assert.equal(run.delivered, true);
	assert.equal(run.usage.turns, 2);
	assert.deepEqual(run.changedFiles, ["hello.txt"]);
	assert.equal(
		fs.readFileSync(path.join(run.deliverableDir, "files", "hello.txt"), "utf8"),
		"hello harness2\n",
	);
});
