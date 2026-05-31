import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test } from "../spectorator/index.ts";

async function withTempDir(prefix: string, run: (dir: string) => Promise<void> | void): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("parseArgs parses free-form input and options", () => {
	const parsed = __test.parseArgs('--title "Browser Specs" --path specs/browser.md add browser review for specs');
	assert.equal(parsed.help, false);
	assert.equal(parsed.title, "Browser Specs");
	assert.equal(parsed.path, "specs/browser.md");
	assert.equal(parsed.input, "add browser review for specs");
});

test("parseArgs rejects unknown options", () => {
	assert.throws(() => __test.parseArgs("--wat idea"), /unknown option: --wat/);
});

test("normalizeMarkdownFilename adds .md and rejects non-markdown", () => {
	assert.equal(__test.normalizeMarkdownFilename("draft"), "draft.md");
	assert.equal(__test.normalizeMarkdownFilename("draft.markdown"), "draft.markdown");
	assert.throws(() => __test.normalizeMarkdownFilename("draft.txt"), /only supports markdown/);
});

test("resolveOutputSpecPath uses configured directory for generated specs", async () => {
	await withTempDir("spectorator-path-", async (root) => {
		const specDir = path.join(root, "specs");
		const resolved = __test.resolveOutputSpecPath({
			title: "Add Browser Review!",
			cwd: root,
			specDir,
		});
		assert.equal(resolved, path.join(specDir, "add-browser-review.md"));
	});
});

test("resolveOutputSpecPath avoids overwriting generated specs", async () => {
	await withTempDir("spectorator-unique-", async (root) => {
		const specDir = path.join(root, "specs");
		await fs.mkdir(specDir, { recursive: true });
		await fs.writeFile(path.join(specDir, "existing-spec.md"), "old", "utf8");

		const resolved = __test.resolveOutputSpecPath({
			title: "Existing Spec",
			cwd: root,
			specDir,
		});
		assert.equal(resolved, path.join(specDir, "existing-spec-2.md"));
	});
});

test("resolveOutputSpecPath resolves explicit bare paths in spec dir", async () => {
	await withTempDir("spectorator-explicit-", async (root) => {
		const specDir = path.join(root, "specs");
		const resolved = __test.resolveOutputSpecPath({
			inputPath: "explicit",
			title: "Ignored",
			cwd: root,
			specDir,
		});
		assert.equal(resolved, path.join(specDir, "explicit.md"));
	});
});

test("buildSpecSkeleton creates fixed H1 structure with xxx markers", () => {
	const skeleton = __test.buildSpecSkeleton("Spectorator", "create specs interactively");
	assert.match(skeleton, /^---\ntitle: "Spectorator"/);
	assert.match(skeleton, /^# Abstract$/m);
	assert.match(skeleton, /^# Rationale$/m);
	assert.match(skeleton, /^# Specification$/m);
	assert.match(skeleton, /^# Further Information$/m);
	assert.match(skeleton, /xxx: One-sentence summary of the proposal\./);
	assert.match(skeleton, /xxx: One-sentence reason this work is needed\./);
	assert.match(skeleton, /> create specs interactively/);
});

test("analyzeSpecStructure catches missing, wrong-level, duplicate, and unexpected H1 sections", () => {
	const analysis = __test.analyzeSpecStructure([
		"## Abstract",
		"# Rationale",
		"# Specification",
		"# Specification",
		"# Extra",
		"xxx: clarify",
	].join("\n"));

	assert.deepEqual(analysis.missingRequired, []);
	assert.equal(analysis.wrongLevel.length, 1);
	assert.equal(analysis.wrongLevel[0].section, "Abstract");
	assert.deepEqual(analysis.duplicateH1, ["Specification"]);
	assert.deepEqual(analysis.unexpectedH1, ["Extra"]);
	assert.equal(analysis.xxxCount, 1);
});

test("buildSpectoratorPrompt renders custom template", () => {
	const prompt = __test.buildSpectoratorPrompt({
		specPath: "/tmp/spec.md",
		title: "My Spec",
		userInput: "do a thing",
		template: "{{SPEC_TITLE}} {{SPEC_PATH}} {{USER_INPUT}} {{REVIEW_TOOL}}",
	});
	assert.equal(prompt, "My Spec /tmp/spec.md do a thing spectorator_review_spec");
});

test("requestPlannotatorPlanReview resolves matching review result events", async () => {
	let reviewResultHandler: ((data: unknown) => void) | undefined;
	const pi = {
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				assert.equal(channel, "plannotator:review-result");
				reviewResultHandler = handler;
				return () => {
					reviewResultHandler = undefined;
				};
			},
			emit(_channel: string, request: { respond: (response: unknown) => void; payload: unknown }) {
				assert.equal(_channel, "plannotator:request");
				assert.deepEqual(request.payload, {
					planContent: "# Abstract",
					planFilePath: "/tmp/spec.md",
				});
				request.respond({ status: "handled", result: { status: "pending", reviewId: "r1" } });
				queueMicrotask(() => reviewResultHandler?.({ reviewId: "r1", approved: true, feedback: "" }));
			},
		},
	};

	const result = await __test.requestPlannotatorPlanReview(pi as never, {
		planContent: "# Abstract",
		planFilePath: "/tmp/spec.md",
	});
	assert.equal(result.approved, true);
});

test("requestPlannotatorPlanReview rejects unavailable responses", async () => {
	const pi = {
		events: {
			on() {
				return () => {};
			},
			emit(_channel: string, request: { respond: (response: unknown) => void }) {
				request.respond({ status: "unavailable", error: "not loaded" });
			},
		},
	};

	await assert.rejects(
		() => __test.requestPlannotatorPlanReview(pi as never, {
			planContent: "# Abstract",
			planFilePath: "/tmp/spec.md",
		}),
		/not loaded/,
	);
});
