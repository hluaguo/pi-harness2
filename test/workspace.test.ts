import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { H2Config } from "../src/types.ts";
import { createWorkspace, removeWorkspace } from "../src/workspace.ts";

function gitAvailable(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const hasGit = gitAvailable();

test("a worktree starts from committed and uncommitted state", { skip: !hasGit }, (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-worktree-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "tracked.txt"), "committed\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo });

	fs.writeFileSync(path.join(repo, "tracked.txt"), "uncommitted\n");
	fs.writeFileSync(path.join(repo, "untracked.txt"), "new\n");

	const dest = path.join(root, "probe");
	const ws = createWorkspace(repo, dest, { workspaceCopy: false } as H2Config);
	t.after(() => removeWorkspace(ws));

	assert.equal(ws.worktree, true);
	assert.equal(fs.readFileSync(path.join(dest, "tracked.txt"), "utf8"), "uncommitted\n");
	assert.equal(fs.readFileSync(path.join(dest, "untracked.txt"), "utf8"), "new\n");
	const status = execFileSync("git", ["-C", dest, "status", "--porcelain"], { encoding: "utf8" }).trim();
	assert.equal(status, "");
});

test("a non-Git project falls back to a filtered copy and a snapshot", (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-copy-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const project = path.join(root, "project");
	fs.mkdirSync(project);
	fs.writeFileSync(path.join(project, "notes.md"), "hello\n");
	fs.mkdirSync(path.join(project, "node_modules"));
	fs.writeFileSync(path.join(project, "node_modules", "skip.js"), "skip\n");

	const dest = path.join(root, "probe");
	const ws = createWorkspace(project, dest, { workspaceCopy: true } as H2Config);
	t.after(() => removeWorkspace(ws));

	assert.equal(ws.worktree, false);
	assert.equal(fs.readFileSync(path.join(dest, "notes.md"), "utf8"), "hello\n");
	assert.equal(fs.existsSync(path.join(dest, "node_modules")), false);
	assert.deepEqual(Object.keys(ws.snapshot ?? {}), ["notes.md"]);
});
