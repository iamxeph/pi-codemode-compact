// Test bootstrap loader: node --import ./tests/hooks.mjs ./tests/codemode-compact.test.ts
// Redirects bare @earendil-works/* package imports to in-tree test stubs.
import { register } from "node:module";
register("./pi-tui-stub.mjs", import.meta.url);
