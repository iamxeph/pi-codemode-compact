/**
 * Single-line summary renderer for pi's codemode tool.
 *
 * pi's default codemode renderer occupies significant vertical terminal space by displaying
 * a script preview (up to 10 lines), a nested tool call list, and an output preview (up to 5 lines).
 * This extension leaves execution and model exposure untouched while compacting the display
 * into single-line rows (each collapsed component is 1 line; after completion, pi stacks them into 2 lines total):
 *
 *   Call:    codemode todo, write, bash · 118 lines   (referenced tools approximation)
 *   Running: … bash · 3 calls · 4.2s
 *   Result:  ✓ todo, write, bash · 4 lines · 1 image · 0.1s
 *   Error:   ✗ write — TypeError: tools.foo is not a function · 0.4s
 *
 * Expanding (Ctrl+O) reveals syntax-highlighted code, per-call timings, models cost, errors, and full output.
 *
 * Wiring: We register a renderer resolver (pi.registerToolRenderer, pi >= 1.0.1) that attaches the compact
 * renderers to the `codemode` tool by name. The built-in extension's definition (execution, store
 * persistence, models API, namespaces) stays untouched, so nothing is re-registered: no replacement
 * warning, no mid-session tool redefinition, and the renderers apply no matter which extension or SDK
 * factory registered `codemode` (resolvers fall back to the registered renderers via next()).
 *
 * Known design trade-offs (static analysis approximation):
 * - Tool preview in callLine uses lightweight regex-based static analysis rather than a full JS AST parser:
 *   template-literal interpolations (${tools.x}), dynamic accesses (tools[fn]), and regex literals
 *   containing tool accesses (/tools.read/g) are omitted or may yield false positives.
 * - Authoritative, exact execution history, timings, and cost are always reported in resultLine via details.calls.
 */
import {
	highlightCode,
	type CodemodeToolDetails,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	sliceByColumn,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

/** Minimal theme surface required by the summary builders (subset of pi-tui Theme). */
export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Render context type derived from pi's ToolDefinition contract. */
export type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

/** Nested tool call structure provided in result.details.calls. */
export type NestedCall = CodemodeToolDetails["calls"][number];

/** Tool usage entry aggregated from script source. */
export interface ToolUsage {
	name: string;
	count: number;
}

/**
 * Result structure accepted by renderResult.
 * Matches AgentToolResult while accommodating loose content objects (e.g. image blocks with mimeType).
 */
export interface CodemodeRenderResult {
	content?: ReadonlyArray<{ type: string; text?: string; [key: string]: unknown }>;
	details?: CodemodeToolDetails;
	isError?: boolean;
}

/** Keep summaries compact even when their container is very wide. */
const MAX_SUMMARY = 96;
/**
 * Maximum number of tool names listed before summarizing with '+N'.
 * Matches pi's default CALL_PREVIEW_COUNT (8) for parity.
 */
const MAX_NAMES = 8;
/** Terminal column width consumed by the result status icon and space ("✓ " / "✗ "). */
const ICON_COLUMNS = 2;

/**
 * Regex for tools.read(...) style calls.
 * Applied after stripping comments and strings to prevent false positives.
 */
const TOOL_DOT = /\btools\s*\.\s*([A-Za-z_$][\w$]*)/g;
/**
 * Regex for tools["read"](...) style calls.
 * Matched against raw code with index checking to ensure the access is not inside a string or comment.
 */
const TOOL_KEY = /\btools\s*\[\s*["']([^"']+)["']\s*\]/g;

/**
 * Strips strings, template literals, and comments in a single pass:
 * 1. Double-quoted strings: "(?:\\.|[^"\\\n])*"
 * 2. Single-quoted strings: '(?:\\.|[^'\\\n])*'
 * 3. Template literals: `(?:\\.|[^`\\])*`
 * 4. Multi-line comments: /\*[\s\S]*?\* /
 * 5. Single-line comments: //[^\n]*
 * Replaced with spaces so that word boundaries (\b) are preserved.
 */
const STRINGS_AND_COMMENTS = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/** Regex matching pi's script execution header. */
const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n/;

/**
 * Strips ANSI escapes, OSC/APC/DCS sequences, control characters, carriage returns,
 * and expands tabs to 3 spaces.
 */
export function plain(text: string): string {
	return stripTerminalSequences(text)
		// 8-bit CSI escape sequences not covered by stripTerminalSequences
		.replace(/\u009b[0-9;?]*[A-Za-z]/g, "")
		// Non-printable control characters except newline and tab
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
		.replace(/\r/g, "")
		.replace(/\t/g, "   ");
}

/**
 * Middle-truncates text to fit within max columns (wide-character aware),
 * preserving head and tail with an ellipsis in between.
 * Empty and one-column budgets remain safe on very narrow terminals.
 */
export function clip(text: string, max: number): string {
	if (max <= 0) return "";
	if (visibleWidth(text) <= max) return text;
	if (max === 1) return "…";
	const head = Math.ceil((max - 1) / 2);
	const tail = max - 1 - head;
	return `${sliceByColumn(text, 0, head)}…${tail > 0 ? sliceByColumn(text, visibleWidth(text) - tail, tail) : ""}`;
}

/** Caps the actual component width, not the terminal width (Pi applies shell padding). */
export function summaryWidth(columns?: number): number {
	if (typeof columns !== "number" || !Number.isFinite(columns) || columns < 0) return MAX_SUMMARY;
	return Math.min(MAX_SUMMARY, Math.floor(columns));
}

/**
 * Aggregates nested tool calls from script code in order of appearance.
 * Filters out references inside comments and string literals.
 * If isRegisteredTool filter is provided, only matches recognized tool names.
 */
export function toolUsage(
	code: string,
	isRegisteredTool?: (name: string) => boolean,
): ToolUsage[] {
	const counts = new Map<string, number>();
	const add = (name: string | undefined) => {
		if (name && (!isRegisteredTool || isRegisteredTool(name))) {
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	};

	const noiseSpans = [...code.matchAll(STRINGS_AND_COMMENTS)].map((m) => [
		m.index ?? 0,
		(m.index ?? 0) + m[0].length,
	]);
	const isInsideNoise = (index: number) => noiseSpans.some(([start, end]) => index >= start && index < end);

	const matches: Array<{ name: string; index: number }> = [];

	for (const match of code.matchAll(TOOL_DOT)) {
		const index = match.index ?? 0;
		if (!isInsideNoise(index)) {
			matches.push({ name: match[1], index });
		}
	}

	for (const match of code.matchAll(TOOL_KEY)) {
		const index = match.index ?? 0;
		if (!isInsideNoise(index)) {
			matches.push({ name: match[1], index });
		}
	}

	// Preserve script appearance order across both dot and bracket notations
	matches.sort((a, b) => a.index - b.index);
	for (const { name } of matches) {
		add(name);
	}

	return [...counts].map(([name, count]) => ({ name, count }));
}

/** Formats tool usage counts into a readable label (e.g. 'read×3, bash'). */
export function namesLabel(usage: ReadonlyArray<ToolUsage>): string {
	const shown = usage
		.slice(0, MAX_NAMES)
		.map(({ name, count }) => (count > 1 ? `${name}×${count}` : name))
		.join(", ");
	return usage.length > MAX_NAMES ? `${shown} +${usage.length - MAX_NAMES}` : shown;
}

/** Aggregates an array of names into counts preserving appearance order. */
export function countNames(names: readonly string[]): ToolUsage[] {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return [...counts].map(([name, count]) => ({ name, count }));
}

/** Returns the first non-empty, non-comment line of code. */
export function firstCodeLine(code: string): string {
	for (const raw of code.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
		return line;
	}
	return "";
}

/** Returns a concise summary: tool names list if any tools are used, otherwise first code line. */
export function codeSummary(code: string, isRegisteredTool?: (name: string) => boolean): string {
	const usage = toolUsage(code, isRegisteredTool);
	return usage.length > 0 ? namesLabel(usage) : firstCodeLine(code);
}

/** Counts non-empty lines in text. */
export function countLines(text: string): number {
	return text.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * Splits script execution header from output body and extracts wall time in seconds.
 * Handles both multi-block output and unified single-block output.
 */
export function splitScriptOutput(
	content: ReadonlyArray<{ type: string; text?: string; [key: string]: unknown }>,
): { body: string; wallTime?: number } {
	const texts = content
		.filter((item) => item.type === "text")
		.map((item) => item.text ?? "")
		.filter((text) => text !== "");
	const first = texts[0] ?? "";
	const header = SCRIPT_HEADER.exec(first);
	if (!header) return { body: texts.join("\n") };
	const wallTime = Number(header[1]);
	const body = [first.slice(header[0].length), ...texts.slice(1)].filter((text) => text !== "").join("\n");
	return { body, wallTime: Number.isFinite(wallTime) ? wallTime : undefined };
}

/**
 * Extracts the first non-empty error line following the last 'Script error:' marker.
 * Skips stack frame traces ('at ...') to find the actual error description.
 */
export function errorLine(body: string): string {
	const lines = plain(body)
		.split("\n")
		.map((line) => line.trim());
	// pi appends "Script error:" after output blocks, so the last marker is authoritative
	const at = lines.findLastIndex((line) => line.startsWith("Script error:"));
	if (at < 0) return lines.find(Boolean) ?? "";
	const next = lines.slice(at + 1).find((line) => line && !line.startsWith("at "));
	const inline = lines[at].slice("Script error:".length).trim();
	return next || inline;
}

/** Formats USD cost: shows 2 decimal places if >= $0.01, otherwise 2 significant digits. */
export function formatCost(cost: number): string {
	return cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2);
}

/** Calculates total USD cost from nested calls; undefined if no calls reported cost. */
export function totalCost(calls: readonly NestedCall[]): number | undefined {
	const priced = calls.filter((call) => typeof call.cost === "number" && Number.isFinite(call.cost));
	return priced.length > 0 ? priced.reduce((sum, call) => sum + (call.cost ?? 0), 0) : undefined;
}

/** Formats a single collapsed call line. */
export function callLine(
	theme: ThemeLike,
	code: string | null,
	max: number = MAX_SUMMARY,
	isRegisteredTool?: (name: string) => boolean,
): string {
	const title = theme.fg("toolTitle", theme.bold("codemode"));
	if (code === null) return truncateToWidth(`${title} ${theme.fg("error", "[invalid arg]")}`, max, "…");
	const script = plain(code).trim();
	if (!script) return truncateToWidth(title, max, "…");
	const lines = countLines(script);
	const summary = codeSummary(script, isRegisteredTool);
	const tail = lines > 1 ? theme.fg("dim", ` · ${lines} lines`) : "";
	const budget = max - visibleWidth(title) - visibleWidth(tail) - 1;
	const head = summary && budget > 0 ? ` ${theme.fg("accent", clip(summary, budget))}` : "";
	return truncateToWidth(`${title}${head}${tail}`, max, "…");
}

/** Formats an in-progress execution line with currently running tools and total call count. */
export function runningLine(theme: ThemeLike, calls: readonly NestedCall[], max: number = MAX_SUMMARY, elapsed?: number): string {
	const active = calls.filter((call) => call.status === "running");
	const label = namesLabel(countNames((active.length > 0 ? active : calls).map((call) => call.name)));
	const head = theme.fg("warning", "…");
	const total = calls.length;
	const tail = theme.fg("dim",
		(total > 0 ? ` · ${total} ${total === 1 ? "call" : "calls"}` : "") +
		(elapsed !== undefined ? ` · ${elapsed.toFixed(1)}s` : ""));
	const budget = max - visibleWidth(head) - visibleWidth(tail) - 1;
	const tools = label && budget > 0 ? ` ${theme.fg("accent", clip(label, budget))}` : "";
	return truncateToWidth(`${head}${tools}${tail}`, max, "…");
}

/** Formats a single collapsed result line for success or failure. */
export function resultLine(
	theme: ThemeLike,
	view: { calls: readonly NestedCall[]; body: string; wallTime?: number; images?: number; truncated: boolean; failed: boolean },
	max: number = MAX_SUMMARY,
): string {
	const budget = Math.max(0, max - ICON_COLUMNS);
	if (view.failed) {
		// ponytail: When multiple calls fail, findLast picks the latest failing call as the most likely root cause
		const failing = [...view.calls].reverse().find((call) => call.status === "error")?.name;
		const label = `${failing ? `${failing} — ` : ""}${errorLine(view.body) || "Script failed"}`;
		const tail = (view.images ? ` · ${view.images} ${view.images === 1 ? "image" : "images"}` : "") +
			(view.wallTime !== undefined ? ` · ${view.wallTime.toFixed(1)}s` : "");
		return truncateToWidth(theme.fg("error", `✗ ${clip(label, budget - visibleWidth(tail))}${tail}`), max, "…");
	}
	const parts: string[] = [];
	parts.push(namesLabel(countNames(view.calls.map((call) => call.name))) || "done");
	const lines = countLines(view.body);
	if (lines > 0) parts.push(`${lines} ${lines === 1 ? "line" : "lines"}`);
	if (view.images) parts.push(`${view.images} ${view.images === 1 ? "image" : "images"}`);
	if (view.wallTime !== undefined) parts.push(`${view.wallTime.toFixed(1)}s`);
	const cost = totalCost(view.calls);
	if (cost !== undefined) parts.push(`$${formatCost(cost)}`);
	if (view.truncated) parts.push("truncated");
	return truncateToWidth(`${theme.fg("success", "✓")} ${theme.fg("dim", clip(parts.join(" · "), budget))}`, max, "…");
}

function statusIcon(status: NestedCall["status"], theme: Theme): string {
	switch (status) {
		case "running":
			return theme.fg("warning", "…");
		case "ok":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "cancelled":
		default:
			return theme.fg("muted", "⊘");
	}
}

/** Formats a single call detail row for expanded view. */
function callDetail(theme: Theme, call: NestedCall, max: number): string {
	const duration = call.durationMs === undefined
		? ""
		: theme.fg("dim", ` ${call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}`);
	const cost = call.cost !== undefined ? theme.fg("dim", ` $${formatCost(call.cost)}`) : "";
	const line = `${statusIcon(call.status, theme)} ${theme.fg("toolTitle", call.name)} ${theme.fg("muted", clip(plain(call.args), max))}${duration}${cost}`;
	if (!call.error) return line;
	const errorSummary = clip(plain(call.error).replace(/\s*\n\s*/g, " "), max);
	return `${line}\n  ${theme.fg("error", errorSummary)}`;
}

/** Build summaries at layout time so resize, shell padding, and HTML widths are respected. */
class SummaryText extends Text {
	build: (width: number) => string = () => "";
	private renderedText?: string;

	override render(width: number): string[] {
		if (width <= 0) return [];
		const text = this.build(summaryWidth(width));
		if (text !== this.renderedText) {
			this.setText(text);
			this.renderedText = text;
		}
		return super.render(width);
	}
}

function textComponent(lastComponent: unknown, build: SummaryText["build"]): Text {
	const component = lastComponent instanceof SummaryText ? lastComponent : new SummaryText("", 0, 0);
	component.build = build;
	component.invalidate();
	return component;
}

interface Clock {
	startedAt: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
}

function executionClock(context: RenderContext): Clock | undefined {
	if (context.executionStarted && context.isPartial) {
		context.state.codemodeCompactClock ??= { startedAt: performance.now() };
	}
	return context.state.codemodeCompactClock;
}

function stopClock(clock: Clock): void {
	clock.endedAt ??= performance.now();
	clearInterval(clock.interval);
	clock.interval = undefined;
}

/** Retrieves currently registered tool names from pi to filter false positives. */
function registeredToolNames(pi: ExtensionAPI): Set<string> | null {
	try {
		return new Set(pi.getAllTools().map((tool) => tool.name));
	} catch {
		return null;
	}
}

export function renderCall(
	args: { code?: unknown } | undefined,
	theme: Theme,
	context: RenderContext,
	knownTools: Set<string> | null,
): Text {
	// Stream states: string = ready, null = invalid complete arg, "" = streaming in-progress
	const code = typeof args?.code === "string" ? args.code : context.argsComplete ? null : "";
	executionClock(context);
	const isRegisteredTool = knownTools && knownTools.size > 0 ? (name: string) => knownTools.has(name) : undefined;
	let body = "";
	if (context.expanded && code) {
		const script = plain(code).trimEnd();
		try {
			body = highlightCode(script, "javascript").join("\n");
		} catch {
			body = script; // Fallback if syntax highlighting fails
		}
	}
	return textComponent(context.lastComponent, (width) =>
		callLine(theme, code, width, isRegisteredTool) + (body ? `\n${body}` : ""));
}

export function renderResult(
	result: CodemodeRenderResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Text {
	const calls = result.details?.calls ?? [];
	const { body, wallTime } = splitScriptOutput(result.content ?? []);
	const duration = context.durationMs;
	const recordedTime = typeof duration === "number" && Number.isFinite(duration) && duration >= 0
		? duration / 1000 : wallTime;
	const images = result.content?.filter((item) => item.type === "image").length ?? 0;
	const clock = executionClock(context);
	if (clock && (!options.isPartial || context.isError)) stopClock(clock);
	return textComponent(context.lastComponent, (width) => {
		const elapsed = clock ? Math.max(0, (clock.endedAt ?? performance.now()) - clock.startedAt) / 1000 : undefined;
		const lines = options.isPartial
			? [runningLine(theme, calls, width, elapsed)]
			: [resultLine(theme, {
					calls, body, wallTime: recordedTime, images,
					truncated: result.details?.fullOutputPath !== undefined,
					failed: context.isError === true || result.isError === true,
				}, width)];
		if (options.expanded) {
			for (const call of calls) lines.push(callDetail(theme, call, width));
			const fullOutputPath = result.details?.fullOutputPath;
			if (fullOutputPath) lines.push(theme.fg("muted", `Full output: ${fullOutputPath}`));
			const output = plain(body).trim();
			if (output) lines.push(output.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n"));
		}
		return lines.join("\n");
	});
}

export default function codemodeCompact(pi: ExtensionAPI): void {
	const clocks = new Set<Clock>();
	const clearClocks = () => {
		for (const clock of clocks) stopClock(clock);
		clocks.clear();
	};
	// session_shutdown also fires on reload; agent_end covers aborted runs without another render.
	pi.on("session_shutdown", clearClocks);
	pi.on("session_start", clearClocks);
	pi.on("agent_end", clearClocks);
	// Resolvers run in extension load order and next() returns what the remaining resolvers, then the
	// registered tool, would draw. Returning our renderers overrides only the slots we define;
	// spreading next() preserves any other slot (renderShell) another definition supplies.
	pi.registerToolRenderer((toolName, next) =>
		toolName === "codemode"
			? {
					...next(),
					renderCall: (args: unknown, theme: Theme, context: RenderContext) =>
						renderCall(args as { code?: unknown } | undefined, theme, context, registeredToolNames(pi)),
					renderResult: (result, options, theme, context) => {
						const component = renderResult(result as unknown as CodemodeRenderResult, options, theme, context);
						const clock = context.state.codemodeCompactClock as Clock | undefined;
						if (clock) {
							if (!options.isPartial || context.isError) {
								clocks.delete(clock);
							} else if (clock.endedAt === undefined && !clock.interval) {
								// ponytail: Pi < 1.2 can delay the first partial result until a nested call;
								// upgrading Pi enables immediate ticks without replacing tool execution.
								clock.interval = setInterval(() => context.invalidate(), 1000);
								clock.interval.unref();
								clocks.add(clock);
							}
						}
						return component;
					},
				}
			: next());
}
