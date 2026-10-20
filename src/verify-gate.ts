/**
 * Verification gating for selection.
 *
 * Kept separate from selection.ts so the rule can be tested without loading the
 * proposer and its child-process machinery.
 */

import type { VerifyResult } from "./types.ts";

export interface VerificationGate<T> {
	pool: T[];
	gated: boolean;
	hasVerification: boolean;
	passing: string[];
	failing: string[];
}

export function verificationGate<T extends { label: string; verify?: VerifyResult }>(
	candidates: T[],
): VerificationGate<T> {
	const hasVerification = candidates.some((c) => c.verify);
	const passing = candidates.filter((c) => c.verify?.ok);
	const failing = candidates.filter((c) => c.verify && !c.verify.ok);
	const gated = hasVerification && passing.length > 0 && passing.length < candidates.length;
	// If no candidate passes, the selector still decides, but sees every failure.
	const pool = gated ? passing : candidates;
	return {
		pool,
		gated,
		hasVerification,
		passing: passing.map((c) => c.label),
		failing: failing.map((c) => c.label),
	};
}
