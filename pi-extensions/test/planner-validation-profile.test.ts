import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadMilestoneSpecData } from "../planner-runtime/plan-files.ts";
import {
	applyMilestoneValidationProfile,
	composeMilestoneValidationProfile,
} from "../planner-runtime/validation-profile.ts";

async function withTempDir(prefix: string, run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("composeMilestoneValidationProfile filters baseline kinds and appends milestone-specific commands", () => {
	const profile = composeMilestoneValidationProfile(
		{
			commands: [
				{ command: "npm test", kind: "test", origin: "canonical" },
				{ command: "npm run build", kind: "build", origin: "canonical" },
				{ command: "npx tsc --noEmit", kind: "typecheck", origin: "exploratory" },
			],
		},
		{
			includeKinds: ["test", "typecheck"],
			additionalCommands: [
				{ command: "npm run test:e2e", kind: "test", origin: "exploratory", label: "e2e smoke" },
			],
		},
	);

	assert.deepEqual(profile.commands, [
		{ command: "npm test", kind: "test", origin: "canonical" },
		{ command: "npx tsc --noEmit", kind: "typecheck", origin: "exploratory" },
		{ command: "npm run test:e2e", kind: "test", origin: "exploratory", label: "e2e smoke" },
	]);
});

test("applyMilestoneValidationProfile writes an explicit validation block into spec.yaml", async () => {
	await withTempDir("planner-validation-profile-", async (root) => {
		const specPath = path.join(root, "spec.yaml");
		await fs.writeFile(
			specPath,
			[
				"goal: demo",
				"tasks:",
				"  - id: m1-t1",
				"    title: first task",
			].join("\n"),
			"utf8",
		);

		await applyMilestoneValidationProfile(specPath, {
			commands: [
				{ command: "npm test", kind: "test", origin: "canonical" },
				{ command: "npx tsc --noEmit", kind: "typecheck", origin: "exploratory" },
			],
		});

		const spec = await fs.readFile(specPath, "utf8");
		assert.ok(spec.includes("validation:"));
		assert.ok(spec.includes('command: npm test'));
		assert.ok(spec.includes("kind: test"));
		assert.ok(spec.includes("origin: canonical"));
		assert.ok(spec.includes('command: npx tsc --noEmit'));
		assert.ok(spec.includes("origin: exploratory"));
	});
});

test("applyMilestoneValidationProfile preserves an explicit empty validation profile on reload", async () => {
	await withTempDir("planner-validation-profile-empty-", async (root) => {
		const specPath = path.join(root, "spec.yaml");
		await fs.writeFile(
			specPath,
			[
				"goal: demo",
				"tasks:",
				"  - id: m1-t1",
			].join("\n"),
			"utf8",
		);

		await applyMilestoneValidationProfile(specPath, { commands: [] });

		const spec = await fs.readFile(specPath, "utf8");
		assert.ok(spec.includes("validation:"));
		assert.ok(spec.includes("commands: []"));

		const parsed = await loadMilestoneSpecData(specPath);
		assert.deepEqual(parsed.validation, { commands: [] });
	});
});
