// Test stub for @earendil-works/pi-coding-agent.
// Provides runtime symbols required when loading and testing pi-codemode-compact.

export function createCodemodeExtension() {
	return (pi) => {
		pi.registerTool({
			name: "codemode",
			label: "codemode",
			description: "Compact single-line summary renderer for Pi codemode",
			defaultActive: false,
			parameters: { type: "object", properties: { code: { type: "string" } } },
			execute: async () => ({ content: [] }),
			prepareLoadout: () => ({ descriptions: { codemode: pi.getSettings().codemode?.mode + "/" + pi.getAllTools().length } }),
			persistStore: (customType, data) => pi.appendEntry(customType, data),
		});
	};
}

export function highlightCode(code) {
	return String(code).split("\n");
}
