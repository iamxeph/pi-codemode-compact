// Assert-based test suite for pi-codemode-compact
// Run: pnpm test
//
// The codemode renderer has a 5-layer architecture with distinct failure modes:
//   1) Pure summary logic: toolUsage / namesLabel / countNames / firstCodeLine / codeSummary / clip / summaryWidth / plain / countLines / formatCost / totalCost
//   2) Result parsing: splitScriptOutput / errorLine (handling pi header + body shapes)
//   3) Single-line formatting: callLine / resultLine / runningLine (user-visible summaries)
//   4) pi component renderers: renderCall / renderResult (called with real argument shapes)
//   5) Extension wiring: registering a renderer resolver that overrides codemode drawing only
//
// Contract established in layer 4:
//   pi passes { content, details } in result; failure status is supplied exclusively via context.isError.
//   Reading isError from result previously led to regressions where failed scripts rendered as successful.
import assert from "node:assert/strict";
import codemodeCompact, {
	callLine,
	clip,
	codeSummary,
	countLines,
	countNames,
	errorLine,
	firstCodeLine,
	formatCost,
	namesLabel,
	plain,
	renderCall,
	renderResult,
	resultLine,
	runningLine,
	splitScriptOutput,
	summaryWidth,
	totalCost,
	toolUsage,
	type CodemodeRenderResult,
	type RenderContext,
	type ThemeLike,
} from "../index.ts";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
	try {
		await fn();
		passed++;
		console.log("PASS " + name);
	} catch (err: any) {
		failed++;
		const msg = err && err.message ? err.message : String(err);
		console.error("FAIL " + name + "\n  " + msg);
	}
}

/** Color-stripping mock theme: validates plain text layout. */
const theme: ThemeLike = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** Registered tool names simulated in session (for false positive filter). */
const KNOWN = new Set(["read", "write", "edit", "bash", "todo", "Agent"]);
const isTool = (name: string) => KNOWN.has(name);

/** Creates a mock nested call entry. */
const call = (name: string, status: "running" | "ok" | "error" | "cancelled", extra: Record<string, unknown> = {}) => ({
	id: "call/" + name,
	name,
	args: '{"path":"x"}',
	status,
	...extra,
});

const HEADER_OK = "Script completed\nWall time 0.1 seconds\nOutput:\n";
const HEADER_FAIL = "Script failed\nWall time 0.4 seconds\nOutput:\n";

/** Simulates the context object passed by pi to renderers. */
function renderCtx(extra: Record<string, unknown> = {}): RenderContext {
	return {
		args: undefined,
		toolCallId: "c1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/tmp",
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...extra,
	} as RenderContext;
}

/** Rendered component lines with trailing whitespace trimmed. */
const renderLines = (component: any) => component.render(200).map((l: string) => l.replace(/\s+$/, ""));
const firstLine = (component: any) => renderLines(component)[0];

async function run() {
	// ── 1. Pure Summary Helpers ───────────────────────────────────────────────
	await check("toolUsage: appearance order, counts, and spacing", () => {
		assert.deepEqual(toolUsage('await tools.read({ a: 1 });\nawait tools.bash({});\nawait tools.read({});'), [
			{ name: "read", count: 2 },
			{ name: "bash", count: 1 },
		]);
		assert.deepEqual(toolUsage("await tools . read({});"), [{ name: "read", count: 1 }]);
		assert.deepEqual(toolUsage("const x = 1;"), []);
	});

	await check("toolUsage: bracket notation (tools['name'] and tools[\"name\"])", () => {
		assert.deepEqual(toolUsage('await tools["read"]({});\nawait tools[\'bash\']({});'), [
			{ name: "read", count: 1 },
			{ name: "bash", count: 1 },
		]);
	});

	await check("toolUsage: bracket notation ignores occurrences inside comments and strings", () => {
		const code = [
			'// await tools["write"]({});',
			'/* tools["edit"]({}); */',
			'const hint = "call tools[\"todo\"] first";',
			'const single = \'call tools["Agent"] first\';',
			'await tools["bash"]({});',
			'await tools.read({});',
		].join("\n");
		assert.deepEqual(toolUsage(code, isTool), [
			{ name: "bash", count: 1 },
			{ name: "read", count: 1 },
		]);
	});

	await check("toolUsage: strips references in strings/comments and filters local variables", () => {
		const code =
			"const tools = [];\n" +
			"tools.push(def);\n" +
			'assert.equal(tools.length, 1, "registered 1 tool");\n' +
			'const msg = "TypeError: tools.foo is not a function";\n' +
			"// await tools.edit({});\n" +
			"/* tools.write({}); */\n" +
			'await tools.todo({ action: "update" });';
		assert.deepEqual(toolUsage(code, isTool), [{ name: "todo", count: 1 }]);
		// Without isTool filter, local variable references like push/length remain
		assert.deepEqual(toolUsage(code), [
			{ name: "push", count: 1 },
			{ name: "length", count: 1 },
			{ name: "todo", count: 1 },
		]);
	});

	await check("toolUsage: template literal calls are not counted (documented limit)", () => {
		assert.deepEqual(toolUsage("await tools[`read`]({});"), []);
	});

	await check("namesLabel: single, xN multiplier, and +N overflow", () => {
		assert.equal(namesLabel([{ name: "read", count: 1 }]), "read");
		assert.equal(namesLabel([{ name: "read", count: 3 }]), "read×3");
		assert.equal(
			namesLabel([
				{ name: "a", count: 1 },
				{ name: "b", count: 2 },
				{ name: "c", count: 1 },
			]),
			"a, b×2, c",
		);

		const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ name: "t" + i, count: 1 }));
		assert.equal(namesLabel(nine), "t1, t2, t3, t4, t5, t6, t7, t8 +1");
	});

	await check("countNames: counts array entries in order of first appearance", () => {
		assert.deepEqual(countNames(["read", "bash", "read", "read", "edit"]), [
			{ name: "read", count: 3 },
			{ name: "bash", count: 1 },
			{ name: "edit", count: 1 },
		]);
		assert.deepEqual(countNames([]), []);
	});

	await check("firstCodeLine: skips line comments, block comments, and options header", () => {
		assert.equal(
			firstCodeLine(
				'// @options: {"timeout_ms": 1000}\n' +
				"// comment\n" +
				"/* block\n" +
				" * comment */\n" +
				"const x = 1;\n" +
				"return x;",
			),
			"const x = 1;",
		);
		assert.equal(firstCodeLine("// only comments"), "");
	});

	await check("codeSummary: returns tool names when present, or first code line as fallback", () => {
		assert.equal(codeSummary("await tools.read({});\nreturn 1;"), "read");
		assert.equal(codeSummary("const x = 1;\nreturn x;"), "const x = 1;");
		assert.equal(codeSummary("// only comment"), "");
	});

	await check("clip: middle truncation, boundaries, and short width arithmetic", () => {
		assert.equal(clip("abcdefghij", 10), "abcdefghij");
		assert.equal(clip("abcdefghij", 11), "abcdefghij");
		assert.equal(clip("abcdefghij", 7), "abc…hij");
		assert.equal(clip("abcdefghij", 6), "abc…ij");
		assert.equal(clip("abcdefghij", 5), "ab…ij");
		assert.equal(clip("abcdefghij", 4), "ab…j");
		assert.equal(clip("abcdefghij", 3), "a…j");
		assert.equal(clip("abcdefghij", 2), "a…");
		assert.equal(clip("abcdefghij", 1), "abcdefghij");
		assert.equal(clip("abcdefghij", 0), "abcdefghij");
		assert.equal(clip("abcdefghij", -5), "abcdefghij");
	});

	await check("clip: wide-character and CJK column width awareness", () => {
		const clipped = clip("한글에러메시지", 8);
		assert.ok(clipped.includes("…"));
		const widthInStub = (s: string) => [...s].reduce((acc, ch) => acc + (ch.codePointAt(0)! > 127 ? 2 : 1), 0);
		assert.ok(widthInStub(clipped) <= 8, "Clipped CJK exceeded column budget: " + clipped);
	});

	await check("summaryWidth: handles terminal dimensions and boundary reserves", () => {
		assert.equal(summaryWidth(80), 56);
		assert.equal(summaryWidth(120), 96);
		assert.equal(summaryWidth(200), 96);
		assert.equal(summaryWidth(30), 24);
		assert.equal(summaryWidth(10), 24);
		assert.equal(summaryWidth(undefined), 96);
		assert.equal(summaryWidth(NaN), 96);
		assert.equal(summaryWidth(-10), 96);
	});

	await check("plain: removes ANSI escapes, OSC sequences, control chars, and expands tabs", () => {
		assert.equal(plain("\u001b[31mred\u001b[0m"), "red");
		assert.equal(plain("\u001b]0;title\u0007body"), "body");
		assert.equal(plain("\u001b]0;title\u001b\\body"), "body");
		assert.equal(plain("a\rb\tc"), "ab   c");
		assert.equal(plain("a\x00b\x07c\x1fd"), "abcd");
	});

	await check("plain: removes APC and DCS sequences along with standard ANSI/OSC", () => {
		assert.equal(plain("a\u001b_Gp\u001b\\b"), "ab");
		assert.equal(plain("a\u001bP1;2|p\u001b\\b"), "ab");
	});

	await check("countLines: counts non-empty lines ignoring trailing and blank lines", () => {
		assert.equal(countLines("a\nb\nc"), 3);
		assert.equal(countLines("a\n\nb\n"), 2);
		assert.equal(countLines("  \n\t\n"), 0);
		assert.equal(countLines(""), 0);
	});

	await check("formatCost: formats values correctly below and above 1 cent", () => {
		assert.equal(formatCost(0.125), "0.13");
		assert.equal(formatCost(0.01), "0.01");
		assert.equal(formatCost(0.0042), "0.0042");
		assert.equal(formatCost(0.00015), "0.00015");
	});

	await check("totalCost: calculates aggregate cost and ignores calls without cost", () => {
		assert.equal(totalCost([call("read", "ok", { cost: 0.02 }), call("bash", "ok", { cost: 0.03 })]), 0.05);
		assert.equal(totalCost([call("read", "ok")]), undefined);
		assert.equal(totalCost([]), undefined);
	});

	// ── 2. Result Parsing ────────────────────────────────────────────────────
	await check("splitScriptOutput: separates header and wallTime from body", () => {
		const out = splitScriptOutput([{ type: "text", text: HEADER_OK + "first\nsecond" }]);
		assert.equal(out.wallTime, 0.1);
		assert.equal(out.body, "first\nsecond");

		const noHeader = splitScriptOutput([{ type: "text", text: "plain output" }]);
		assert.equal(noHeader.wallTime, undefined);
		assert.equal(noHeader.body, "plain output");

		const multi = splitScriptOutput([
			{ type: "text", text: HEADER_OK + "first" },
			{ type: "text", text: "second" },
		]);
		assert.equal(multi.wallTime, 0.1);
		assert.equal(multi.body, "first\nsecond");
	});

	await check("splitScriptOutput: handles leading blank blocks cleanly without spurious newline", () => {
		const res = splitScriptOutput([{ type: "text", text: "" }, { type: "text", text: "actual output" }]);
		assert.equal(res.body, "actual output");
	});

	await check("errorLine: extracts error line after Script error marker", () => {
		assert.equal(errorLine("Script error:\nTypeError: x is not a function\n  at foo.js:1"), "TypeError: x is not a function");
		assert.equal(errorLine("Script error: inline error"), "inline error");
		assert.equal(errorLine("some output\nerror: failed"), "some output");
		assert.equal(errorLine(""), "");
	});

	await check("errorLine: skips stack frame traces and picks authoritative error message", () => {
		const body = "partial output\nScript error:\n    at script:3\nTypeError: tools.unknown is not a function";
		assert.equal(errorLine(body), "TypeError: tools.unknown is not a function");

		const bareMarker = "partial output\nScript error:\n";
		assert.equal(errorLine(bareMarker), "");
	});

	await check("errorLine: handles multiple Script error markers by picking the last authoritative one", () => {
		const multi = "Script error: false marker in output\nsome logs\nScript error:\nError: real final error";
		assert.equal(errorLine(multi), "Error: real final error");
	});

	// ── 3. Single-line Formatting ────────────────────────────────────────────
	await check("callLine: formats tool list and line count", () => {
		assert.equal(callLine(theme, "await tools.read({});\nawait tools.bash({});"), "codemode read, bash · 2 lines");
		assert.equal(callLine(theme, "await tools.read({});"), "codemode read");
	});

	await check("callLine: handles scripts with no tool calls, empty code, or invalid args", () => {
		assert.equal(callLine(theme, "const x = 1;\nreturn x;"), "codemode const x = 1; · 2 lines");
		assert.equal(callLine(theme, ""), "codemode");
		assert.equal(callLine(theme, "   \n  "), "codemode");
		assert.equal(callLine(theme, null), "codemode [invalid arg]");
	});

	await check("resultLine (success): actual calls, line count, duration, multipliers, and overflow", () => {
		assert.equal(
			resultLine(theme, {
				calls: [call("read", "ok"), call("read", "ok"), call("bash", "ok")],
				body: "line1\nline2",
				wallTime: 0.1,
				truncated: false,
				failed: false,
			}),
			"✓ read×2, bash · 2 lines · 0.1s",
		);

		const nineCalls = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => call("t" + i, "ok"));
		assert.equal(
			resultLine(theme, { calls: nineCalls, body: "out", wallTime: 1.2, truncated: false, failed: false }),
			"✓ t1, t2, t3, t4, t5, t6, t7, t8 +1 · 1 line · 1.2s",
		);
	});

	await check("resultLine (success edges): 0 calls, 0 output lines, wallTime 0, truncated indicator", () => {
		assert.equal(
			resultLine(theme, { calls: [], body: "", truncated: false, failed: false }),
			"✓ done",
		);
		assert.equal(
			resultLine(theme, { calls: [call("read", "ok")], body: "", wallTime: 0.0, truncated: true, failed: false }),
			"✓ read · 0.0s · truncated",
		);
	});

	await check("resultLine (failure): names failed tool and clips error message", () => {
		assert.equal(
			resultLine(theme, {
				calls: [call("read", "ok"), call("write", "error", { error: "ENOENT" })],
				body: "Script error:\nTypeError: tools.foo is not a function",
				truncated: false,
				failed: true,
			}),
			"✗ write — TypeError: tools.foo is not a function",
		);
		assert.equal(
			resultLine(theme, { calls: [call("read", "cancelled")], body: "", truncated: false, failed: true }),
			"✗ Script failed",
		);
	});

	await check("resultLine (failure width guarantee): respects budget even with long tool names", () => {
		const longFailed = resultLine(
			theme,
			{
				calls: [call("mcp__chrome_devtools_take_snapshot_of_page_region_very_long", "error")],
				body: "Script error:\nError: timeout exceeded",
				truncated: false,
				failed: true,
			},
			24,
		);
		assert.ok(longFailed.length <= 24, "Failure line exceeded 24 cols: " + longFailed.length);
	});

	await check("resultLine (cost): displays total model cost when present", () => {
		const calls = [call("Agent", "ok", { cost: 0.035 }), call("Agent", "ok", { cost: 0.015 })];
		const line = resultLine(theme, { calls, body: "done", wallTime: 0.5, truncated: false, failed: false });
		assert.ok(line.includes("$0.05"), "Should include aggregate cost: " + line);
	});

	await check("runningLine: active tools with total call count", () => {
		assert.equal(runningLine(theme, [call("read", "ok"), call("bash", "running")]), "… bash · 2 calls");
		assert.equal(runningLine(theme, [call("read", "ok"), call("read", "ok")]), "… read×2 · 2 calls");
		assert.equal(runningLine(theme, [call("bash", "running")]), "… bash · 1 call");
		assert.equal(runningLine(theme, []), "…");
	});

	await check("width guarantee: summary lines never exceed terminal column widths across 60-120", () => {
		const longCode = 'await tools.bash({ command: "pnpm test" });\nawait tools.bash({ command: "echo done" });';
		for (const columns of [60, 80, 100, 120]) {
			const width = summaryWidth(columns);
			const callText = callLine(theme, longCode, width, isTool);
			assert.ok(callText.length <= columns, columns + " cols call line exceeded: " + callText.length);
			const resultText = resultLine(
				theme,
				{
					calls: ["read", "bash", "edit", "write", "todo"].map((name) => call(name, "ok")),
					body: "x",
					wallTime: 12.3,
					truncated: true,
					failed: false,
				},
				width,
			);
			assert.ok(resultText.length <= columns, columns + " cols result line exceeded: " + resultText.length);
		}
	});

	// ── 4. pi Component Renderers ────────────────────────────────────────────
	await check("renderCall: collapsed is one line, component reuse (setText), invalid arg handling", () => {
		const component = renderCall({ code: "await tools.read({});\ntext(1);" }, theme as never, renderCtx(), KNOWN);
		assert.equal(renderLines(component).length, 1, "Collapsed call is a single line");
		assert.equal(firstLine(component), "codemode read · 2 lines");

		const reused = renderCall({ code: "text(2);" }, theme as never, renderCtx({ lastComponent: component }), KNOWN);
		assert.equal(reused, component, "Must reuse previous Text component to reduce allocations");
		assert.equal(firstLine(reused), "codemode text(2);");

		assert.equal(firstLine(renderCall(undefined, theme as never, renderCtx(), KNOWN)), "codemode [invalid arg]");
		assert.equal(firstLine(renderCall({ code: 42 }, theme as never, renderCtx(), KNOWN)), "codemode [invalid arg]");
	});

	await check("renderCall: partial argument streaming does not trigger invalid arg error", () => {
		assert.equal(firstLine(renderCall({}, theme as never, renderCtx({ argsComplete: false }), KNOWN)), "codemode");
		assert.equal(firstLine(renderCall(undefined, theme as never, renderCtx({ argsComplete: false }), KNOWN)), "codemode");
	});

	await check("renderCall: filters registered tool names (local variable false positive guard)", () => {
		const code = "const tools = [];\ntools.push(1);\ntools.length;\nawait tools.read({});";
		assert.equal(firstLine(renderCall({ code }, theme as never, renderCtx(), KNOWN)), "codemode read · 4 lines");
		// When registry cannot be read (null), falls back gracefully without filter
		assert.equal(firstLine(renderCall({ code }, theme as never, renderCtx(), null)), "codemode push, length, read · 4 lines");
	});

	await check("renderCall (expanded): shows header and full script source", () => {
		const rendered = renderLines(renderCall({ code: "const t = 40;\ntext(t);" }, theme as never, renderCtx({ expanded: true }), KNOWN));
		assert.equal(rendered.length, 3);
		assert.ok(rendered[0].includes("codemode"));
		assert.ok(rendered.join("\n").includes("const t = 40;"));
	});

	await check("renderResult (partial): shows single in-progress line and hides output body", () => {
		const component = renderResult(
			{ content: [], details: { calls: [call("bash", "running")] } },
			{ expanded: false, isPartial: true },
			theme as never,
			renderCtx({ isPartial: true }),
		);
		assert.deepEqual(renderLines(component), ["… bash · 1 call"]);
	});

	await check("renderResult (success): collapsed single-line vs expanded call details and output", () => {
		const result: CodemodeRenderResult = {
			content: [{ type: "text", text: HEADER_OK }, { type: "text", text: "ok\ndone" }],
			details: { calls: [call("read", "ok", { durationMs: 12 }), call("bash", "ok", { durationMs: 1234, cost: 0.02 })] },
		};
		assert.deepEqual(renderLines(renderResult(result, { expanded: false, isPartial: false }, theme as never, renderCtx())), [
			"✓ read, bash · 2 lines · 0.1s · $0.02",
		]);

		const expanded = renderLines(renderResult(result, { expanded: true, isPartial: false }, theme as never, renderCtx({ expanded: true })));
		assert.equal(expanded[0], "✓ read, bash · 2 lines · 0.1s · $0.02");
		assert.ok(expanded.some((l: string) => l.includes("12ms")), "Under 1s formats as ms");
		assert.ok(expanded.some((l: string) => l.includes("1.2s")), "Over 1s formats as seconds");
		assert.ok(expanded.some((l: string) => l.includes("$0.02")), "Displays per-call cost in expanded details");
		assert.ok(expanded.some((l: string) => l.includes("done")), "Displays full output body");
	});

	await check("renderResult (failure): failure state relies strictly on context.isError", () => {
		const failedRun: CodemodeRenderResult = {
			content: [{ type: "text", text: HEADER_FAIL }, { type: "text", text: "Script error:\nError: ENOENT: no such file or directory" }],
			details: { calls: [call("read", "error", { error: "Error: ENOENT" })] },
		};
		// Without context.isError, result without error status displays as checkmark
		assert.ok(
			firstLine(renderResult(failedRun, { expanded: false, isPartial: false }, theme as never, renderCtx())).startsWith("✓"),
		);
		assert.equal(
			firstLine(renderResult(failedRun, { expanded: false, isPartial: false }, theme as never, renderCtx({ isError: true }))),
			"✗ read — Error: ENOENT: no such file or directory",
		);
		const expanded = renderLines(
			renderResult(failedRun, { expanded: true, isPartial: false }, theme as never, renderCtx({ expanded: true, isError: true })),
		);
		assert.ok(expanded.some((l: string) => l.includes("Error: ENOENT")), "Per-call error detail shown when expanded");
	});

	await check("renderResult: safe with truncated outputs, empty results, and image-only blocks", () => {
		const truncated = renderLines(
			renderResult(
				{ content: [{ type: "text", text: HEADER_OK }], details: { calls: [], fullOutputPath: "/tmp/pi-codemode-x.txt" } },
				{ expanded: true, isPartial: false },
				theme as never,
				renderCtx({ expanded: true }),
			),
		);
		assert.ok(truncated[0].includes("truncated"), truncated[0]);
		assert.ok(truncated.some((l: string) => l.includes("/tmp/pi-codemode-x.txt")), "Displays full output file path");

		assert.equal(
			firstLine(renderResult({ content: [] }, { expanded: false, isPartial: false }, theme as never, renderCtx())),
			"✓ done",
		);
		assert.equal(
			firstLine(
				renderResult(
					{ content: [{ type: "image", mimeType: "image/png" }], details: { calls: [] } },
					{ expanded: false, isPartial: false },
					theme as never,
					renderCtx(),
				),
			),
			"✓ done",
		);
	});

	// ── 5. Extension Wiring ──────────────────────────────────────────────────
	await check("wiring: registers a renderer resolver and draws codemode compactly", () => {
		let resolver: ((toolName: string, next: () => any) => any) | undefined;
		codemodeCompact({
			registerToolRenderer: (r: typeof resolver) => { resolver = r; },
			getAllTools: () => [{ name: "read" }, { name: "bash" }],
		} as never);

		assert.equal(typeof resolver, "function", "Registers a renderer resolver");
		// Other tools fall through untouched: nothing is re-registered or replaced.
		const base = { renderCall: "base_call", renderResult: "base_result" };
		assert.equal(resolver!("bash", () => base), base, "Non-codemode tools receive next() verbatim");

		const renderers = resolver!("codemode", () => base);
		assert.equal(typeof renderers.renderCall, "function");
		assert.equal(typeof renderers.renderResult, "function");
		assert.equal(
			firstLine(renderers.renderCall({ code: "const tools = [];\ntools.push(1);\nawait tools.read({});" }, theme, renderCtx())),
			"codemode read · 3 lines",
		);
		assert.equal(
			firstLine(renderers.renderResult({
				content: [{ type: "text", text: HEADER_OK + "hello" }],
				details: { calls: [call("read", "ok")] },
			}, { expanded: false, isPartial: false }, theme, renderCtx())),
			"✓ read · 1 line · 0.1s",
		);
	});

	await check("wiring: preserves renderer slots supplied by the registered definition", () => {
		let resolver: ((toolName: string, next: () => any) => any) | undefined;
		codemodeCompact({
			registerToolRenderer: (r: typeof resolver) => { resolver = r; },
			getAllTools: () => [],
		} as never);

		const renderers = resolver!("codemode", () => ({ renderShell: "self" }));
		assert.equal(renderers.renderShell, "self", "renderShell from next() survives the override");
		assert.equal(typeof renderers.renderCall, "function", "Compact renderCall still wins");
		assert.equal(
			resolver!("codemode_aux", () => ({ renderCall: "original_aux" })).renderCall,
			"original_aux",
			"Auxiliary tools keep their own renderers",
		);
	});

	await check("wiring: handles getAllTools throwing without crashing renderer", () => {
		let resolver: ((toolName: string, next: () => any) => any) | undefined;
		codemodeCompact({
			registerToolRenderer: (r: typeof resolver) => { resolver = r; },
			getAllTools: () => { throw new Error("tools registry not ready"); },
		} as never);
		const comp = resolver!("codemode", () => undefined).renderCall(
			{ code: "const tools = [];\ntools.push(1);\nawait tools.read({});" },
			theme,
			renderCtx(),
		);
		assert.equal(firstLine(comp), "codemode push, read · 3 lines");
	});

	console.log("\npi-codemode-compact tests: " + passed + " passed, " + failed + " failed");
	if (failed > 0) {
		process.exit(1);
	}
}

await run();
