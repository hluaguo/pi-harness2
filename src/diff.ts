/** A small line-oriented unified diff, used for candidate evidence and reports. */

export function unifiedDiff(
	before: string,
	after: string,
	fromLabel: string,
	toLabel: string,
	context = 3,
): string {
	const a = before.split("\n");
	const b = after.split("\n");
	if (a.length > 2500 || b.length > 2500) {
		return [
			`--- ${fromLabel}`,
			`+++ ${toLabel}`,
			`@@ full file (${a.length} -> ${b.length} lines) @@`,
			after,
		].join("\n");
	}
	const n = a.length;
	const m = b.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	type Op = { type: " " | "-" | "+"; text: string; ai: number; bi: number };
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ type: " ", text: a[i], ai: i, bi: j });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			ops.push({ type: "-", text: a[i], ai: i, bi: j });
			i++;
		} else {
			ops.push({ type: "+", text: b[j], ai: i, bi: j });
			j++;
		}
	}
	while (i < n) ops.push({ type: "-", text: a[i], ai: i++, bi: j });
	while (j < m) ops.push({ type: "+", text: b[j++], ai: i, bi: j });

	if (!ops.some((op) => op.type !== " ")) return "";
	const keep = Array.from({ length: ops.length }, () => false);
	ops.forEach((op, idx) => {
		if (op.type === " ") return;
		for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) {
			keep[k] = true;
		}
	});

	const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
	let idx = 0;
	while (idx < ops.length) {
		if (!keep[idx]) {
			idx++;
			continue;
		}
		let start = idx;
		while (idx < ops.length && keep[idx]) idx++;
		const chunk = ops.slice(start, idx);
		const oldStart = chunk[0].ai + 1;
		const newStart = chunk[0].bi + 1;
		const oldCount = chunk.filter((o) => o.type !== "+").length;
		const newCount = chunk.filter((o) => o.type !== "-").length;
		out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
		for (const op of chunk) out.push(`${op.type}${op.text}`);
	}
	return out.join("\n");
}
