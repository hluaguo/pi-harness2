import assert from "node:assert/strict";
import test from "node:test";
import {
	autotrigger,
	hashTree,
	isAllowed,
	normalizeRel,
	validate,
} from "../src/tree.ts";
import type { Tree } from "../src/types.ts";

test("the allowlist accepts the editable surface and rejects escapes", () => {
	for (const rel of [
		"systemprompt.md",
		"guardrails.md",
		"LongTermMEMORY.md",
		"tool_descriptions/tool_guidance.md",
		"skills/demo/SKILL.md",
		"skills/demo/scripts/run.py",
		"agents/reviewer.md",
		"scripts/check.py",
		"plugins/hook.ts",
	]) {
		assert.equal(isAllowed(rel), true, rel);
	}
	for (const rel of ["README.md", "../AGENTS.md", "/etc/passwd", "skills/demo/notes.txt"]) {
		assert.equal(isAllowed(rel), false, rel);
	}
	assert.throws(() => normalizeRel("../outside.md"), /escapes the harness/);
	assert.throws(() => normalizeRel("/absolute.md"), /escapes the harness/);
});

test("validate returns a census for a coherent tree", () => {
	const tree: Tree = {
		"systemprompt.md": "When asked for a demo, load the demo skill.",
		"skills/demo/SKILL.md": "---\nname: demo\ndescription: run the demo workflow\n---\nDo the work.\n",
	};
	const census = validate(tree, { alwaysOnMax: 2_000, compilePython: false });
	assert.equal(census.files, 2);
	assert.equal(census.skills, 1);
	assert.equal(census.alwaysOnChars, tree["systemprompt.md"].length);
});

test("validate rejects an untriggered skill and a missing referenced script", () => {
	const untriggered = {
		"systemprompt.md": "Be careful.",
		"skills/demo/SKILL.md": "---\nname: demo\ndescription: run the demo workflow\n---\nDo the work.\n",
	};
	assert.throws(
		() => validate(untriggered, { alwaysOnMax: 2_000, compilePython: false }),
		/never named in always-on text/,
	);

	const missingScript = {
		"systemprompt.md": "Use the demo skill.",
		"skills/demo/SKILL.md":
			"---\nname: demo\ndescription: run the demo workflow\n---\nRun python3 skills/demo/scripts/run.py\n",
	};
	assert.throws(
		() => validate(missingScript, { alwaysOnMax: 2_000, compilePython: false }),
		/that file is not in the harness/,
	);
});

test("validate rejects off-surface files and over-cap always-on text", () => {
	const tree = {
		"systemprompt.md": "Be careful.",
		"notes.txt": "not editable",
	};
	assert.throws(
		() => validate(tree, { alwaysOnMax: 2_000, compilePython: false }),
		/off the editable surface/,
	);
	assert.throws(
		() => validate({ "systemprompt.md": "x".repeat(100) }, { alwaysOnMax: 10 }),
		/over the 10 cap/,
	);
});

test("autotrigger names a silent skill once and respects the cap", () => {
	const tree: Tree = {
		"systemprompt.md": "Be careful.",
		"skills/demo/SKILL.md": "---\nname: demo\ndescription: run the demo workflow\n---\nDo the work.\n",
	};
	assert.deepEqual(autotrigger(tree, 10_000), ["demo"]);
	assert.match(tree["guardrails.md"], /`demo` skill/);
	assert.deepEqual(autotrigger(tree, 10_000), []);

	const tight: Tree = {
		"systemprompt.md": "x".repeat(50),
		"skills/demo/SKILL.md": "---\nname: demo\ndescription: run the demo workflow\n---\nDo the work.\n",
	};
	assert.deepEqual(autotrigger(tight, 51), []);
});

test("hashTree ignores key order and changes with content", () => {
	assert.equal(hashTree({ a: "1", b: "2" }), hashTree({ b: "2", a: "1" }));
	assert.notEqual(hashTree({ a: "1" }), hashTree({ a: "2" }));
});
