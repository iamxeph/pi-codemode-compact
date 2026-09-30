// Test stub for @earendil-works/pi-tui.
// Replaces bare @earendil-works/pi-tui imports during test execution.

const KEY_BYTES = { enter: ["\r", "\n"], escape: ["\x1b"] };

export class Text {
  constructor(text = "", x = 0, y = 0) {
    this.text = text;
    this.x = x;
    this.y = y;
  }
  setText(text) {
    this.text = text;
  }
  render() {
    return String(this.text).split("\n");
  }
  invalidate() {}
}

export function matchesKey(data, key) {
  return (KEY_BYTES[key] ?? [key]).includes(data);
}

/** Strips ANSI escape sequences, OSC/APC/DCS sequences, and terminal styling. */
export function stripTerminalSequences(text) {
  if (typeof text !== "string") return "";
  return text
    // OSC: ESC ] ... (BEL or ESC )
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, "")
    // APC / DCS / PM: ESC _ | P | ^ ... (ST)
    .replace(/\u001b[P_^][^\u001b]*(?:\u001b\\)?/g, "")
    // CSI: ESC [ ...
    .replace(/(\u001b\[|\u009b)[0-9;?]*[A-Za-z]/g, "");
}

/** Computes visible column width of text, accounting for wide CJK and full-width characters. */
export function visibleWidth(text) {
  if (typeof text !== "string") return 0;
  const stripped = stripTerminalSequences(text);
  let cols = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK and full-width ranges
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd)
    ) {
      cols += 2;
    } else {
      cols += 1;
    }
  }
  return cols;
}

/** Slices a string by terminal column position. */
export function sliceByColumn(text, startCol, maxCols) {
  if (typeof text !== "string") return "";
  let currentCol = 0;
  let result = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const chWidth = (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xff60)
    ) ? 2 : 1;

    if (currentCol >= startCol && currentCol + chWidth <= startCol + maxCols) {
      result += ch;
    }
    currentCol += chWidth;
    if (currentCol >= startCol + maxCols) break;
  }
  return result;
}

export function truncateToWidth(s, w, ellipsis = "") {
  if (typeof s !== "string") return "";
  if (visibleWidth(s) <= w) return s;
  return sliceByColumn(s, 0, Math.max(0, w - visibleWidth(ellipsis))) + ellipsis;
}

export async function resolve(specifier, context, next) {
  if (specifier === "@earendil-works/pi-tui" || specifier.startsWith("@earendil-works/pi-tui/")) {
    return { url: new URL(import.meta.url).href, shortCircuit: true };
  }
  if (specifier === "@earendil-works/pi-coding-agent" || specifier.startsWith("@earendil-works/pi-coding-agent/")) {
    return { url: new URL("./pi-coding-agent-stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
