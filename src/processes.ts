/** Track child Pi processes so session shutdown can cancel them. */

import type { ChildProcess } from "node:child_process";

const live = new Set<ChildProcess>();

export function registerChild(child: ChildProcess): void {
	live.add(child);
	child.once("close", () => live.delete(child));
	child.once("error", () => live.delete(child));
}

export function killAllChildren(reason = "session shutdown"): void {
	for (const child of live) {
		try {
			child.kill("SIGTERM");
			setTimeout(() => {
				if (child.exitCode === null) {
					try {
						child.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}
			}, 3000).unref?.();
		} catch {
			/* ignore */
		}
	}
	void reason;
}
