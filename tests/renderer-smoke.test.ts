// Real Pi/TUI checks: no stub loader, network, model credentials, or terminal required.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { initTheme, type ExtensionAPI, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, Text, visibleWidth } from "@earendil-works/pi-tui";
import codemodeCompact, { plain, renderCall, renderResult, type RenderContext } from "../index.ts";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const header = "Script completed\nWall time 0.1 seconds\nOutput:\n";
const options = { expanded: false, isPartial: false };
const context = (extra: Partial<RenderContext> = {}): RenderContext => ({
	args: {}, toolCallId: "smoke", invalidate() {}, lastComponent: undefined, state: {}, cwd: process.cwd(),
	executionStarted: false, argsComplete: true, isPartial: false, expanded: false, showImages: false,
	isError: false, durationMs: undefined, outputPad: 1, ...extra,
});
const lines = (component: { render(width: number): string[] }, width = 100) =>
	component.render(width).map((line) => plain(line).trimEnd());
const result = { content: [{ type: "text" as const, text: header + "hello" }], details: { calls: [] } };
const png = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYZkAAAAASUVORK5CYII=" };

function wiring() {
	let resolver: Parameters<ExtensionAPI["registerToolRenderer"]>[0] | undefined;
	const events = new Map<string, () => void>();
	codemodeCompact({
		on: (name: string, handler: () => void) => { events.set(name, handler); },
		registerToolRenderer: (r: typeof resolver) => { resolver = r; },
		getAllTools: () => [],
	} as unknown as ExtensionAPI);
	return { renderers: resolver!("codemode", () => undefined)!, events };
}

test("real Text: collapsed rows stay one line at the actual width, including resize and Unicode", () => {
	const oldColumns = process.stdout.columns;
	Object.defineProperty(process.stdout, "columns", { value: 200, configurable: true });
	try {
		const name = "mcp__" + "한글😀e\u0301".repeat(30);
		const ansiTheme = { fg: (_: string, text: string) => `\x1b[31m${text}\x1b[0m`, bold: (text: string) => text } as Theme;
		const call = renderCall({ code: `await tools["${name}"]({});\ntext(1);` }, ansiTheme, context(), new Set([name]));
		const success = renderResult({ ...result, content: [...result.content, png] }, options, ansiTheme, context({ durationMs: 2500 }));
		const failure = renderResult({ content: [{ type: "text", text: "Script error:\n" + name }] }, options, ansiTheme, context({ isError: true }));
		const partial = renderResult({ content: [], details: { calls: [{ id: "nested", name, args: "", status: "running" }] } },
			{ ...options, isPartial: true }, ansiTheme, context());
		for (const width of [1, 2, 5, 10, 24, 40, 80, 120, 200, 40]) {
			for (const component of [call, success, failure, partial]) {
				const rendered = component.render(width);
				assert.equal(rendered.length, 1, `width ${width}: ${rendered}`);
				assert.ok(rendered.every((line) => visibleWidth(line) <= width));
			}
		}
		assert.deepEqual(call.render(0), []);
		assert.equal(renderCall({ code: "text(1);" }, theme, context({ lastComponent: call }), null), call);
		assert.ok(!call.render(40).join("").includes("\x1b[31m"), "Reused component must not retain old theme colors");
		const expanded = renderCall({ code: "text(1);\ntext(2);" }, theme, context({ expanded: true }), null);
		assert.ok(lines(expanded, 40).join("\n").includes("text(2);"));
	} finally {
		Object.defineProperty(process.stdout, "columns", { value: oldColumns, configurable: true });
	}
});

test("real Text: summaries are rebuilt only on width change or invalidate; hyphenated tools are recognized", () => {
	let toolLookups = 0;
	let resolver: Parameters<ExtensionAPI["registerToolRenderer"]>[0] | undefined;
	codemodeCompact({
		on() {},
		registerToolRenderer: (r: typeof resolver) => { resolver = r; },
		getAllTools: () => { toolLookups++; return [{ name: "my-tool" }]; },
	} as unknown as ExtensionAPI);
	const renderers = resolver!("codemode", () => undefined)!;
	const ctx = context();
	const call = renderers.renderCall!({ code: "await tools.my_tool({});\nawait other.x();" }, theme, ctx);
	assert.deepEqual(lines(call, 80), ["codemode my_tool · 2 lines"]);
	renderers.renderCall!({ code: "await tools.my_tool({});\nawait other.x();" }, theme, { ...ctx, lastComponent: call });
	assert.equal(toolLookups, 1, "Complete args reuse the registered tool set");

	let builds = 0;
	const row = renderCall({ code: "text(1);" }, theme, context(), null) as Text & { build: (w: number) => string };
	const build = row.build;
	row.build = (width) => { builds++; return build(width); };
	for (let i = 0; i < 5; i++) row.render(80);
	assert.equal(builds, 1, "Frames at the same width reuse the summary");
	row.render(40);
	row.invalidate();
	row.render(40);
	assert.equal(builds, 3, "Resize and invalidate rebuild");
});

test("recorded durations win, with zero, invalid-value, old-session and HTML fallbacks", () => {
	assert.match(lines(renderResult(result, options, theme, context({ durationMs: 2500 })))[0], /2\.5s$/);
	assert.match(lines(renderResult(result, options, theme, context({ durationMs: 0 })))[0], /0\.0s$/);
	for (const durationMs of [undefined, NaN, -1, Infinity]) {
		assert.match(lines(renderResult(result, options, theme, context({ durationMs })))[0], /0\.1s$/);
	}
	const rejected = { content: [{ type: "text", text: "Invalid options" }] };
	assert.equal(lines(renderResult(rejected, options, theme, context({ durationMs: 2500 })))[0],
		"✓ done · 1 line · 2.5s");
	assert.equal(lines(renderResult(rejected, options, theme, context({ isError: true, durationMs: 2500 })))[0],
		"✗ Invalid options · 2.5s");
	const failed = { content: [{ type: "text", text: header.replace("completed", "failed") + "Invalid options" }] };
	assert.equal(lines(renderResult(failed, options, theme, context({ isError: true })))[0],
		"✗ Invalid options · 0.1s");
	assert.equal(lines(renderResult(failed, options, theme, context({ isError: true, durationMs: 0 })))[0],
		"✗ Invalid options · 0.0s");
	for (const durationMs of [undefined, NaN, -1, Infinity]) {
		assert.equal(lines(renderResult(rejected, options, theme, context({ isError: true, durationMs })))[0],
			"✗ Invalid options");
	}
	assert.equal(lines(renderResult({ content: [] }, options, theme, context()))[0], "✓ done");
});

test("new text/console boundaries and image paths survive expansion; images are counted without mutation", () => {
	const body = "==> text 1/2 <==\nA\n==> text 2/2 <==\nB\n<console_output>\nC\n</console_output>\n[Image saved to /tmp/image.png (image/png)]";
	const mixed = { content: [{ type: "text", text: header }, { type: "text", text: body }, png, png], details: { calls: [] } };
	const before = structuredClone(mixed);
	assert.equal(lines(renderResult(mixed, options, theme, context()))[0], "✓ done · 8 lines · 2 images · 0.1s");
	for (const showImages of [false, true]) {
		const expanded = lines(renderResult(mixed, { ...options, expanded: true }, theme, context({ expanded: true, showImages }))).join("\n");
		assert.ok(expanded.includes(body));
	}
	assert.equal(lines(renderResult({ content: [png] }, options, theme, context()))[0], "✓ done · 1 image");
	assert.deepEqual(mixed, before);
});

// Inspect the real host/exporter only in tests; the extension imports public APIs exclusively.
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { createToolHtmlRenderer } = await import(new URL("./core/export-html/tool-renderer.js", sdkEntry).href);
const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", sdkEntry).href);
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", sdkEntry).href);

test("actual Pi loader supplies host modules regardless of peer version metadata", async () => {
	const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
	for (const range of ["*", ">=999.0.0"]) {
		const dir = await mkdtemp(join(tmpdir(), "pi-compact-loader-"));
		try {
			await writeFile(join(dir, "index.ts"), source);
			await writeFile(join(dir, "package.json"), JSON.stringify({
				name: "pi-compact-loader-test", type: "module", pi: { extensions: ["./index.ts"] },
				peerDependencies: { "@earendil-works/pi-coding-agent": range, "@earendil-works/pi-tui": range },
			}));
			const loaded = await loadExtensions([join(dir, "index.ts")], process.cwd());
			assert.deepEqual(loaded.errors, []);
			assert.equal(loaded.extensions.length, 1);
			const renderers = loaded.extensions[0].toolRenderers[0]("codemode", () => undefined);
			const call = renderers.renderCall({ code: "text(1);" }, theme, context());
			assert.ok(call instanceof Text, "Extension must use the host TUI module");
			assert.deepEqual(lines(call, 40), ["codemode text(1);"]);
			const output = renderers.renderResult(result, options, theme, context({ durationMs: 2500 }));
			assert.deepEqual(lines(output, 40), ["✓ done · 1 line · 2.5s"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

test("live clocks tick and stop on completion, errors, abort, session switch and reload; HTML starts no timer", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	let now = 10000;
	mock.method(performance, "now", () => now);
	const intervals = mock.method(globalThis, "setInterval");
	const { renderers, events } = wiring();
	let redraws = 0;
	const start = () => {
		// Like Pi's host, invalidating the row also invalidates its child components.
		let component!: { render(width: number): string[]; invalidate?(): void };
		const ctx = context({ executionStarted: true, isPartial: true, invalidate: () => { redraws++; component?.invalidate?.(); } });
		renderers.renderCall!({ code: "text(1);" }, theme, ctx);
		ctx.state.codemodeCompactClock.startedAt = performance.now() - 4200;
		component = renderers.renderResult!({ content: [], details: { calls: [] } }, { ...options, isPartial: true }, theme, ctx);
		assert.match(lines(component)[0], /^… · 4\.2s$/);
		const count = intervals.mock.callCount();
		renderers.renderResult!({ content: [], details: { calls: [] } }, { ...options, isPartial: true }, theme, ctx);
		assert.equal(intervals.mock.callCount(), count, "Rerender must not duplicate timers");
		now += 1000;
		mock.timers.tick(1000);
		assert.match(lines(component)[0], /^… · 5\.2s$/, "Elapsed time updates at layout time");
		return ctx;
	};
	try {
		const pending = context({ isPartial: true });
		renderers.renderResult!({ content: [], details: { calls: [] } }, { ...options, isPartial: true }, theme, pending);
		assert.equal(intervals.mock.callCount(), 0, "No clock before execution");
		const finished = start();
		assert.equal(redraws, 1);
		renderers.renderResult!(result, options, theme, { ...finished, isPartial: false });
		mock.timers.tick(2000);
		assert.equal(redraws, 1, "Final result clears timer");

		const failed = start();
		renderers.renderResult!(result, { ...options, isPartial: true }, theme, { ...failed, isError: true });
		const beforeErrorTick = redraws;
		mock.timers.tick(2000);
		assert.equal(redraws, beforeErrorTick, "Error clears timer");
		for (const event of ["agent_end", "session_start", "session_shutdown"]) {
			const ctx = start();
			events.get(event)!();
			const stopped: number = redraws;
			mock.timers.tick(2000);
			assert.equal(redraws, stopped, event);
			renderers.renderResult!(result, { ...options, isPartial: true }, theme, ctx);
			mock.timers.tick(2000);
			assert.equal(redraws, stopped, "A stopped row cannot restart its clock");
		}
		const beforeHtml = intervals.mock.callCount();
		const html = createToolHtmlRenderer({ getToolRenderers: () => renderers, theme, cwd: process.cwd(), width: 40 });
		assert.ok(html.renderCall("html", "codemode", { code: "text(1);" }));
		const exported = html.renderResult("html", "codemode", [...result.content, png], result.details, false);
		assert.ok(exported.expanded.includes("1 image"));
		assert.ok(exported.expanded.includes("0.1s"));
		assert.equal(intervals.mock.callCount(), beforeHtml, "HTML export must not schedule timers");
	} finally {
		events.get("session_shutdown")!();
		mock.restoreAll();
		mock.timers.reset();
	}
});

test("real Pi host: padding is applied once and inline images still obey showImages", () => {
	initTheme("dark", false);
	const caps = getCapabilities();
	const { renderers, events } = wiring();
	try {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const name = "mcp__" + "x".repeat(100);
		const host = new ToolExecutionComponent("codemode", "host", { code: `await tools.${name}({});\ntext(1);` },
			{ showImages: false, outputPad: 4 }, renderers as ToolRenderers, { requestRender() {} }, process.cwd());
		host.setArgsComplete();
		host.markExecutionStarted();
		host.updateResult({ ...result, content: [...result.content, png], isError: false }, false);
		assert.equal(lines(host, 40).filter((line) => line.trim()).length, 2);
		assert.match(lines(host, 40).filter((line) => line.trim())[1], /0\.1s$/, "Real host falls back to header time without recorded durationMs");
		host.updateResult({ ...result, content: [...result.content, png], isError: false, durationMs: 2500 }, false);
		assert.match(lines(host, 40).filter((line) => line.trim())[1], /2\.5s$/, "Real host passes recorded durationMs through to the renderer");
		assert.ok(lines(host, 40).every((line) => visibleWidth(line) <= 40));
		if (typeof host.setOutputPad === "function") {
			host.setOutputPad(8);
			assert.equal(lines(host, 40).filter((line) => line.trim()).length, 2);
		}
		assert.ok(!host.render(40).some((line: string) => line.includes("\x1b_G")));
		host.setShowImages(true);
		assert.ok(host.render(40).some((line: string) => line.includes("\x1b_G")));
		host.setExpanded(true);
		assert.ok(lines(host, 40).join("\n").includes("hello"));
		host.setShowImages(false);
		assert.ok(!host.render(40).some((line: string) => line.includes("\x1b_G")));
	} finally {
		events.get("session_shutdown")!();
		setCapabilities(caps);
	}
});
