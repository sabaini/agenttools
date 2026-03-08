import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectRepoValidationProfile, renderValidationProfileYaml } from "../planner-runtime/repo-inspection.ts";

async function withTempDir(prefix: string, run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("inspectRepoValidationProfile derives npm script commands and exploratory TypeScript fallback", async () => {
	await withTempDir("planner-repo-inspection-npm-", async (root) => {
		await fs.writeFile(
			path.join(root, "package.json"),
			JSON.stringify(
				{
					name: "demo",
					scripts: {
						test: "vitest run",
						build: "vite build",
					},
					devDependencies: {
						typescript: "^5.0.0",
					},
				},
				null,
				2,
			),
			"utf8",
		);
		await fs.writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
		await fs.writeFile(path.join(root, "tsconfig.json"), "{}\n", "utf8");

		const inspection = await inspectRepoValidationProfile(root);
		assert.equal(inspection.packageManager, "npm");
		assert.deepEqual(inspection.scripts, ["build", "test"]);
		assert.ok(inspection.configSignals.includes("package.json"));
		assert.ok(inspection.configSignals.includes("tsconfig.json"));
		assert.deepEqual(inspection.validationProfile.commands, [
			{ command: "npm test", kind: "test", origin: "canonical" },
			{ command: "npm run build", kind: "build", origin: "canonical" },
			{ command: "npx tsc --noEmit", kind: "typecheck", origin: "exploratory" },
		]);
	});
});

test("inspectRepoValidationProfile derives canonical just targets when present", async () => {
	await withTempDir("planner-repo-inspection-just-", async (root) => {
		await fs.writeFile(
			path.join(root, "justfile"),
			[
				"test:",
				"  npm test",
				"build:",
				"  npm run build",
				"typecheck:",
				"  npx tsc --noEmit",
			].join("\n"),
			"utf8",
		);

		const inspection = await inspectRepoValidationProfile(root);
		assert.deepEqual(inspection.justTargets, ["test", "build", "typecheck"]);
		assert.deepEqual(inspection.validationProfile.commands, [
			{ command: "just test", kind: "test", origin: "canonical" },
			{ command: "just build", kind: "build", origin: "canonical" },
			{ command: "just typecheck", kind: "typecheck", origin: "canonical" },
		]);
	});
});

test("renderValidationProfileYaml keeps validation blocks explicit even when empty", () => {
	assert.deepEqual(renderValidationProfileYaml({ commands: [] }), ["validation:", "  commands: []"]);
});
