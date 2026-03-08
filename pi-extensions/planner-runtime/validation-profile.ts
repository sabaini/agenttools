import type {
	MilestoneValidationProfile,
	ValidationCommandSpec,
	ValidationKind,
	ValidationOrigin,
} from "./models.ts";
import { asRecord, loadYamlFile, writeYamlFile } from "./yaml.ts";

export interface ComposeMilestoneValidationProfileOptions {
	includeKinds?: ValidationKind[];
	excludeKinds?: ValidationKind[];
	additionalCommands?: ValidationCommandSpec[];
}

const VALIDATION_KINDS = new Set<ValidationKind>(["test", "build", "lint", "typecheck", "custom"]);
const VALIDATION_ORIGINS = new Set<ValidationOrigin>(["canonical", "exploratory"]);

function normalizeValidationKind(value: string | undefined): ValidationKind | undefined {
	if (!value) {
		return undefined;
	}
	return VALIDATION_KINDS.has(value as ValidationKind) ? (value as ValidationKind) : undefined;
}

function normalizeValidationOrigin(value: string | undefined): ValidationOrigin | undefined {
	if (!value) {
		return undefined;
	}
	return VALIDATION_ORIGINS.has(value as ValidationOrigin) ? (value as ValidationOrigin) : undefined;
}

function normalizeValidationCommand(entry: ValidationCommandSpec | undefined): ValidationCommandSpec | undefined {
	const command = entry?.command?.trim();
	if (!command) {
		return undefined;
	}

	const normalized: ValidationCommandSpec = { command };
	const label = entry?.label?.trim();
	if (label) {
		normalized.label = label;
	}
	const kind = normalizeValidationKind(entry?.kind);
	if (kind) {
		normalized.kind = kind;
	}
	const origin = normalizeValidationOrigin(entry?.origin);
	if (origin) {
		normalized.origin = origin;
	}
	return normalized;
}

function pushValidationCommand(commands: ValidationCommandSpec[], entry: ValidationCommandSpec | undefined): void {
	const normalized = normalizeValidationCommand(entry);
	if (!normalized) {
		return;
	}

	const existingIndex = commands.findIndex((current) => current.command === normalized.command);
	if (existingIndex === -1) {
		commands.push(normalized);
		return;
	}

	commands[existingIndex] = {
		...commands[existingIndex],
		...normalized,
	};
}

export function composeMilestoneValidationProfile(
	baseline: MilestoneValidationProfile,
	options: ComposeMilestoneValidationProfileOptions = {},
): MilestoneValidationProfile {
	const includeKinds = options.includeKinds?.length ? new Set(options.includeKinds) : undefined;
	const excludeKinds = new Set(options.excludeKinds ?? []);
	const commands: ValidationCommandSpec[] = [];

	for (const entry of baseline.commands) {
		const normalized = normalizeValidationCommand(entry);
		if (!normalized) {
			continue;
		}
		if (normalized.kind && includeKinds && !includeKinds.has(normalized.kind)) {
			continue;
		}
		if (normalized.kind && excludeKinds.has(normalized.kind)) {
			continue;
		}
		pushValidationCommand(commands, normalized);
	}

	for (const entry of options.additionalCommands ?? []) {
		pushValidationCommand(commands, entry);
	}

	return { commands };
}

export async function applyMilestoneValidationProfile(
	filePath: string,
	profile: MilestoneValidationProfile,
): Promise<Record<string, unknown>> {
	const loaded = await loadYamlFile(filePath);
	const spec = asRecord(loaded);
	if (!spec) {
		throw new Error(`Expected top-level mapping in ${filePath}.`);
	}

	spec.validation = {
		commands: profile.commands.map((entry) => {
			const command = normalizeValidationCommand(entry);
			return command ?? { command: "" };
		}).filter((entry) => entry.command),
	};

	await writeYamlFile(filePath, spec);
	return spec;
}
