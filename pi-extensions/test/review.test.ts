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

async function withCwd<T>(dir: string, run: () => Promise<T>): Promise<T> {
	const previousCwd = process.cwd();
	process.chdir(dir);
	try {
		return await run();
	} finally {
		process.chdir(previousCwd);
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
				return [
					{
						source: "prompt",
						name: "review-correctness",
						sourceInfo: {
							path: promptPath,
							source: "test",
							scope: "project",
							origin: "top-level",
						},
					},
				];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
					return { code: 0, stdout: "feat/review-core\n", stderr: "" };
				}
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "--quiet") {
					if (args[3] === "main^{commit}" || args[3] === "feat/review-core^{commit}") {
						return { code: 0, stdout: "", stderr: "" };
					}
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

test("prepareReviewRequest accepts commit refs for branch scope", async () => {
	await withTempDir("review-core-branch-commit-", async (root) => {
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
					return { code: 0, stdout: "main\n", stderr: "" };
				}
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "--quiet") {
					if (args[3] === "HEAD^^{commit}" || args[3] === "main^{commit}") {
						return { code: 0, stdout: "", stderr: "" };
					}
				}
				if (args[0] === "diff" && args[1] === "HEAD^...main") {
					return {
						code: 0,
						stdout: "diff --git a/file.ts b/file.ts\n+const value = 2;\n",
						stderr: "",
					};
				}
				throw new Error(`unexpected exec args: ${JSON.stringify(args)}`);
			},
		};

		const prepared = await prepareReviewRequest(pi as never, {
			scope: { kind: "branch", base: "HEAD^" },
		});

		assert.match(prepared.prompt, /Diff \(HEAD\^\.\.\.main\):/);
		assert.match(prepared.prompt, /\+const value = 2;/);
	});
});

test("prepareReviewRequest accepts range expressions for branch scope", async () => {
	await withTempDir("review-core-branch-range-", async (root) => {
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
					return { code: 0, stdout: "main\n", stderr: "" };
				}
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "--quiet") {
					if (args[3] === "abc123^{commit}" || args[3] === "def456^{commit}") {
						return { code: 0, stdout: "", stderr: "" };
					}
				}
				if (args[0] === "diff" && args[1] === "abc123..def456") {
					return {
						code: 0,
						stdout: "diff --git a/file.ts b/file.ts\n+const ranged = true;\n",
						stderr: "",
					};
				}
				throw new Error(`unexpected exec args: ${JSON.stringify(args)}`);
			},
		};

		const prepared = await prepareReviewRequest(pi as never, {
			scope: { kind: "branch", base: "abc123..def456" },
		});

		assert.match(prepared.prompt, /Diff \(abc123\.\.def456\):/);
		assert.match(prepared.prompt, /\+const ranged = true;/);
	});
});

test("prepareReviewRequest accepts revision expressions for branch scope", async () => {
	await withTempDir("review-core-branch-revision-expression-", async (root) => {
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
					return { code: 0, stdout: "main\n", stderr: "" };
				}
				if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "--quiet") {
					if (args[3] === "abc123^!^{commit}") {
						return { code: 1, stdout: "", stderr: "" };
					}
				}
				if (args[0] === "rev-list" && args[1] === "--max-count=1" && args[2] === "abc123^!") {
					return { code: 0, stdout: "abc123\n", stderr: "" };
				}
				if (args[0] === "diff" && args[1] === "abc123^!") {
					return {
						code: 0,
						stdout: "diff --git a/file.ts b/file.ts\n+const singleCommit = true;\n",
						stderr: "",
					};
				}
				throw new Error(`unexpected exec args: ${JSON.stringify(args)}`);
			},
		};

		const prepared = await prepareReviewRequest(pi as never, {
			scope: { kind: "branch", base: "abc123^!" },
		});

		assert.match(prepared.prompt, /Diff \(abc123\^!\):/);
		assert.match(prepared.prompt, /\+const singleCommit = true;/);
	});
});

test("prepareReviewRequest rejects unknown refs for branch scope", async () => {
	await withTempDir("review-core-branch-invalid-ref-", async (root) => {
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
					return { code: 0, stdout: "main\n", stderr: "" };
				}
				if (
					args[0] === "rev-parse" &&
					args[1] === "--verify" &&
					args[2] === "--quiet" &&
					args[3] === "not-a-ref^{commit}"
				) {
					return { code: 1, stdout: "", stderr: "" };
				}
				if (args[0] === "rev-list" && args[1] === "--max-count=1" && args[2] === "not-a-ref") {
					return { code: 1, stdout: "", stderr: "fatal: ambiguous argument 'not-a-ref'" };
				}
				throw new Error(`unexpected exec args: ${JSON.stringify(args)}`);
			},
		};

		await assert.rejects(
			() =>
				prepareReviewRequest(pi as never, {
					scope: { kind: "branch", base: "not-a-ref" },
				}),
			/Base ref 'not-a-ref' not found\./,
		);
	});
});

test("prepareReviewRequest builds a complete-codebase review packet for repository scope", async () => {
	await withTempDir("review-core-repository-", async (root) => {
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
					return { code: 0, stdout: "feat/repository-scope\n", stderr: "" };
				}
				if (args.length === 1 && args[0] === "ls-files") {
					return { code: 0, stdout: "missing-file.ts\n", stderr: "" };
				}
				if (args[0] === "ls-files" && args[1] === "--others" && args[2] === "--exclude-standard") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (
					args[0] === "ls-files" &&
					args[1] === "--ignored" &&
					args[2] === "--exclude-standard" &&
					args[3] === "--cached" &&
					args[4] === "--others"
				) {
					return { code: 0, stdout: "node_modules/cache.js\n", stderr: "" };
				}
				throw new Error(`unexpected exec args: ${JSON.stringify(args)}`);
			},
		};

		const prepared = await prepareReviewRequest(pi as never, {
			scope: { kind: "repository" },
		});

		assert.match(prepared.prompt, /Please review the complete codebase\./);
		assert.doesNotMatch(prepared.prompt, /Please review the following changes\./);
		assert.match(prepared.prompt, /Scope contract:/);
		assert.match(
			prepared.prompt,
			/Do not limit the review to recent commits, branch diffs, or the last commit\./,
		);
		assert.match(prepared.prompt, /Repository inventory:/);
		assert.match(prepared.prompt, /- Files scanned: 1/);
		assert.match(prepared.prompt, /- Ignored by \.gitignore: 1/);
		assert.match(prepared.prompt, /- Skipped unreadable files: 1/);
		assert.match(prepared.prompt, /Codebase \(repository snapshot\):/);
	});
});

test("prepareReviewRequest surfaces repository snapshot truncation before the code fence", async () => {
	await withTempDir("review-core-repository-truncated-", async (root) => {
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

		await fs.writeFile(
			path.join(root, "big.txt"),
			"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n".repeat(3000),
			"utf8",
		);

		const pi = {
			getCommands() {
				return [{ source: "prompt", name: "review-correctness", path: promptPath }];
			},
			async exec(command: string, args: string[]) {
				assert.equal(command, "git");
				if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
					return { code: 0, stdout: "feat/repository-truncated\n", stderr: "" };
				}
				if (args.length === 1 && args[0] === "ls-files") {
					return { code: 0, stdout: "big.txt\n", stderr: "" };
				}
				if (args[0] === "ls-files" && args[1] === "--others" && args[2] === "--exclude-standard") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (
					args[0] === "ls-files" &&
					args[1] === "--ignored" &&
					args[2] === "--exclude-standard" &&
					args[3] === "--cached" &&
					args[4] === "--others"
				) {
					return { code: 0, stdout: "", stderr: "" };
				}
				throw new Error(`unexpected exec args: ${JSON.stringify(args)}`);
			},
		};

		const prepared = await withCwd(root, () =>
			prepareReviewRequest(pi as never, {
				scope: { kind: "repository" },
			}),
		);

		const [beforeCodebaseFence] = prepared.prompt.split("Codebase (repository snapshot):\n```text\n");
		assert.notEqual(beforeCodebaseFence, prepared.prompt);
		assert.match(beforeCodebaseFence, /Important: Codebase truncated:/);
		assert.match(beforeCodebaseFence, /Full codebase saved to: .*pi-review-.*\.txt/);
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
