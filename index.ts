/**
 * Single-line summary renderer for pi's codemode tool.
 *
 * pi's default codemode renderer occupies significant vertical terminal space by displaying
 * a script preview (up to 10 lines), a nested tool call list, and an output preview (up to 5 lines).
 * This extension leaves execution and model exposure untouched while compacting the display
 * into one single-line row per call; the running and result rows replace the call row once they exist:
 *
 *   Call:    codemode todo, write, bash · 118 lines   (referenced tools approximation)
 *   Running: codemode … bash · 3 calls · 4s
 *   Result:  codemode ✓ todo, write, bash · 4 lines · 1 image · 0.1s
 *   Error:   codemode ✗ read — Error: ENOENT: no such file or directory · 0.4s
 *   Aborted: codemode ⊘ aborted · bash cancelled · 4.9s
 *
 * Expanding (Ctrl+O) reveals syntax-highlighted code, per-call timings, models cost, errors, and full output.
 *
 * Wiring: We register a renderer resolver (pi.registerToolRenderer) that attaches the compact
 * renderers to the `codemode` tool by name. The built-in extension's definition (execution, store
 * persistence, models API, namespaces) stays untouched, so nothing is re-registered: no replacement
 * warning, no mid-session tool redefinition, and the renderers apply no matter which extension or SDK
 * factory registered `codemode` (resolvers fall back to the registered renderers via next()).
 *
 * Known design trade-offs (static analysis approximation):
 * - Tool preview in callLine uses a lightweight scanner rather than a full JS parser: dynamic accesses
 *   (tools[fn]) and aliases (const { read } = tools) are omitted, and rare regex-versus-division
 *   ambiguities may hide or add a name.
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
/** Narrowest result summary that still gets the codemode title in front of it. */
const MIN_TITLED = 24;
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

/** Words after which `/` starts a regex literal instead of a division. */
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

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

/** End-truncates text to max columns, keeping its start, which carries an error's meaning. */
export function clipEnd(text: string, max: number): string {
	if (max <= 0) return "";
	return visibleWidth(text) <= max ? text : `${sliceByColumn(text, 0, max - 1).trimEnd()}…`;
}

/** Caps the actual component width, not the terminal width (Pi applies shell padding). */
export function summaryWidth(columns?: number): number {
	if (typeof columns !== "number" || !Number.isFinite(columns) || columns < 0) return MAX_SUMMARY;
	return Math.min(MAX_SUMMARY, Math.floor(columns));
}

/**
 * Index ranges of strings, template-literal text, comments, and regex literals in script code.
 * `${...}` interpolations stay code, so tool calls inside template literals still count.
 * Like JS tokenizers, the previous token tells a regex literal from a division.
 * shortcut: `}` before `/` always reads as an expression end and `x++ / y` as a regex; a real tokenizer would track both.
 */
export function noiseSpans(code: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	// Unclosed `{` count inside each enclosing `${`
	const depths: number[] = [];
	// Last significant code character, and whether a string, template, or regex literal ended after it
	let prev = -1;
	let afterLiteral = false;
	const regexAllowed = () => {
		if (afterLiteral) return false;
		if (prev < 0) return true;
		const ch = code[prev];
		if (/[\w$]/.test(ch)) return REGEX_AFTER_WORD.test(code.slice(Math.max(0, prev - 10), prev + 1));
		return !")]}".includes(ch);
	};
	// Scans template text from `start` (its backtick or the `}` closing an interpolation) to the closing backtick or next `${`
	const template = (start: number): number => {
		for (let i = start + 1; i < code.length; i++) {
			if (code[i] === "\\") i++;
			else if (code[i] === "`") {
				spans.push([start, i + 1]);
				afterLiteral = true;
				return i + 1;
			} else if (code[i] === "$" && code[i + 1] === "{") {
				spans.push([start, i + 2]);
				depths.push(0);
				prev = i + 1;
				afterLiteral = false;
				return i + 2;
			}
		}
		spans.push([start, code.length]);
		return code.length;
	};
	let i = 0;
	while (i < code.length) {
		const ch = code[i];
		const start = i;
		if (ch === '"' || ch === "'") {
			let j = i + 1;
			while (j < code.length && code[j] !== ch && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
			i = Math.min(j + 1, code.length);
			spans.push([start, i]);
			afterLiteral = true;
		} else if (ch === "`") {
			i = template(i);
		} else if (ch === "/" && code[i + 1] === "/") {
			const end = code.indexOf("\n", i);
			i = end < 0 ? code.length : end;
			spans.push([start, i]);
		} else if (ch === "/" && code[i + 1] === "*") {
			const end = code.indexOf("*/", i + 2);
			i = end < 0 ? code.length : end + 2;
			spans.push([start, i]);
		} else if (ch === "}" && depths.at(-1) === 0) {
			depths.pop();
			i = template(i);
		} else {
			let end = -1;
			if (ch === "/" && regexAllowed()) {
				// A regex literal ends on its line at the first `/` outside a character class
				let inClass = false;
				for (let j = i + 1; j < code.length && code[j] !== "\n"; j++) {
					if (code[j] === "\\") j++;
					else if (code[j] === "[") inClass = true;
					else if (code[j] === "]") inClass = false;
					else if (code[j] === "/" && !inClass) {
						end = j + 1;
						break;
					}
				}
			}
			if (end > 0) {
				while (end < code.length && /[\w$]/.test(code[end])) end++;
				spans.push([start, end]);
				afterLiteral = true;
				i = end;
			} else {
				if (depths.length > 0 && ch === "{") depths[depths.length - 1]++;
				else if (depths.length > 0 && ch === "}") depths[depths.length - 1]--;
				if (!/\s/.test(ch)) {
					prev = i;
					afterLiteral = false;
				}
				i++;
			}
		}
	}
	return spans;
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

	const spans = noiseSpans(code);
	const isInsideNoise = (index: number) => spans.some(([start, end]) => index >= start && index < end);

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

/** Validates Pi's recorded duration and converts milliseconds to display seconds. */
function recordedDurationSeconds(durationMs: RenderContext["durationMs"]): number | undefined {
	return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
		? durationMs / 1000 : undefined;
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

/** Calculates total USD cost from nested calls; undefined if no call reported a positive cost (free/unpriced models report 0). */
export function totalCost(calls: readonly NestedCall[]): number | undefined {
	const priced = calls.filter((call) => (call.cost ?? 0) > 0 && Number.isFinite(call.cost));
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
export function runningLine(theme: ThemeLike, calls: readonly NestedCall[], max: number = MAX_SUMMARY, elapsed?: number, planned?: string): string {
	const active = calls.filter((call) => call.status === "running");
	// Before the first nested call, the script's own summary says what is about to run
	const label = namesLabel(countNames((active.length > 0 ? active : calls).map((call) => call.name))) || planned || "running";
	const head = theme.fg("warning", "…");
	const total = calls.length;
	const tail = theme.fg("dim",
		(total > 0 ? ` · ${total} ${total === 1 ? "call" : "calls"}` : "") +
		// Redrawn once a second, so a decimal would only ever show .0
		(elapsed !== undefined ? ` · ${Math.floor(elapsed)}s` : ""));
	const budget = max - visibleWidth(head) - visibleWidth(tail) - 1;
	const tools = label && budget > 0 ? ` ${theme.fg("accent", clip(label, budget))}` : "";
	return truncateToWidth(`${head}${tools}${tail}`, max, "…");
}

/** Formats a single collapsed result line for success or failure. */
export function resultLine(
	theme: ThemeLike,
	view: { calls: readonly NestedCall[]; body: string; durationSeconds?: number; images?: number; truncated: boolean; failed: boolean; script?: string },
	max: number = MAX_SUMMARY,
): string {
	const budget = Math.max(0, max - ICON_COLUMNS);
	if (view.failed) {
		const error = errorLine(view.body);
		// A stop (Esc, a parent's abort) is not a script bug, so it gets Pi's cancelled mark instead of ✗
		const aborted = error.startsWith("Script aborted:");
		// An uncaught tool failure rethrows the tool's own error text; a caught one (try/catch, allSettled) never
		// reaches the script error, so only a call whose error the script error repeats is named.
		const failing = aborted ? undefined : [...view.calls].reverse().find((call) => {
			// Pi cuts long call errors with "..."; the start still matches
			const first = plain(call.error ?? "").trim().split("\n")[0].trim().replace(/\.\.\.$/, "");
			return call.status === "error" && first !== "" && error.includes(first);
		})?.name;
		const label = aborted ? "aborted" : `${failing ? `${failing} — ` : ""}${error || "Script failed"}`;
		// Aborts and Promise.all rejections cancel sibling calls; name them so the row says what never finished
		const cancelled = namesLabel(countNames(view.calls.filter((call) => call.status === "cancelled").map((call) => call.name)));
		const cost = totalCost(view.calls);
		const stats = (view.images ? ` · ${view.images} ${view.images === 1 ? "image" : "images"}` : "") +
			(view.durationSeconds !== undefined ? ` · ${view.durationSeconds.toFixed(1)}s` : "") +
			(cost !== undefined ? ` · $${formatCost(cost)}` : "");
		const withCancelled = (cancelled ? ` · ${cancelled} cancelled` : "") + stats;
		// The error outranks the cancelled list: it keeps at least half the row before that list is dropped
		const tail = budget - visibleWidth(withCancelled) >= Math.min(visibleWidth(label), budget / 2) ? withCancelled : stats;
		const row = `${aborted ? "⊘" : "✗"} ${clipEnd(label, budget - visibleWidth(tail))}${tail}`;
		return truncateToWidth(theme.fg(aborted ? "muted" : "error", row), max, "…");
	}
	// The final row stands alone (the call row hides), so a script without tool calls names its first code line
	const names = namesLabel(countNames(view.calls.map((call) => call.name))) || firstCodeLine(plain(view.script ?? "")) || "done";
	// Scripts that catch nested failures (try/catch, Promise.allSettled) still succeed; keep those failures visible
	const errored = namesLabel(countNames(view.calls.filter((call) => call.status === "error").map((call) => call.name)));
	const parts: string[] = [];
	const lines = countLines(view.body);
	if (lines > 0) parts.push(`${lines} ${lines === 1 ? "line" : "lines"}`);
	if (view.images) parts.push(`${view.images} ${view.images === 1 ? "image" : "images"}`);
	if (view.durationSeconds !== undefined) parts.push(`${view.durationSeconds.toFixed(1)}s`);
	const cost = totalCost(view.calls);
	if (cost !== undefined) parts.push(`$${formatCost(cost)}`);
	if (view.truncated) parts.push("truncated");
	const mark = errored ? ` · ✗ ${errored}` : "";
	const stats = parts.map((part) => ` · ${part}`).join("");
	const room = budget - visibleWidth(mark) - visibleWidth(stats);
	return truncateToWidth(
		`${theme.fg("success", "✓")} ${theme.fg("dim", clip(names, room))}${errored ? `${theme.fg("dim", " · ")}${theme.fg("error", "✗")} ${theme.fg("dim", errored)}` : ""}${theme.fg("dim", stats)}`,
		max, "…");
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

/** Formats a single call detail row for expanded view; args and errors stay whole, like Pi's own expanded rows. */
function callDetail(theme: Theme, call: NestedCall): string {
	const duration = call.durationMs === undefined
		? ""
		: theme.fg("dim", ` ${call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}`);
	const cost = call.cost ? theme.fg("dim", ` $${formatCost(call.cost)}`) : "";
	const args = plain(call.args);
	const line = `${statusIcon(call.status, theme)} ${theme.fg("toolTitle", call.name)}${args ? ` ${theme.fg("muted", args)}` : ""}${duration}${cost}`;
	if (!call.error) return line;
	return `${line}\n${plain(call.error).split("\n").map((l) => theme.fg("error", `    ${l}`)).join("\n")}`;
}

/**
 * Build summaries at layout time so resize, shell padding, and HTML widths are respected.
 * The TUI renders every row on every frame, so a build is reused until the width changes or the
 * row is invalidated (rerender, timer tick, theme change).
 */
class SummaryText extends Text {
	build: (width: number) => string = () => "";
	private builtWidth?: number;

	override invalidate(): void {
		super.invalidate();
		this.builtWidth = undefined;
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const max = summaryWidth(width);
		if (max !== this.builtWidth) {
			this.setText(this.build(max));
			this.builtWidth = max;
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

/** Script identifier of a tool name, mirroring pi-codemode's toCodemodeIdentifier (`my-tool` → `my_tool`). */
export function codemodeIdentifier(name: string): string {
	return name.replace(/^[^A-Za-z_$]|[^\w$]/gu, "_") || "_";
}

/** Retrieves currently registered tool names (and their script identifiers) from pi to filter false positives. */
function registeredToolNames(pi: ExtensionAPI): Set<string> | null {
	try {
		return new Set(pi.getAllTools().flatMap((tool) => [tool.name, codemodeIdentifier(tool.name)]));
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
	const state = context.state;
	// The running row shows this until the first nested call reports in
	if (context.argsComplete && code) state.codemodeCompactPlan = codeSummary(plain(code).trim(), isRegisteredTool);
	return textComponent(context.lastComponent, (width) =>
		// Once a result exists, the collapsed result row carries the summary alone and the call row gives up its line.
		// Read at layout time: Pi renders the call before the result sets the flag.
		!context.expanded && state.codemodeCompactResult ? "" : callLine(theme, code, width, isRegisteredTool) + (body ? `\n${body}` : ""));
}

export function renderResult(
	result: CodemodeRenderResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Text {
	const calls = result.details?.calls ?? [];
	const { body, wallTime: headerSeconds } = splitScriptOutput(result.content ?? []);
	// HTML exports and sessions recorded before Pi 1.1 carry no durationMs; the script header still has the time.
	const durationSeconds = recordedDurationSeconds(context.durationMs) ?? headerSeconds;
	const images = result.content?.filter((item) => item.type === "image").length ?? 0;
	const clock = executionClock(context);
	if (clock && (!options.isPartial || context.isError)) stopClock(clock);
	const failed = context.isError === true || result.isError === true;
	context.state.codemodeCompactResult = true;
	const planned = context.state.codemodeCompactPlan as string | undefined;
	const code = (context.args as { code?: unknown } | undefined)?.code;
	const script = typeof code === "string" ? code : undefined;
	return textComponent(context.lastComponent, (width) => {
		const elapsed = clock ? Math.max(0, (clock.endedAt ?? performance.now()) - clock.startedAt) / 1000 : undefined;
		const final = (max: number) => resultLine(theme, {
			calls, body, durationSeconds, images,
			truncated: result.details?.fullOutputPath !== undefined,
			failed, script,
		}, max);
		const summary = (max: number) => options.isPartial ? runningLine(theme, calls, max, elapsed, planned) : final(max);
		// The lone collapsed row takes over the call row's title; narrow rows keep the status instead
		const title = theme.fg("toolTitle", theme.bold("codemode"));
		const room = width - visibleWidth(title) - 1;
		const lines = [!options.expanded && room >= MIN_TITLED ? `${title} ${summary(room)}` : summary(width)];
		if (options.expanded) {
			for (const call of calls) lines.push(callDetail(theme, call));
			const fullOutputPath = result.details?.fullOutputPath;
			if (fullOutputPath) lines.push(theme.fg("muted", `Full output: ${fullOutputPath}`));
			const output = plain(body).trim();
			if (output) lines.push(output.split("\n").map((line) => theme.fg(failed ? "error" : "toolOutput", line)).join("\n"));
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
						// Rows rerender on every update and timer tick; once the script is final, its tool set is too.
						renderCall(args as { code?: unknown } | undefined, theme, context, context.argsComplete
							? (context.state.codemodeCompactTools ??= registeredToolNames(pi))
							: registeredToolNames(pi)),
					renderResult: (result, options, theme, context) => {
						const component = renderResult(result as unknown as CodemodeRenderResult, options, theme, context);
						const clock = context.state.codemodeCompactClock as Clock | undefined;
						if (clock) {
							if (!options.isPartial || context.isError) {
								clocks.delete(clock);
							} else if (clock.endedAt === undefined && !clock.interval) {
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
