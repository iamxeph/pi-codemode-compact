# pi-codemode-compact

A compact single-line summary renderer for [Pi Coding Agent](https://github.com/earendil-works/pi)'s `codemode` tool.

> I love `codemode` and run it with `codemode.mode: "only"`, but the default multi-line renderer took up way too much precious vertical screen space on every turn. So I vibe-coded this to reclaim my terminal.

**pi-codemode-compact** leaves execution, sandboxing, and LLM context completely untouched while compacting the interactive terminal display into clean, information-dense single-line rows (collapsed call and result rows take 1 line each; stacked into 2 lines total upon completion):

```text
Call:    codemode todo, write, bash · 118 lines
Running: … bash · 3 calls · 4.2s
Result:  ✓ todo, write, bash · 4 lines · 1 image · 0.1s · $0.02
Error:   ✗ write — TypeError: tools.foo is not a function · 0.4s
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
- **Width-Aware**: Fits the actual rendering area, including shell padding, terminal resizing, and HTML exports.
- **Key Metrics at a Glance**: Tools used, output line and image counts, execution time, and LLM cost (`$cost`).
- **Live Timing**: Updates elapsed time in the running summary every second. Final results prefer Pi’s recorded duration, falling back to the script header for older sessions and Pi versions.
- **Fully Expandable**: Press **Ctrl+O** anytime to inspect the full script source and raw output.

---

## Requirements

- **Pi Coding Agent**: `>= 1.0.1` (`1.2.0` or later recommended).

---

## Installation

```bash
pi install npm:pi-codemode-compact
```

---

## How It Works

**pi-codemode-compact** registers a tool renderer resolver with `pi.registerToolRenderer()`. Pi asks the resolver how to draw each tool call, and the extension supplies compact `renderCall`/`renderResult` renderers only for `codemode`; every other tool falls through to Pi's own renderers via `next()`.

The built-in `codemode` definition — execution, sandbox, models API, store persistence — is never re-registered or replaced, so there is no startup replacement warning and no mid-session tool redefinition. Because the renderer attaches by tool name, it also applies when another extension or SDK factory registers `codemode` with different options, and in HTML exports.

Pi remains responsible for inline image rendering and the `showImages` setting; the compact summary only adds an image count. Text-item boundaries, console blocks, and saved image paths remain visible when expanded. Output line counts include non-empty boundary and metadata lines, not just script-authored text.

Live timers stop on completion, errors, aborted runs, session changes, and reload. HTML exports do not start timers. CI uses the development SDK (currently Pi 1.4.0), with actual Pi extension-loader, TUI, host image, and HTML renderer checks in addition to the fast summary unit tests.

---

## Known Limitations

- **Early Progress on Older Pi**: Live timing refreshes after the first partial result. Pi 1.2.0 emits one before the first nested call; older supported versions may wait until a nested tool call begins.

- **Static Analysis Approximation**: The call line preview uses regex-based static scanning. Dynamic property accesses (`tools[fn]`), template-literal interpolations (`${tools.x}`), and regex literals containing tool accesses (`/tools.read/g`) may be omitted or yield false positives. The result line always displays the authoritative runtime execution history once finished.

---

## License

MIT
