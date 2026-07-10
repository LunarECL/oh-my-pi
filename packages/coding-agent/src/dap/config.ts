import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { getConfigDirPaths } from "../config";
import { getPreloadedPluginRoots } from "../discovery/helpers";
import { hasRootMarkers, hasRootMarkersInAncestry, resolveCommand } from "../lsp/config";
import DEFAULTS from "./defaults.json" with { type: "json" };
import type { DapAdapterConfig, DapResolvedAdapter } from "./types";

const EXTENSIONLESS_DEBUGGER_ORDER = ["gdb", "lldb-dap"] as const;

interface NormalizedConfig {
	adapters: Record<string, unknown>;
}

interface ConfigSource {
	read(): NormalizedConfig | null;
}

function parseConfigContent(content: string, filePath: string): unknown {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml") {
		return YAML.parse(content) as unknown;
	}
	return JSON.parse(content) as unknown;
}

function normalizeConfig(value: unknown): NormalizedConfig | null {
	if (!isRecord(value)) return null;
	if (isRecord(value.adapters)) return { adapters: value.adapters };
	return { adapters: value };
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function normalizeObject(value: unknown): Record<string, unknown> {
	return isRecord(value) ? { ...value } : {};
}

function normalizeAdapterConfig(config: unknown): DapAdapterConfig | null {
	if (!isRecord(config)) return null;
	if (typeof config.command !== "string" || config.command.length === 0) return null;
	const connectMode = config.connectMode === "socket" ? ("socket" as const) : undefined;
	return {
		command: config.command,
		args: normalizeStringArray(config.args),
		languages: normalizeStringArray(config.languages),
		fileTypes: normalizeStringArray(config.fileTypes).map(entry => entry.toLowerCase()),
		rootMarkers: normalizeStringArray(config.rootMarkers),
		launchDefaults: normalizeObject(config.launchDefaults),
		attachDefaults: normalizeObject(config.attachDefaults),
		acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
		...(connectMode ? { connectMode } : {}),
	};
}

function readConfigFile(filePath: string): NormalizedConfig | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return normalizeConfig(parseConfigContent(content, filePath));
	} catch {
		return null;
	}
}

function getDefaults(): Record<string, DapAdapterConfig> {
	const adapters: Record<string, DapAdapterConfig> = {};
	for (const [name, config] of Object.entries(DEFAULTS)) {
		const normalized = normalizeAdapterConfig(config);
		if (normalized) {
			adapters[name] = normalized;
		}
	}
	return adapters;
}

const DEFAULT_ADAPTERS = getDefaults();

function mergeAdapters(
	base: Record<string, DapAdapterConfig>,
	overrides: Record<string, unknown>,
): Record<string, DapAdapterConfig> {
	const merged: Record<string, DapAdapterConfig> = { ...base };
	for (const [name, config] of Object.entries(overrides)) {
		const existing = merged[name];
		const candidate =
			isRecord(existing) && isRecord(config)
				? {
						...existing,
						...config,
						launchDefaults:
							isRecord(existing.launchDefaults) || isRecord(config.launchDefaults)
								? { ...existing.launchDefaults, ...normalizeObject(config.launchDefaults) }
								: undefined,
						attachDefaults:
							isRecord(existing.attachDefaults) || isRecord(config.attachDefaults)
								? { ...existing.attachDefaults, ...normalizeObject(config.attachDefaults) }
								: undefined,
					}
				: config;
		const normalized = normalizeAdapterConfig(candidate);
		if (normalized) {
			merged[name] = normalized;
		} else if (merged[name]) {
			logger.warn("Ignoring invalid DAP adapter override (keeping previous config).", { name });
		} else {
			logger.warn("Ignoring invalid DAP adapter config.", { name });
		}
	}
	return merged;
}

function fileConfigSource(filePath: string): ConfigSource {
	return {
		read: () => readConfigFile(filePath),
	};
}

function getConfigSources(cwd: string): ConfigSource[] {
	const filenames = ["dap.json", ".dap.json", "dap.yaml", ".dap.yaml", "dap.yml", ".dap.yml"];
	const sources: ConfigSource[] = [];

	for (const filename of filenames) {
		sources.push(fileConfigSource(path.join(cwd, filename)));
	}

	const projectDirs = getConfigDirPaths("", { user: false, project: true, cwd });
	for (const dir of projectDirs) {
		for (const filename of filenames) {
			sources.push(fileConfigSource(path.join(dir, filename)));
		}
	}

	const userDirs = getConfigDirPaths("", { user: true, project: false });
	for (const dir of userDirs) {
		for (const filename of filenames) {
			sources.push(fileConfigSource(path.join(dir, filename)));
		}
	}

	const pluginRoots = getPreloadedPluginRoots();
	for (const root of pluginRoots) {
		for (const filename of filenames) {
			sources.push(fileConfigSource(path.join(root.path, filename)));
		}
	}

	for (const filename of filenames) {
		sources.push(fileConfigSource(path.join(os.homedir(), filename)));
	}

	return sources;
}

function loadAdapterConfigs(cwd: string): Record<string, DapAdapterConfig> {
	let adapters = { ...DEFAULT_ADAPTERS };
	for (const source of getConfigSources(cwd).reverse()) {
		const parsed = source.read();
		if (!parsed) continue;
		adapters = mergeAdapters(adapters, parsed.adapters);
	}
	return adapters;
}

export function getAdapterConfigs(cwd?: string): Record<string, DapAdapterConfig> {
	return cwd ? loadAdapterConfigs(cwd) : { ...DEFAULT_ADAPTERS };
}

function normalizeCommandForCwd(command: string, cwd: string): string {
	if (path.isAbsolute(command)) return command;
	if (
		command.startsWith("./") ||
		command.startsWith("../") ||
		command.startsWith(".\\") ||
		command.startsWith("..\\")
	) {
		return path.resolve(cwd, command);
	}
	return command;
}

function resolveAdapterFromConfig(
	adapterName: string,
	configs: Record<string, DapAdapterConfig>,
	cwd: string,
): DapResolvedAdapter | null {
	const config = configs[adapterName];
	if (!config) return null;
	// Fresh lookup: debug launches are rare and interactive, and a cached
	// negative would otherwise require a restart after installing an adapter.
	const resolvedCommand = resolveCommand(normalizeCommandForCwd(config.command, cwd), cwd, { fresh: true });
	if (!resolvedCommand) return null;
	return {
		name: adapterName,
		command: config.command,
		args: config.args ?? [],
		resolvedCommand,
		languages: config.languages ?? [],
		fileTypes: config.fileTypes ?? [],
		rootMarkers: config.rootMarkers ?? [],
		launchDefaults: config.launchDefaults ?? {},
		attachDefaults: config.attachDefaults ?? {},
		connectMode: config.connectMode ?? "stdio",
		acceptsDirectoryProgram: config.acceptsDirectoryProgram === true,
	};
}

export function resolveAdapter(adapterName: string, cwd: string): DapResolvedAdapter | null {
	return resolveAdapterFromConfig(adapterName, getAdapterConfigs(cwd), cwd);
}

export function getAvailableAdapters(cwd: string): DapResolvedAdapter[] {
	const configs = getAdapterConfigs(cwd);
	return Object.keys(configs)
		.map(name => resolveAdapterFromConfig(name, configs, cwd))
		.filter((adapter): adapter is DapResolvedAdapter => adapter !== null);
}

/** Install commands for well-known adapters, surfaced when a matching adapter
 *  is configured but its binary is missing. debugpy is intentionally absent:
 *  its command is `python`, so a resolution failure means Python itself is
 *  missing (the pip-module hint lives in the runtime failure mapper). */
export const ADAPTER_INSTALL_HINTS: Record<string, string> = {
	dlv: "go install github.com/go-delve/delve/cmd/dlv@latest",
	rdbg: "gem install debug",
};

/** Launch adapter selection outcome. `unavailable` names a configured adapter
 *  that matches the program (by file type, or directory-capability + root
 *  markers) whose binary did not resolve — callers surface a targeted install
 *  error instead of silently falling back to an unrelated debugger. */
export type LaunchAdapterSelection =
	| { kind: "adapter"; adapter: DapResolvedAdapter }
	| { kind: "unavailable"; adapterName: string; command: string }
	| { kind: "none" };

/** Root markers match when found in the program's ancestor chain (nested
 *  modules in monorepos) or at the session cwd (historical behavior). */
function adapterRootMatches(rootMarkers: string[] | undefined, cwd: string, anchorDir: string): boolean {
	if (!rootMarkers || rootMarkers.length === 0) return false;
	return hasRootMarkersInAncestry(anchorDir, rootMarkers) || hasRootMarkers(cwd, rootMarkers);
}

function selectAutoLaunchAdapter(program: string, cwd: string, programKind: LaunchProgramKind): LaunchAdapterSelection {
	const configs = getAdapterConfigs(cwd);
	const available = Object.keys(configs)
		.map(name => resolveAdapterFromConfig(name, configs, cwd))
		.filter((adapter): adapter is DapResolvedAdapter => adapter !== null);
	// Root-marker searches anchor at the program itself when it is a directory
	// (its own go.mod counts), else at its parent; relative programs resolve
	// against the launch cwd.
	const absoluteProgram = path.resolve(cwd, program);
	const anchorDir = programKind === "directory" ? absoluteProgram : path.dirname(absoluteProgram);
	const extension = path.extname(program).toLowerCase();

	if (extension) {
		const resolvedExact = available.filter(adapter => adapter.fileTypes.includes(extension));
		if (resolvedExact.length > 0) {
			const adapter = sortAdaptersForLaunch(program, cwd, anchorDir, resolvedExact)[0];
			return adapter ? { kind: "adapter", adapter } : { kind: "none" };
		}
		// A configured adapter covers this extension but its binary is missing:
		// report it instead of falling back to an unrelated debugger (e.g.
		// lldb-dap silently "debugging" main.go when dlv is not installed).
		const configuredExact = Object.entries(configs).filter(([, config]) =>
			(config.fileTypes ?? []).includes(extension),
		);
		if (configuredExact.length > 0) {
			const rootMatched = configuredExact.filter(([, config]) =>
				adapterRootMatches(config.rootMarkers, cwd, anchorDir),
			);
			const [adapterName, config] = (rootMatched.length > 0 ? rootMatched : configuredExact)[0];
			return { kind: "unavailable", adapterName, command: config.command };
		}
		// Unknown extension: preserve historical behavior and consider everything.
		const adapter = sortAdaptersForLaunch(program, cwd, anchorDir, available)[0];
		return adapter ? { kind: "adapter", adapter } : { kind: "none" };
	}

	// For extensionless binaries and directories, only consider native debuggers
	// (gdb, lldb-dap) or adapters whose root markers match the program/session.
	// Don't silently fall back to unrelated adapters like debugpy for a C binary.
	const matches = available.filter(
		adapter =>
			(EXTENSIONLESS_DEBUGGER_ORDER as readonly string[]).includes(adapter.name) ||
			adapterRootMatches(adapter.rootMarkers, cwd, anchorDir),
	);
	if (programKind === "directory") {
		const directoryCapable = matches.filter(adapter => adapter.acceptsDirectoryProgram);
		if (directoryCapable.length > 0) {
			const adapter = sortAdaptersForLaunch(program, cwd, anchorDir, directoryCapable)[0];
			return adapter ? { kind: "adapter", adapter } : { kind: "none" };
		}
		const configuredCapable = Object.entries(configs).filter(
			([name, config]) =>
				config.acceptsDirectoryProgram === true &&
				adapterRootMatches(config.rootMarkers, cwd, anchorDir) &&
				!available.some(adapter => adapter.name === name),
		);
		if (configuredCapable.length > 0) {
			const [adapterName, config] = configuredCapable[0];
			return { kind: "unavailable", adapterName, command: config.command };
		}
		// No directory-capable adapter anywhere: fall through so the launch
		// validation surfaces the directory rejection with the sorted pick.
	}
	const adapter = sortAdaptersForLaunch(program, cwd, anchorDir, matches)[0];
	return adapter ? { kind: "adapter", adapter } : { kind: "none" };
}

function sortAdaptersForLaunch(
	program: string,
	cwd: string,
	anchorDir: string,
	adapters: DapResolvedAdapter[],
): DapResolvedAdapter[] {
	const extension = path.extname(program).toLowerCase();
	const rootAware = adapters.map(adapter => ({
		adapter,
		hasExtensionMatch: extension.length > 0 && adapter.fileTypes.includes(extension),
		hasRootMatch: adapterRootMatches(adapter.rootMarkers, cwd, anchorDir),
	}));
	rootAware.sort((left, right) => {
		if (left.hasExtensionMatch !== right.hasExtensionMatch) {
			return left.hasExtensionMatch ? -1 : 1;
		}
		if (left.hasRootMatch !== right.hasRootMatch) {
			return left.hasRootMatch ? -1 : 1;
		}
		const leftDebuggerRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(
			left.adapter.name as (typeof EXTENSIONLESS_DEBUGGER_ORDER)[number],
		);
		const rightDebuggerRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(
			right.adapter.name as (typeof EXTENSIONLESS_DEBUGGER_ORDER)[number],
		);
		const normalizedLeftRank = leftDebuggerRank === -1 ? Number.MAX_SAFE_INTEGER : leftDebuggerRank;
		const normalizedRightRank = rightDebuggerRank === -1 ? Number.MAX_SAFE_INTEGER : rightDebuggerRank;
		if (normalizedLeftRank !== normalizedRightRank) {
			return normalizedLeftRank - normalizedRightRank;
		}
		return left.adapter.name.localeCompare(right.adapter.name);
	});
	return rootAware.map(entry => entry.adapter);
}

/** Detailed launch adapter selection. Prefer this over
 *  {@link selectLaunchAdapter} when the caller can surface the
 *  `unavailable` state (configured adapter with a missing binary). */
export function selectLaunchAdapterResult(
	program: string,
	cwd: string,
	adapterName?: string,
	programKind: LaunchProgramKind = "file",
): LaunchAdapterSelection {
	if (adapterName) {
		const adapter = resolveAdapter(adapterName, cwd);
		if (adapter) return { kind: "adapter", adapter };
		const config = getAdapterConfigs(cwd)[adapterName];
		return config ? { kind: "unavailable", adapterName, command: config.command } : { kind: "none" };
	}
	return selectAutoLaunchAdapter(program, cwd, programKind);
}

/** Compatibility selector returning the resolved adapter or null. Unlike the
 *  historical behavior, a program whose configured adapter is merely not
 *  installed yields null instead of silently falling back to an unrelated
 *  debugger — use {@link selectLaunchAdapterResult} to distinguish that case. */
export function selectLaunchAdapter(
	program: string,
	cwd: string,
	adapterName?: string,
	programKind: LaunchProgramKind = "file",
): DapResolvedAdapter | null {
	const selection = selectLaunchAdapterResult(program, cwd, adapterName, programKind);
	return selection.kind === "adapter" ? selection.adapter : null;
}

export function selectAttachAdapter(cwd: string, adapterName?: string, port?: number): DapResolvedAdapter | null {
	if (adapterName) {
		return resolveAdapter(adapterName, cwd);
	}
	const available = getAvailableAdapters(cwd);
	if (port !== undefined) {
		const debugpy = available.find(adapter => adapter.name === "debugpy");
		if (debugpy) return debugpy;
	}
	for (const preferred of EXTENSIONLESS_DEBUGGER_ORDER) {
		const match = available.find(adapter => adapter.name === preferred);
		if (match) return match;
	}
	return available[0] ?? null;
}

/** How the launch `program` resolves on disk. `"missing"` is reserved for
 *  programs the adapter creates on demand (rare); we treat them like files. */
export type LaunchProgramKind = "file" | "directory" | "missing";

/** Compute adapter-specific launch arguments that depend on the resolved
 *  program. Returned values are spread over `adapter.launchDefaults` so they
 *  take precedence over the static defaults but can still be overridden by
 *  the fields `DapSessionManager.launch` sets explicitly (program, cwd, args).
 *
 *  Currently scoped to dlv, where `mode` selects how the program path is
 *  interpreted: directories and `.go` source files debug as a Go package
 *  (`mode=debug`), anything else is treated as a compiled binary (`mode=exec`).
 */
export function resolveLaunchOverrides(
	adapter: DapResolvedAdapter,
	program: string,
	programKind: LaunchProgramKind,
): Record<string, unknown> {
	if (adapter.name === "dlv") {
		const extension = path.extname(program).toLowerCase();
		if (programKind === "directory" || extension === ".go") {
			return { mode: "debug" };
		}
		if (programKind === "file") {
			return { mode: "exec" };
		}
	}
	return {};
}
