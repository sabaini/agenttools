import fs from "node:fs/promises";
import path from "node:path";

import type { MilestoneResultSummary } from "./models.ts";

export function milestoneResultPath(milestoneDir: string): string {
	return path.join(milestoneDir, "milestone-result.json");
}

export async function writeMilestoneResult(
	milestoneDir: string,
	summary: MilestoneResultSummary,
): Promise<string> {
	const outputPath = milestoneResultPath(milestoneDir);
	await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
	return outputPath;
}

export async function clearMilestoneResult(
	milestoneDir: string,
): Promise<{ outputPath: string; removed: boolean }> {
	const outputPath = milestoneResultPath(milestoneDir);
	try {
		await fs.rm(outputPath);
		return { outputPath, removed: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { outputPath, removed: false };
		}
		throw error;
	}
}
