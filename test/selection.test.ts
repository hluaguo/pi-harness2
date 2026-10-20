import assert from "node:assert/strict";
import test from "node:test";
import { verificationGate } from "../src/verify-gate.ts";
import type { VerifyResult } from "../src/types.ts";

function verify(ok: boolean): VerifyResult {
	return {
		command: "check",
		ok,
		exitCode: ok ? 0 : 1,
		stdout: "",
		stderr: "",
		durationMs: 1,
		timedOut: false,
	};
}

test("without verification every candidate stays in the pool", () => {
	const gate = verificationGate([{ label: "base" }, { label: "candidate" }]);
	assert.equal(gate.hasVerification, false);
	assert.equal(gate.gated, false);
	assert.deepEqual(gate.pool.map((c) => c.label), ["base", "candidate"]);
});

test("all passing candidates stay in the pool", () => {
	const gate = verificationGate([
		{ label: "base", verify: verify(true) },
		{ label: "candidate", verify: verify(true) },
	]);
	assert.equal(gate.gated, false);
	assert.deepEqual(gate.pool.map((c) => c.label), ["base", "candidate"]);
});

test("a partial pass gates the pool to passing candidates", () => {
	const gate = verificationGate([
		{ label: "passes", verify: verify(true) },
		{ label: "fails", verify: verify(false) },
		{ label: "unverified" },
	]);
	assert.equal(gate.gated, true);
	assert.deepEqual(gate.pool.map((c) => c.label), ["passes"]);
	assert.deepEqual(gate.passing, ["passes"]);
	assert.deepEqual(gate.failing, ["fails"]);
});

test("when nothing passes the selector still sees every candidate", () => {
	const gate = verificationGate([
		{ label: "one", verify: verify(false) },
		{ label: "two", verify: verify(false) },
	]);
	assert.equal(gate.gated, false);
	assert.deepEqual(gate.pool.map((c) => c.label), ["one", "two"]);
	assert.deepEqual(gate.passing, []);
	assert.deepEqual(gate.failing, ["one", "two"]);
});
