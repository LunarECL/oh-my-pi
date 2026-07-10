import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAdapterConfigs,
	resolveAdapter,
	selectLaunchAdapter,
	selectLaunchAdapterResult,
} from "../../src/dap/config";
import { injectPluginDirRoots } from "../../src/discovery/helpers";

const tempDirs: string[] = [];
const ORIGINAL_OMP_PLUGIN_DIR = process.env.OMP_PLUGIN_DIR;
const ORIGINAL_OMP_MARKETPLACE_DIR = process.env.OMP_MARKETPLACE_DIR;

async function makeTempDir(prefix: string): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(cwd);
	return cwd;
}

afterEach(async () => {
	vi.restoreAllMocks();
	if (ORIGINAL_OMP_PLUGIN_DIR === undefined) {
		delete process.env.OMP_PLUGIN_DIR;
	} else {
		process.env.OMP_PLUGIN_DIR = ORIGINAL_OMP_PLUGIN_DIR;
	}
	if (ORIGINAL_OMP_MARKETPLACE_DIR === undefined) {
		delete process.env.OMP_MARKETPLACE_DIR;
	} else {
		process.env.OMP_MARKETPLACE_DIR = ORIGINAL_OMP_MARKETPLACE_DIR;
	}
	await injectPluginDirRoots(os.homedir(), []);
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("DAP adapter configuration", () => {
	it("loads a custom adapter from dap.json and selects it by file extension", async () => {
		const cwd = await makeTempDir("omp-dap-config-json-");
		await fs.writeFile(path.join(cwd, "pom.xml"), "<project />\n");
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.writeFile(path.join(cwd, "src", "Main.java"), "class Main {}\n");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					"custom-jvm": {
						command: "bun",
						args: ["run", "debug-adapter"],
						languages: ["java", "kotlin"],
						fileTypes: [".java", ".kt"],
						rootMarkers: ["pom.xml", "build.gradle.kts"],
						launchDefaults: { request: "launch", mainClass: "" },
						attachDefaults: { request: "attach", host: "127.0.0.1" },
					},
				},
			}),
		);

		const adapter = resolveAdapter("custom-jvm", cwd);
		expect(adapter?.name).toBe("custom-jvm");
		expect(adapter?.command).toBe("bun");
		expect(adapter?.args).toEqual(["run", "debug-adapter"]);
		expect(adapter?.languages).toEqual(["java", "kotlin"]);
		expect(adapter?.fileTypes).toEqual([".java", ".kt"]);
		expect(adapter?.launchDefaults).toEqual({ request: "launch", mainClass: "" });
		expect(adapter?.attachDefaults).toEqual({ request: "attach", host: "127.0.0.1" });

		const selected = selectLaunchAdapter(path.join("src", "Main.java"), cwd);
		expect(selected?.name).toBe("custom-jvm");
	});

	it("merges partial user overrides over built-in adapters", async () => {
		const cwd = await makeTempDir("omp-dap-config-override-");
		await fs.writeFile(path.join(cwd, "script.py"), "print('hi')\n");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					debugpy: {
						args: ["-m", "debugpy.adapter", "--log-dir", ".debugpy-logs"],
						launchDefaults: { justMyCode: false },
					},
				},
			}),
		);

		const config = getAdapterConfigs(cwd).debugpy;
		expect(config.command).toBe("python");
		expect(config.args).toEqual(["-m", "debugpy.adapter", "--log-dir", ".debugpy-logs"]);
		expect(config.fileTypes).toContain(".py");
		expect(config.launchDefaults).toMatchObject({ request: "launch", justMyCode: false });
	});

	it("loads adapter config from project config directories and YAML", async () => {
		const cwd = await makeTempDir("omp-dap-config-yaml-");
		await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
		await fs.writeFile(path.join(cwd, "build.gradle.kts"), "plugins {}\n");
		await fs.writeFile(path.join(cwd, "Main.kt"), "fun main() {}\n");
		await fs.writeFile(
			path.join(cwd, ".omp", "dap.yaml"),
			[
				"adapters:",
				"  yaml-kotlin:",
				"    command: bun",
				"    args:",
				"      - run",
				"      - kotlin-debug-adapter",
				"    languages:",
				"      - kotlin",
				"    fileTypes:",
				"      - .kt",
				"    rootMarkers:",
				"      - build.gradle.kts",
				"    launchDefaults:",
				"      request: launch",
				"      projectRoot: .",
				"",
			].join("\n"),
		);

		const selected = selectLaunchAdapter("Main.kt", cwd);
		expect(selected?.name).toBe("yaml-kotlin");
		expect(selected?.launchDefaults).toEqual({ request: "launch", projectRoot: "." });
	});

	it("resolves relative adapter commands from the debug cwd", async () => {
		const cwd = await makeTempDir("omp-dap-config-relative-command-");
		const command = path.join(cwd, "tools", process.platform === "win32" ? "debug-adapter.cmd" : "debug-adapter");
		await fs.mkdir(path.dirname(command), { recursive: true });
		await fs.writeFile(command, "");
		await fs.chmod(command, 0o755);
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					relative: {
						command: process.platform === "win32" ? ".\\tools\\debug-adapter.cmd" : "./tools/debug-adapter",
						fileTypes: [".rel"],
					},
				},
			}),
		);

		const adapter = resolveAdapter("relative", cwd);
		expect(adapter?.command).toBe(
			process.platform === "win32" ? ".\\tools\\debug-adapter.cmd" : "./tools/debug-adapter",
		);
		expect(adapter?.resolvedCommand).toBe(command);
	});

	it("loads plugin DAP adapters from plugin config files", async () => {
		const cwd = await makeTempDir("omp-dap-config-plugin-");
		const pluginRoot = path.join(cwd, "plugins", "acme-debug");
		await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
		await fs.writeFile(path.join(cwd, "app.rb"), "puts 'hi'\n");
		await fs.writeFile(
			path.join(pluginRoot, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "acme-debug" }),
		);
		await fs.writeFile(
			path.join(pluginRoot, ".dap.json"),
			JSON.stringify({
				adapters: {
					"acme-ruby": {
						command: "ruby-debug-adapter",
						fileTypes: [".rb"],
					},
				},
			}),
		);
		process.env.OMP_PLUGIN_DIR = path.join(cwd, "plugins");
		process.env.OMP_MARKETPLACE_DIR = path.join(cwd, "marketplaces");
		await injectPluginDirRoots(cwd, [pluginRoot], cwd);

		expect(getAdapterConfigs(cwd)["acme-ruby"]?.command).toBe("ruby-debug-adapter");
	});

	it("ignores invalid custom adapters without discarding valid configs", async () => {
		const cwd = await makeTempDir("omp-dap-config-invalid-");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					"missing-command": {
						fileTypes: [".bad"],
					},
					valid: {
						command: "bun",
						fileTypes: [".ok"],
						rootMarkers: ["."],
					},
				},
			}),
		);

		const config = getAdapterConfigs(cwd);
		expect(config["missing-command"]).toBeUndefined();
		expect(config.valid?.command).toBe("bun");
	});
});

describe("launch adapter selection with missing or nested adapters", () => {
	/** dap.json override pinning dlv to an absolute command path keeps these
	 *  tests deterministic: resolution succeeds/fails based on that exact file,
	 *  independent of a host-installed dlv, PATH, or $which cache state. */
	async function writeDlvOverride(cwd: string, command: string): Promise<void> {
		await fs.writeFile(path.join(cwd, "dap.json"), JSON.stringify({ adapters: { dlv: { command } } }));
	}

	it("reports a configured-but-missing dlv for .go programs instead of falling back to another debugger", async () => {
		const cwd = await makeTempDir("omp-dap-go-missing-");
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/hello\n\ngo 1.22\n");
		await fs.writeFile(path.join(cwd, "main.go"), "package main\nfunc main() {}\n");
		const missingCommand = path.join(cwd, "tools", "dlv");
		await writeDlvOverride(cwd, missingCommand);

		const selected = selectLaunchAdapterResult("main.go", cwd, undefined, "file");
		expect(selected).toEqual({ kind: "unavailable", adapterName: "dlv", command: missingCommand });
		// The compatibility selector reports the same situation as "no adapter"
		// instead of silently picking an unrelated debugger.
		expect(selectLaunchAdapter("main.go", cwd, undefined, "file")).toBeNull();
	});

	it("reports a configured-but-missing dlv for Go package directories instead of a directory rejection", async () => {
		const cwd = await makeTempDir("omp-dap-go-missing-dir-");
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/hello\n\ngo 1.22\n");
		await fs.mkdir(path.join(cwd, "cmd", "hello"), { recursive: true });
		const missingCommand = path.join(cwd, "tools", "dlv");
		await writeDlvOverride(cwd, missingCommand);

		const selected = selectLaunchAdapterResult(path.join("cmd", "hello"), cwd, undefined, "directory");
		expect(selected).toEqual({ kind: "unavailable", adapterName: "dlv", command: missingCommand });
	});

	it("selects dlv for a package directory in a nested module below the session cwd", async () => {
		const cwd = await makeTempDir("omp-dap-go-nested-");
		await fs.mkdir(path.join(cwd, "services", "foo", "cmd", "server"), { recursive: true });
		await fs.writeFile(path.join(cwd, "services", "foo", "go.mod"), "module example.com/foo\n\ngo 1.22\n");
		await writeDlvOverride(cwd, process.execPath);

		const selected = selectLaunchAdapterResult(
			path.join("services", "foo", "cmd", "server"),
			cwd,
			undefined,
			"directory",
		);
		expect(selected).toMatchObject({ kind: "adapter", adapter: { name: "dlv" } });
	});

	it("matches root markers inside the launched directory itself", async () => {
		const cwd = await makeTempDir("omp-dap-go-selfroot-");
		await fs.mkdir(path.join(cwd, "mod"), { recursive: true });
		await fs.writeFile(path.join(cwd, "mod", "go.mod"), "module example.com/mod\n\ngo 1.22\n");
		await writeDlvOverride(cwd, process.execPath);

		const selected = selectLaunchAdapterResult("mod", cwd, undefined, "directory");
		expect(selected).toMatchObject({ kind: "adapter", adapter: { name: "dlv" } });
	});

	it("resolves an adapter installed after a failed attempt within the same session", async () => {
		const cwd = await makeTempDir("omp-dap-go-recovery-");
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/hello\n\ngo 1.22\n");
		await fs.writeFile(path.join(cwd, "main.go"), "package main\nfunc main() {}\n");
		const command = path.join(cwd, "tools", process.platform === "win32" ? "dlv.cmd" : "dlv");
		await writeDlvOverride(cwd, command);

		expect(selectLaunchAdapterResult("main.go", cwd, undefined, "file")).toEqual({
			kind: "unavailable",
			adapterName: "dlv",
			command,
		});

		// "Install" the adapter at the exact configured path and retry without
		// restarting: the lookup must not serve the earlier negative result.
		await fs.mkdir(path.dirname(command), { recursive: true });
		await fs.writeFile(command, "");
		await fs.chmod(command, 0o755);

		expect(selectLaunchAdapterResult("main.go", cwd, undefined, "file")).toMatchObject({
			kind: "adapter",
			adapter: { name: "dlv" },
		});
	});

	it("reports an explicitly requested configured adapter as unavailable when its binary is missing", async () => {
		const cwd = await makeTempDir("omp-dap-go-explicit-");
		const missingCommand = path.join(cwd, "tools", "dlv");
		await writeDlvOverride(cwd, missingCommand);

		expect(selectLaunchAdapterResult("main.go", cwd, "dlv", "file")).toEqual({
			kind: "unavailable",
			adapterName: "dlv",
			command: missingCommand,
		});
		expect(selectLaunchAdapterResult("main.go", cwd, "no-such-adapter", "file")).toEqual({ kind: "none" });
	});
});
