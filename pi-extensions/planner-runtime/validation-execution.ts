import type { ValidationCommandSpec, ValidationKind } from "./models.ts";

export interface ValidationCommandExecution {
	command: string;
	kind?: ValidationKind;
	origin: "canonical" | "exploratory";
	label?: string;
	status: "passed" | "failed";
	blocking: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface RunValidationProfileOptions {
	commands: ValidationCommandSpec[];
	blockingExploratoryKinds?: ValidationKind[];
	blockingExploratoryCommands?: string[];
	executeCommand: (command: string) => Promise<{
		code: number;
		stdout?: string;
		stderr?: string;
	}>;
}

export interface ValidationExecutionSummary {
	results: ValidationCommandExecution[];
	passed: ValidationCommandExecution[];
	blockingFailures: ValidationCommandExecution[];
	advisoryFailures: ValidationCommandExecution[];
}

function normalizeOrigin(command: ValidationCommandSpec): "canonical" | "exploratory" {
	return command.origin === "exploratory" ? "exploratory" : "canonical";
}

function isBlockingFailure(
	command: ValidationCommandSpec,
	options: Pick<RunValidationProfileOptions, "blockingExploratoryKinds" | "blockingExploratoryCommands">,
): boolean {
	const origin = normalizeOrigin(command);
	if (origin === "canonical") {
		return true;
	}

	const blockingKinds = new Set(options.blockingExploratoryKinds ?? []);
	const blockingCommands = new Set((options.blockingExploratoryCommands ?? []).map((entry) => entry.trim()).filter(Boolean));
	if (command.kind && blockingKinds.has(command.kind)) {
		return true;
	}
	if (blockingCommands.has(command.command.trim())) {
		return true;
	}
	return false;
}

export async function runValidationProfile(
	options: RunValidationProfileOptions,
): Promise<ValidationExecutionSummary> {
	const results: ValidationCommandExecution[] = [];

	for (const command of options.commands) {
		const normalizedCommand = command.command.trim();
		if (!normalizedCommand) {
			continue;
		}

		let execution;
		try {
			execution = await options.executeCommand(normalizedCommand);
		} catch (error) {
			execution = {
				code: 1,
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error),
			};
		}

		const failed = execution.code !== 0;
		results.push({
			command: normalizedCommand,
			kind: command.kind,
			origin: normalizeOrigin(command),
			label: command.label,
			status: failed ? "failed" : "passed",
			blocking: failed ? isBlockingFailure(command, options) : false,
			exitCode: execution.code,
			stdout: execution.stdout ?? "",
			stderr: execution.stderr ?? "",
		});
	}

	return {
		results,
		passed: results.filter((result) => result.status === "passed"),
		blockingFailures: results.filter((result) => result.status === "failed" && result.blocking),
		advisoryFailures: results.filter((result) => result.status === "failed" && !result.blocking),
	};
}
