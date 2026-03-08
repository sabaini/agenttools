import assert from "node:assert/strict";
import test from "node:test";

import { runValidationProfile } from "../planner-runtime/validation-execution.ts";

test("runValidationProfile blocks canonical failures and logs exploratory failures as advisory by default", async () => {
	const summary = await runValidationProfile({
		commands: [
			{ command: "npm test", kind: "test", origin: "canonical" },
			{ command: "npx tsc --noEmit", kind: "typecheck", origin: "exploratory" },
		],
		executeCommand: async (command) => {
			if (command === "npm test") {
				return { code: 1, stdout: "", stderr: "tests failed" };
			}
			return { code: 1, stdout: "", stderr: "type errors" };
		},
	});

	assert.equal(summary.blockingFailures.length, 1);
	assert.equal(summary.blockingFailures[0]?.command, "npm test");
	assert.equal(summary.advisoryFailures.length, 1);
	assert.equal(summary.advisoryFailures[0]?.command, "npx tsc --noEmit");
});

test("runValidationProfile escalates exploratory failures when explicitly requested", async () => {
	const summary = await runValidationProfile({
		commands: [
			{ command: "npx tsc --noEmit", kind: "typecheck", origin: "exploratory" },
			{ command: "npm run test:e2e", kind: "test", origin: "exploratory" },
		],
		blockingExploratoryKinds: ["typecheck"],
		blockingExploratoryCommands: ["npm run test:e2e"],
		executeCommand: async () => ({ code: 1, stdout: "", stderr: "failed" }),
	});

	assert.equal(summary.blockingFailures.length, 2);
	assert.deepEqual(
		summary.blockingFailures.map((failure) => failure.command).sort(),
		["npm run test:e2e", "npx tsc --noEmit"],
	);
	assert.equal(summary.advisoryFailures.length, 0);
});
