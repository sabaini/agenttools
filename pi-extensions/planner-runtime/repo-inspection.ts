import fs from "node:fs/promises";
import path from "node:path";

import type { MilestoneValidationProfile, ValidationCommandSpec } from "./models.ts";

export interface RepoValidationInspection {
	packageManager?: "npm" | "pnpm" | "yarn" | "bun";
	scripts: string[];
	justTargets: string[];
	configSignals: string[];
	validationProfile: MilestoneValidationProfile;
}

interface ParsedPackageJson {
	packageManager?: string;
	scripts: Record<string, string>;
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
}

function parsePackageJson(raw: string | undefined): ParsedPackageJson | undefined {
	if (!raw) {
		return undefined;
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return undefined;
	}

	const scriptsRecord = typeof parsed.scripts === "object" && parsed.scripts && !Array.isArray(parsed.scripts)
		? (parsed.scripts as Record<string, unknown>)
		: {};
	const dependenciesRecord =
		typeof parsed.dependencies === "object" && parsed.dependencies && !Array.isArray(parsed.dependencies)
			? (parsed.dependencies as Record<string, unknown>)
			: {};
	const devDependenciesRecord =
		typeof parsed.devDependencies === "object" && parsed.devDependencies && !Array.isArray(parsed.devDependencies)
			? (parsed.devDependencies as Record<string, unknown>)
			: {};

	return {
		packageManager: typeof parsed.packageManager === "string" ? parsed.packageManager : undefined,
		scripts: Object.fromEntries(
			Object.entries(scriptsRecord)
				.filter(([, value]) => typeof value === "string" && value.trim())
				.map(([key, value]) => [key, (value as string).trim()]),
		),
		dependencies: Object.fromEntries(
			Object.entries(dependenciesRecord)
				.filter(([, value]) => typeof value === "string" && value.trim())
				.map(([key, value]) => [key, value as string]),
		),
		devDependencies: Object.fromEntries(
			Object.entries(devDependenciesRecord)
				.filter(([, value]) => typeof value === "string" && value.trim())
				.map(([key, value]) => [key, value as string]),
		),
	};
}

function detectPackageManager(
	packageJson: ParsedPackageJson | undefined,
	rootEntries: string[],
): RepoValidationInspection["packageManager"] {
	const packageManagerField = packageJson?.packageManager?.trim().toLowerCase();
	if (packageManagerField?.startsWith("pnpm@")) return "pnpm";
	if (packageManagerField?.startsWith("yarn@")) return "yarn";
	if (packageManagerField?.startsWith("bun@")) return "bun";
	if (packageManagerField?.startsWith("npm@")) return "npm";

	if (rootEntries.includes("pnpm-lock.yaml")) return "pnpm";
	if (rootEntries.includes("yarn.lock")) return "yarn";
	if (rootEntries.includes("bun.lockb") || rootEntries.includes("bun.lock")) return "bun";
	if (rootEntries.includes("package-lock.json")) return "npm";
	if (packageJson) return "npm";
	return undefined;
}

function scriptCommand(packageManager: RepoValidationInspection["packageManager"], scriptName: string): string {
	switch (packageManager) {
		case "pnpm":
			return scriptName === "test" ? "pnpm test" : `pnpm run ${scriptName}`;
		case "yarn":
			return `yarn ${scriptName}`;
		case "bun":
			return scriptName === "test" ? "bun test" : `bun run ${scriptName}`;
		case "npm":
		default:
			return scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
	}
}

function execCommand(
	packageManager: RepoValidationInspection["packageManager"],
	binary: string,
	args: string,
): string {
	const suffix = args.trim() ? ` ${args.trim()}` : "";
	switch (packageManager) {
		case "pnpm":
			return `pnpm exec ${binary}${suffix}`;
		case "yarn":
			return `yarn ${binary}${suffix}`;
		case "bun":
			return `bunx ${binary}${suffix}`;
		case "npm":
		default:
			return `npx ${binary}${suffix}`;
	}
}

function hasDependency(packageJson: ParsedPackageJson | undefined, dependencyName: string): boolean {
	return Boolean(packageJson?.dependencies[dependencyName] || packageJson?.devDependencies[dependencyName]);
}

function looksLikePlaceholderTestScript(command: string | undefined): boolean {
	const normalized = command?.trim().toLowerCase() ?? "";
	if (!normalized) return true;
	return normalized.includes("no test specified") || normalized === "echo \"error: no test specified\" && exit 1";
}

function parseJustTargets(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}

	const targets: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("set ") || trimmed.startsWith("import ")) {
			continue;
		}
		if (line.startsWith(" ") || line.startsWith("\t")) {
			continue;
		}

		const match = trimmed.match(/^@?([A-Za-z0-9_-]+)(?:\s+[A-Za-z0-9_-]+(?:=.*?)?)*\s*:/);
		if (!match) {
			continue;
		}
		const target = match[1];
		if (!target || targets.includes(target)) {
			continue;
		}
		targets.push(target);
	}

	return targets;
}

function addValidationCommand(
	commands: ValidationCommandSpec[],
	entry: ValidationCommandSpec,
	options?: { replaceExploratoryOfSameKind?: boolean },
): void {
	const existingIndex = commands.findIndex((current) => current.kind === entry.kind);
	if (existingIndex === -1) {
		commands.push(entry);
		return;
	}

	const existing = commands[existingIndex];
	if (existing.command === entry.command) {
		return;
	}
	if (options?.replaceExploratoryOfSameKind && existing.origin === "exploratory" && entry.origin === "canonical") {
		commands.splice(existingIndex, 1, entry);
	}
}

export async function inspectRepoValidationProfile(repoRoot: string): Promise<RepoValidationInspection> {
	const rootEntries = await fs.readdir(repoRoot);
	const packageJson = parsePackageJson(await readTextIfExists(path.join(repoRoot, "package.json")));
	const packageManager = detectPackageManager(packageJson, rootEntries);
	const justfileName = ["justfile", ".justfile", "Justfile"].find((entry) => rootEntries.includes(entry));
	const justTargets = parseJustTargets(
		justfileName ? await readTextIfExists(path.join(repoRoot, justfileName)) : undefined,
	);
	const configSignals: string[] = [];
	const commands: ValidationCommandSpec[] = [];
	const scripts = Object.keys(packageJson?.scripts ?? {}).sort((left, right) => left.localeCompare(right));

	if (packageJson) {
		configSignals.push("package.json");
	}
	if (justfileName) {
		configSignals.push(justfileName);
	}

	const tsconfigFiles = rootEntries
		.filter((entry) => /^tsconfig(?:\.[^.]+)?\.json$/i.test(entry))
		.sort((left, right) => left.localeCompare(right));
	for (const tsconfigFile of tsconfigFiles) {
		configSignals.push(tsconfigFile);
	}

	const eslintSignals = rootEntries
		.filter((entry) =>
			[
				".eslintrc",
				".eslintrc.json",
				".eslintrc.js",
				".eslintrc.cjs",
				".eslintrc.mjs",
				"eslint.config.js",
				"eslint.config.cjs",
				"eslint.config.mjs",
				"eslint.config.ts",
			].includes(entry),
		)
		.sort((left, right) => left.localeCompare(right));
	for (const eslintSignal of eslintSignals) {
		configSignals.push(eslintSignal);
	}
	if (hasDependency(packageJson, "eslint") && !eslintSignals.includes("eslint (dependency)")) {
		configSignals.push("eslint (dependency)");
	}
	if (rootEntries.includes("Cargo.toml")) {
		configSignals.push("Cargo.toml");
	}

	const scriptKinds: Array<{ script: string; kind: ValidationCommandSpec["kind"] }> = [
		{ script: "test", kind: "test" },
		{ script: "build", kind: "build" },
		{ script: "lint", kind: "lint" },
		{ script: "typecheck", kind: "typecheck" },
	];
	for (const { script, kind } of scriptKinds) {
		const command = packageJson?.scripts[script];
		if (!command) continue;
		if (script === "test" && looksLikePlaceholderTestScript(command)) continue;
		addValidationCommand(commands, {
			command: scriptCommand(packageManager, script),
			kind,
			origin: "canonical",
		});
	}

	const justKinds: Array<{ target: string; kind: ValidationCommandSpec["kind"] }> = [
		{ target: "test", kind: "test" },
		{ target: "build", kind: "build" },
		{ target: "lint", kind: "lint" },
		{ target: "typecheck", kind: "typecheck" },
	];
	for (const { target, kind } of justKinds) {
		if (!justTargets.includes(target)) continue;
		addValidationCommand(commands, {
			command: `just ${target}`,
			kind,
			origin: "canonical",
		});
	}

	if (rootEntries.includes("Cargo.toml")) {
		addValidationCommand(commands, {
			command: "cargo test",
			kind: "test",
			origin: "canonical",
		});
		addValidationCommand(commands, {
			command: "cargo build",
			kind: "build",
			origin: "canonical",
		});
	}

	if (tsconfigFiles.length > 0 || hasDependency(packageJson, "typescript")) {
		addValidationCommand(commands, {
			command: execCommand(packageManager, "tsc", "--noEmit"),
			kind: "typecheck",
			origin: "exploratory",
		}, { replaceExploratoryOfSameKind: false });
	}
	if (eslintSignals.length > 0 || hasDependency(packageJson, "eslint")) {
		addValidationCommand(commands, {
			command: execCommand(packageManager, "eslint", "."),
			kind: "lint",
			origin: "exploratory",
		}, { replaceExploratoryOfSameKind: false });
	}

	return {
		packageManager,
		scripts,
		justTargets,
		configSignals: Array.from(new Set(configSignals)),
		validationProfile: {
			commands,
		},
	};
}

export function renderValidationProfileYaml(profile: MilestoneValidationProfile): string[] {
	if (profile.commands.length === 0) {
		return ["validation:", "  commands: []"];
	}

	const lines = ["validation:", "  commands:"];
	for (const command of profile.commands) {
		lines.push(`    - command: ${JSON.stringify(command.command)}`);
		if (command.kind) {
			lines.push(`      kind: ${command.kind}`);
		}
		if (command.origin) {
			lines.push(`      origin: ${command.origin}`);
		}
		if (command.label) {
			lines.push(`      label: ${JSON.stringify(command.label)}`);
		}
	}
	return lines;
}
