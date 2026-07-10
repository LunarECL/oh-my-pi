import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

async function writeModule(root: string, name: string, body: string): Promise<void> {
	await fs.mkdir(path.join(root, name), { recursive: true });
	await fs.writeFile(path.join(root, name, "go.mod"), `module example.com/${name}\n\ngo 1.21\n`);
	await fs.writeFile(path.join(root, name, "main.go"), body);
}

// Runs against the real go toolchain (preinstalled on the CI runner image).
// Real `go work edit -json` output plus the generated per-module build
// patterns are the contract here; a fake go would just re-assert our own
// assumptions about its output.
describe.skipIf(Bun.which("go") === null)("workspace diagnostics for Go workspaces", () => {
	it("detects a go.work-only root and surfaces failures from every use module", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lsp-gowork-"));
		tempDirs.push(cwd);
		// go.work without a root go.mod: plain `go build ./...` fails here with
		// "directory prefix . does not contain modules listed in go.work", so
		// diagnostics have to enumerate the use modules instead.
		await fs.writeFile(path.join(cwd, "go.work"), "go 1.21\n\nuse (\n\t./alpha\n\t./beta\n)\n");
		await writeModule(cwd, "alpha", "package main\n\nfunc main() {}\n");
		await writeModule(cwd, "beta", "package main\n\nfunc main() { undefinedFunc() }\n");

		const tool = new LspTool({ cwd } as ToolSession);
		const result = await tool.execute("gowork-diagnostics", { action: "diagnostics", file: "*" });
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => ("text" in block ? block.text : ""))
			.join("\n");

		expect(text).toContain("Workspace diagnostics (Go workspace (go build))");
		// The compile error sits in the second use module; seeing it proves the
		// workspace was enumerated and built per module, not just the root.
		expect(text).toContain("undefined: undefinedFunc");
	});

	it("prefers the workspace over a coexisting root go.mod so non-root module failures surface", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lsp-gowork-mixed-"));
		tempDirs.push(cwd);
		// Root module and go.work together: with the old go.mod-first ordering
		// the command was plain `go build ./...`, which exits 0 here and never
		// compiles ./beta, so the broken use module went unreported.
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/root\n\ngo 1.21\n");
		await fs.writeFile(path.join(cwd, "main.go"), "package main\n\nfunc main() {}\n");
		await fs.writeFile(path.join(cwd, "go.work"), "go 1.21\n\nuse (\n\t.\n\t./beta\n)\n");
		await writeModule(cwd, "beta", "package main\n\nfunc main() { undefinedFunc() }\n");

		const tool = new LspTool({ cwd } as ToolSession);
		const result = await tool.execute("gowork-mixed-diagnostics", { action: "diagnostics", file: "*" });
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => ("text" in block ? block.text : ""))
			.join("\n");

		expect(text).toContain("Workspace diagnostics (Go workspace (go build))");
		expect(text).toContain("undefined: undefinedFunc");
	});
});
