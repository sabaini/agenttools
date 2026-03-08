import fs from "node:fs/promises";

export interface ExecutionSection {
	timestamp: string;
	title: string;
	body: string;
}

export async function appendExecutionSection(
	filePath: string,
	section: ExecutionSection,
): Promise<void> {
	const existing = await fs.readFile(filePath, "utf8");
	const trimmed = existing.trimEnd();
	const next = [
		trimmed,
		"",
		`## ${section.timestamp} — ${section.title}`,
		"",
		section.body.trim(),
		"",
	].join("\n");
	await fs.writeFile(filePath, next, "utf8");
}
