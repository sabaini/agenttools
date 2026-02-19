import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test } from "../spec-to-grns.ts";

async function withTempSpec(
	filename: string,
	content: string,
	run: (specPath: string) => Promise<void> | void,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-to-grns-test-"));
	const specPath = path.join(dir, filename);
	await fs.writeFile(specPath, content, "utf8");
	try {
		await run(specPath);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("parseArgs rejects flag-like reviewer values", () => {
	assert.throws(
		() => __test.parseArgs("--reviewer --apply"),
		/--reviewer requires a value/,
	);
});

test("parseArgs rejects malformed --priority input", () => {
	assert.throws(
		() => __test.parseArgs("--priority 1abc"),
		/--priority must be an integer between 0 and 4/,
	);
});

test("parseResumeArgs rejects flag-like reviewer values", () => {
	assert.throws(
		() => __test.parseResumeArgs("--reviewer --help"),
		/--reviewer requires a value/,
	);
});

test("parseCheckpointListArgs rejects unexpected positional arguments", () => {
	assert.throws(
		() => __test.parseCheckpointListArgs("extra"),
		/unexpected argument: extra/,
	);
});

test("quoteShellArg quotes whitespace paths", () => {
	assert.equal(__test.quoteShellArg("simple/path"), "simple/path");
	assert.equal(__test.quoteShellArg("path with spaces/spec.md"), '"path with spaces/spec.md"');
});

test("parseSpecFile uses the first H1 heading for epic title", async () => {
	await withTempSpec(
		"my-epic.md",
		[
			"# My Epic",
			"",
			"Some intro",
			"",
			"# Different Heading Later",
			"",
			"## Phase Build",
			"### Milestone Setup",
		].join("\n"),
		(specPath) => {
			const plan = __test.parseSpecFile(specPath);
			assert.equal(plan.epicTitle, "My Epic");
		},
	);
});

test("parseSpecFile recognizes numbered phase headings", async () => {
	await withTempSpec(
		"numbered-phase.md",
		[
			"# Numbered Phase Spec",
			"",
			"## 1. Phase: Build",
			"### Milestone Setup",
		].join("\n"),
		(specPath) => {
			const plan = __test.parseSpecFile(specPath);
			assert.equal(plan.phases.length, 1);
			assert.equal(plan.phases[0].title, "1. Phase: Build");
			assert.equal(plan.phases[0].milestones.length, 1);
		},
	);
});

test("parseSpecFile can produce an epic-only plan when no phases exist", async () => {
	await withTempSpec(
		"epic-only.md",
		[
			"# Epic Only",
			"",
			"No phase or milestone headings in this spec.",
		].join("\n"),
		(specPath) => {
			const plan = __test.parseSpecFile(specPath);
			assert.equal(plan.phases.length, 0);
		},
	);
});

test("parseSpecFile falls back to filename when H1 headings are structural sections", async () => {
	await withTempSpec(
		"rxdb-e2ee.md",
		[
			"# Abstract",
			"",
			"# Rationale",
			"",
			"# Specification",
			"",
			"## Phase 1 — Foundation",
			"- [ ] **Milestone 1.1: Data core boundary**",
		].join("\n"),
		(specPath) => {
			const plan = __test.parseSpecFile(specPath);
			assert.equal(plan.epicTitle, "Rxdb E2ee");
			assert.equal(plan.phases.length, 1);
			assert.equal(plan.phases[0].milestones.length, 1);
			assert.equal(plan.phases[0].milestones[0].title, "Milestone 1.1: Data core boundary");
		},
	);
});

test("parseSpecFile ignores non-delivery phase headings and parses checklist milestones", async () => {
	await withTempSpec(
		"phase-filtering.md",
		[
			"# Abstract",
			"",
			"# Specification",
			"",
			"### Phase and milestone plan",
			"#### Phase 1 — Ciphertext-only replication foundation",
			"- [ ] **Milestone 1.1: Data core and schema boundary**",
			"- [ ] **Milestone 1.2: Dumb-mailbox replication (push/pull)**",
			"",
			"### Phase 1 acceptance criteria (must pass in CI)",
		].join("\n"),
		(specPath) => {
			const plan = __test.parseSpecFile(specPath);
			assert.equal(plan.phases.length, 1);
			assert.equal(plan.phases[0].title, "Phase 1 — Ciphertext-only replication foundation");
			assert.equal(plan.phases[0].milestones.length, 2);
			assert.equal(plan.phases[0].milestones[0].title, "Milestone 1.1: Data core and schema boundary");
			assert.equal(plan.phases[0].milestones[1].title, "Milestone 1.2: Dumb-mailbox replication (push/pull)");
		},
	);
});

test("extractAcceptanceCriteria normalizes checklist items", () => {
	const criteria = __test.extractAcceptanceCriteria([
		"Some context",
		"Success Criteria",
		"- [ ] first item",
		"- [x] second item",
		"",
		"**Notes**",
		"- not part of criteria",
	]);

	assert.equal(criteria, "- first item\n- second item");
});

test("applyPlan throws on partial failure, writes checkpoint, and stops follow-up entities", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-to-grns-apply-"));
	const checkpointPath = path.join(tempDir, "checkpoint.json");

	try {
		const calls: string[][] = [];
		const responses: Array<{ code: number; stdout?: string; stderr?: string }> = [
			{ code: 0, stdout: JSON.stringify({ created_id: "E-1" }) },
			{ code: 0, stdout: JSON.stringify({ created_id: "P-1" }) },
			{ code: 0, stdout: JSON.stringify({ created_id: "M-1" }) },
			{ code: 1, stderr: "milestone failed" },
		];

		const pi = {
			exec: async (_command: string, args: string[]) => {
				calls.push(args);
				const next = responses.shift();
				if (!next) {
					throw new Error("unexpected extra exec call");
				}
				return {
					code: next.code,
					stdout: next.stdout ?? "",
					stderr: next.stderr ?? "",
				};
			},
		};

		const plan = {
			specPath: "/tmp/spec.md",
			epicTitle: "Epic",
			phases: [
				{
					title: "Phase Build",
					milestones: [{ title: "Milestone One" }, { title: "Milestone Two" }],
				},
			],
		};

		await assert.rejects(
			() =>
				__test.applyPlan(
					pi as any,
					{ command: "grnsw", baseArgs: [] },
					plan,
					{
						specPath: undefined,
						apply: true,
						withValidation: false,
						reviewer: undefined,
						priority: 1,
						help: false,
					},
					{ checkpointPath },
				),
			/grnsw failed: milestone failed/,
		);

		assert.equal(calls.length, 4);
		assert.deepEqual(calls[0], [
			"--json",
			"epic",
			"new",
			"Epic",
			"--priority",
			"1",
			"--spec-id",
			"/tmp/spec.md",
			"--design",
			"/tmp/spec.md",
		]);

		const checkpointRaw = await fs.readFile(checkpointPath, "utf8");
		const checkpoint = JSON.parse(checkpointRaw);
		assert.equal(checkpoint.status, "failed");
		assert.equal(checkpoint.applied.epicId, "E-1");
		assert.equal(checkpoint.applied.phases.length, 1);
		assert.equal(checkpoint.applied.phases[0].id, "P-1");
		assert.equal(checkpoint.applied.phases[0].milestones.length, 1);
		assert.equal(checkpoint.applied.phases[0].milestones[0].id, "M-1");
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("resumePlan continues from checkpoint and completes missing entities", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-to-grns-resume-"));
	const specPath = path.join(tempDir, "spec.md");
	const checkpointPath = path.join(tempDir, "checkpoint.json");

	await fs.writeFile(
		specPath,
		[
			"# Epic",
			"",
			"## Phase Build",
			"### Milestone One",
			"Success Criteria",
			"- first",
			"",
			"### Milestone Two",
			"Success Criteria",
			"- second",
		].join("\n"),
		"utf8",
	);

	await fs.writeFile(
		checkpointPath,
		JSON.stringify(
			{
				version: 1,
				status: "failed",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				specPath,
				epicTitle: "Epic",
				priority: 1,
				withValidation: true,
				reviewer: "qa-user",
				applied: {
					epicId: "E-1",
					phases: [
						{
							title: "Phase Build",
							id: "P-1",
							milestones: [{ title: "Milestone One", id: "M-1" }],
						},
					],
				},
				error: "milestone failed",
			},
			null,
			2,
		),
		"utf8",
	);

	try {
		const calls: string[][] = [];
		const responses: Array<{ code: number; stdout?: string; stderr?: string }> = [
			{ code: 0, stdout: JSON.stringify({ created_id: "V-1" }) },
			{ code: 0, stdout: JSON.stringify({ created_id: "M-2" }) },
			{ code: 0, stdout: JSON.stringify({ created_id: "V-2" }) },
		];
		const pi = {
			exec: async (_command: string, args: string[]) => {
				calls.push(args);
				const next = responses.shift();
				if (!next) {
					throw new Error("unexpected extra exec call");
				}
				return {
					code: next.code,
					stdout: next.stdout ?? "",
					stderr: next.stderr ?? "",
				};
			},
		};

		const checkpoint = __test.loadApplyCheckpoint(checkpointPath);
		const plan = __test.parseSpecFile(specPath);
		const applied = await __test.resumePlan(
			pi as any,
			{ command: "grnsw", baseArgs: [] },
			plan,
			checkpoint,
			checkpointPath,
		);

		assert.equal(applied.epicId, "E-1");
		assert.equal(applied.phases.length, 1);
		assert.equal(applied.phases[0].milestones.length, 2);
		assert.equal(applied.phases[0].milestones[0].validationId, "V-1");
		assert.equal(applied.phases[0].milestones[1].id, "M-2");
		assert.equal(applied.phases[0].milestones[1].validationId, "V-2");

		assert.equal(calls.length, 3);
		assert.deepEqual(calls[0], [
			"--json",
			"validation",
			"add",
			"Validate: Milestone One",
			"--milestone",
			"M-1",
			"--reviewer",
			"qa-user",
			"--priority",
			"1",
			"--acceptance",
			"- first",
		]);
		assert.deepEqual(calls[1], [
			"--json",
			"milestone",
			"add",
			"Milestone Two",
			"--phase",
			"P-1",
			"--priority",
			"1",
		]);
		assert.deepEqual(calls[2], [
			"--json",
			"validation",
			"add",
			"Validate: Milestone Two",
			"--milestone",
			"M-2",
			"--reviewer",
			"qa-user",
			"--priority",
			"1",
			"--acceptance",
			"- second",
		]);

		const checkpointRaw = await fs.readFile(checkpointPath, "utf8");
		const checkpointAfter = JSON.parse(checkpointRaw);
		assert.equal(checkpointAfter.status, "completed");
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("listApplyCheckpoints summarizes statuses and resolveResumeCheckpointPath picks latest resumable", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "spec-to-grns-checkpoints-"));
	const checkpointsDir = path.join(tempDir, ".pi", "spec-to-grns", "checkpoints");
	await fs.mkdir(checkpointsDir, { recursive: true });

	const writeCheckpoint = async (fileName: string, status: string, epochMs: number) => {
		const checkpointPath = path.join(checkpointsDir, fileName);
		await fs.writeFile(
			checkpointPath,
			JSON.stringify(
				{
					version: 1,
					status,
					createdAt: new Date(epochMs - 1000).toISOString(),
					updatedAt: new Date(epochMs).toISOString(),
					specPath: "/tmp/spec.md",
					epicTitle: `Epic ${fileName}`,
					priority: 1,
					withValidation: false,
					reviewer: "reviewer",
					applied: { epicId: "E-1", phases: [] },
				},
				null,
				2,
			),
			"utf8",
		);
		const time = new Date(epochMs / 1000 * 1000);
		await fs.utimes(checkpointPath, time, time);
		return checkpointPath;
	};

	try {
		const failedPath = await writeCheckpoint("failed.json", "failed", 1_700_000_000_000);
		const completedPath = await writeCheckpoint("completed.json", "completed", 1_700_000_100_000);
		const inProgressPath = await writeCheckpoint("in-progress.json", "in-progress", 1_700_000_200_000);
		const invalidPath = path.join(checkpointsDir, "invalid.json");
		await fs.writeFile(invalidPath, "{not-json", "utf8");
		const invalidTime = new Date(1_700_000_050_000);
		await fs.utimes(invalidPath, invalidTime, invalidTime);

		const entries = __test.listApplyCheckpoints(tempDir);
		assert.equal(entries.length, 4);
		assert.equal(entries[0].path, inProgressPath);
		assert.ok(entries.some((entry: any) => entry.path === invalidPath && entry.status === "invalid"));
		assert.ok(entries.some((entry: any) => entry.path === completedPath && entry.status === "completed"));
		assert.ok(entries.some((entry: any) => entry.path === failedPath && entry.status === "failed"));

		const summary = __test.formatCheckpointList(entries, tempDir);
		assert.match(summary, /Resumable checkpoints: 2/);
		assert.match(summary, /\[FAILED\]/);
		assert.match(summary, /\[IN-PROGRESS\]/);
		assert.match(summary, /\[INVALID\]/);

		const resolved = __test.resolveResumeCheckpointPath(undefined, tempDir, false);
		assert.equal(resolved, inProgressPath);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test("runGrnswJson retries timeout failures when configured", async () => {
	let attempts = 0;
	const pi = {
		exec: async () => {
			attempts += 1;
			if (attempts === 1) {
				return {
					code: 1,
					stdout: "",
					stderr: "command timed out",
					killed: true,
				};
			}
			return {
				code: 0,
				stdout: JSON.stringify({ ok: true }),
				stderr: "",
			};
		},
	};

	const out = await __test.runGrnswJson(
		pi as any,
		{ command: "grnsw", baseArgs: [] },
		["doctor"],
		{ retries: 1, retryDelayMs: 0, timeoutMs: 25 },
	);

	assert.equal(attempts, 2);
	assert.deepEqual(out, { ok: true });
});

test("runGrnswJson surfaces timeout details", async () => {
	const pi = {
		exec: async () => ({
			code: 1,
			stdout: "",
			stderr: "",
			killed: true,
		}),
	};

	await assert.rejects(
		() =>
			__test.runGrnswJson(
				pi as any,
				{ command: "grnsw", baseArgs: [] },
				["doctor"],
				{ timeoutMs: 50 },
			),
		/grnsw timed out after 50ms/,
	);
});
