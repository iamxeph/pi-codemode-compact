# pi-codemode-compact

A compact single-line summary renderer for [Pi Coding Agent](https://github.com/earendil-works/pi)'s `codemode` tool.

> I love `codemode` and run it with `codemode.mode: "only"`, but the default multi-line renderer took up way too much precious vertical screen space on every turn. So I vibe-coded this to reclaim my terminal.

**pi-codemode-compact** leaves execution, sandboxing, and LLM context completely untouched while compacting the interactive terminal display into clean, information-dense single-line rows (collapsed call and result rows take 1 line each; stacked into 2 lines total upon completion):

```text
Call:    codemode todo, write, bash · 118 lines
Result:  ✓ todo, write, bash · 4 lines · 0.1s · $0.02
Error:   ✗ write — TypeError: tools.foo is not a function
```

Pressing **Ctrl+O** expands the row to inspect the full syntax-highlighted script, per-call timings, models cost breakdown, errors, and complete output.

---

## Comparison

| Default `codemode` (10–20+ lines) | With `pi-codemode-compact` (2 lines) |
| :---: | :---: |
| ![Default codemode](assets/pi-default.webp) | ![pi-codemode-compact](assets/pi-codemode-compact.webp) |

---

## Features

- **Space-Saving**: Replaces 10–20 rows of `codemode` output with a clean 2-line summary.
- **Key Metrics at a Glance**: Tools used, line count, execution time, and LLM cost (`$cost`).
- **Fully Expandable**: Press **Ctrl+O** anytime to inspect the full script source and raw output.

---

## Requirements

- **Pi Coding Agent**: `>= 0.99.0` (when the `codemode` tool was introduced)

---

## Installation

```bash
pi install npm:pi-codemode-compact
```

---

## How It Works

**pi-codemode-compact** invokes Pi's official `createCodemodeExtension()` factory to preserve all default execution behaviors, sandbox configuration, models API, and store persistence, while intercepting `registerTool` via a lightweight Proxy shim to inject compact TUI renderers for `codemode`.

Registration is deferred to the first `session_start` so the built-in `codemode` extension is never replaced (no startup warning): the extension's definition is registered late and takes precedence over the built-in one in the session tool registry. Auxiliary tools registered by the host remain untouched.

---

## Known Limitations

- **Static Analysis Approximation**: The call line preview uses regex-based static scanning. Dynamic property accesses (`tools[fn]`), template-literal interpolations (`${tools.x}`), and regex literals containing tool accesses (`/tools.read/g`) may be omitted or yield false positives. The result line always displays the authoritative runtime execution history once finished.

---

## Development & Testing

Clone the repository and run tests:

```bash
# Install dependencies
pnpm install

# Run assertion test suite
pnpm test

# Check TypeScript types
pnpm run typecheck
```

---

## License

MIT
