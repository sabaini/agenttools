import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	__test,
	prepareReviewRequest,
	restoreSelection,
	type ReviewType,
} from "../review/core.ts";

async function withTempDir(prefix: string, run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("prepareReviewRequest builds a deterministic branch review packet", async () => {
	await withTempDir("review-core-branch-", async (root) => {
		const promptPath = path.join(root, "review-correctness.md");
		await fs.writeFile(
			promptPath,
			[
				"---",
				"description: Review for correctness",
				"---",
				"Review the code for correctness.",
			].join("\n"),
			"utf8",
		);

		const pi = {
			getCommands() {
				return [{ source: "prompt", name: "review-correctness", path: promptPath }];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
					return { code: 0, stdout: "feat/review-core\n", stderr: "" };
				}
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "main") {
					return { code: 0, stdout: "main\n", stderr: "" };
				}
				if (args[0] === "diff" && args[1] === "main...feat/review-core") {
					return {
						code: 0,
						stdout: "diff --git a/file.ts b/file.ts\n+const value = 1;\n",
						stderr: "",
					};
				}
				throw new Error(`unexpected exec args: ${JSON.stringify(args)}`);
			},
		};

		const prepared = await prepareReviewRequest(pi as never, {
			scope: { kind: "branch", base: "main" },
		});

		assert.equal(prepared.branch, "feat/review-core");
		assert.deepEqual(prepared.activeReviews.map((review) => review.id), ["review-correctness"]);
		assert.match(prepared.prompt, /Please review the following changes\./);
		assert.match(prepared.prompt, /### correctness\nReview the code for correctness\./);
		assert.match(prepared.prompt, /Diff \(main\.\.\.feat\/review-core\):/);
		assert.match(prepared.prompt, /diff --git a\/file\.ts b\/file\.ts/);
		assert.match(prepared.prompt, /Write the full review as Markdown to `\.pi\/reviews\/review-/);
	});
});

test("restoreSelection keeps only known review ids and otherwise defaults to all", () => {
	const reviewTypes: ReviewType[] = [
		{ id: "review-correctness", label: "correctness", prompt: "..." },
		{ id: "review-security", label: "security", prompt: "..." },
	];

	const restored = restoreSelection(reviewTypes, [
		{
			type: "custom",
			customType: "review-config",
			data: {
				selectedIds: ["review-security", "review-missing"],
			},
		},
	]);
	assert.deepEqual(Array.from(restored).sort(), ["review-security"]);

	const defaulted = restoreSelection(reviewTypes, []);
	assert.deepEqual(Array.from(defaulted).sort(), ["review-correctness", "review-security"]);
});

test("buildReviewOutputPath sanitizes branch names", () => {
	const outputPath = __test.buildReviewOutputPath("feat/review core");
	assert.match(outputPath, /^\.pi[\\/]reviews[\\/]review-/);
	assert.match(outputPath, /feat-review-core\.md$/);
});
