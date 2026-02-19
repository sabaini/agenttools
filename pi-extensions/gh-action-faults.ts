import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RUN_LIMIT = 20;

interface RunSummary {
	databaseId?: number;
	id?: number;
	displayTitle?: string;
	workflowName?: string;
	headBranch?: string;
	event?: string;
	createdAt?: string;
	updatedAt?: string;
	conclusion?: string;
	headSha?: string;
}

interface RunDetails extends RunSummary {
	status?: string;
	url?: string;
	runAttempt?: number;
	runNumber?: number;
	repository?: {
		nameWithOwner?: string;
	};
}

interface JobSummary {
	id?: number;
	name?: string;
	status?: string;
	conclusion?: string;
	startedAt?: string;
	completedAt?: string;
	url?: string;
}

interface ArtifactInfo {
	name: string;
	sizeInBytes?: number;
	expired?: boolean;
}

interface RepoInfo {
	nameWithOwner?: string;
	url?: string;
}

interface LogSummary {
	text: string;
	truncation?: TruncationResult;
	fullLogPath?: string;
}

function getRunId(run: RunSummary): number | null {
	return run.databaseId ?? run.id ?? null;
}

function getJobId(job: JobSummary): number | null {
	return job.id ?? null;
}

function formatRunLabel(run: RunSummary): string {
	const id = getRunId(run);
	const labelParts = [
		id ? `#${id}` : "",
		run.workflowName ?? "workflow",
		run.displayTitle ? `— ${run.displayTitle}` : "",
		run.headBranch ? `(${run.headBranch})` : "",
		run.event ? `[${run.event}]` : "",
		run.createdAt ? `@ ${run.createdAt}` : "",
	];
	return labelParts.filter(Boolean).join(" ");
}

function formatJobLabel(job: JobSummary): string {
	const id = getJobId(job);
	const statusParts = [job.status, job.conclusion].filter(Boolean).join("/");
	const labelParts = [
		id ? `#${id}` : "",
		job.name ?? "job",
		statusParts ? `[${statusParts}]` : "",
		job.startedAt ? `@ ${job.startedAt}` : "",
	];
	return labelParts.filter(Boolean).join(" ");
}

function formatArtifacts(artifacts: ArtifactInfo[]): string {
	if (artifacts.length === 0) return "(none)";
	return artifacts
		.map((artifact) => {
			const size =
				artifact.sizeInBytes !== undefined
					? formatSize(artifact.sizeInBytes)
					: "unknown size";
			const expired = artifact.expired ? "expired" : "active";
			return `- ${artifact.name} (${size}, ${expired})`;
		})
		.join("\n");
}

async function ensureRepoPath(
	pi: ExtensionAPI,
	cwd: string,
	inputPath?: string,
): Promise<string | null> {
	if (inputPath?.trim()) {
		const candidate = path.resolve(cwd, inputPath.trim());
		const result = await pi.exec("git", ["-C", candidate, "rev-parse", "--show-toplevel"]);
		if (result.code !== 0) {
			return null;
		}
		return result.stdout.trim() || candidate;
	}

	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code !== 0) return null;
	return result.stdout.trim();
}

async function promptForRepoPath(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<string | null> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const response = await ctx.ui.input("Repository path:", ctx.cwd);
		if (!response) return null;
		const candidate = path.resolve(ctx.cwd, response.trim());
		const result = await pi.exec("git", ["-C", candidate, "rev-parse", "--show-toplevel"]);
		if (result.code === 0) {
			return result.stdout.trim() || candidate;
		}
		ctx.ui.notify("That path is not a git repository.", "error");
	}
	return null;
}

async function ensureGhAuth(pi: ExtensionAPI, repoPath: string): Promise<boolean> {
	try {
		const result = await pi.exec("gh", ["auth", "status", "-h", "github.com"], {
			cwd: repoPath,
		});
		if (result.code !== 0) return false;
		const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
		if (combined.includes("not logged in") || combined.includes("not authenticated")) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

async function getRepoInfo(pi: ExtensionAPI, repoPath: string): Promise<RepoInfo | null> {
	const result = await pi.exec("gh", ["repo", "view", "--json", "nameWithOwner,url"], {
		cwd: repoPath,
	});
	if (result.code !== 0) return null;
	try {
		return JSON.parse(result.stdout) as RepoInfo;
	} catch {
		return null;
	}
}

async function listFailedRuns(pi: ExtensionAPI, repoPath: string): Promise<RunSummary[]> {
	const result = await pi.exec(
		"gh",
		[
			"run",
			"list",
			"--status",
			"failure",
			"--limit",
			String(RUN_LIMIT),
			"--json",
			"databaseId,displayTitle,workflowName,headBranch,event,createdAt,updatedAt,conclusion,headSha",
		],
		{ cwd: repoPath },
	);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || "Failed to list GitHub Actions runs");
	}
	const data = JSON.parse(result.stdout) as RunSummary[];
	return Array.isArray(data) ? data.filter((run) => getRunId(run) !== null) : [];
}

async function getRunDetails(
	pi: ExtensionAPI,
	repoPath: string,
	runId: number,
): Promise<RunDetails | null> {
	const result = await pi.exec(
		"gh",
		[
			"run",
			"view",
			String(runId),
			"--json",
			"databaseId,displayTitle,workflowName,headBranch,event,createdAt,updatedAt,conclusion,headSha,status,url,runAttempt,runNumber",
		],
		{ cwd: repoPath },
	);
	if (result.code !== 0) return null;
	try {
		return JSON.parse(result.stdout) as RunDetails;
	} catch {
		return null;
	}
}

async function listRunJobs(
	pi: ExtensionAPI,
	repoPath: string,
	repoName: string | undefined,
	runId: number,
): Promise<JobSummary[]> {
	if (!repoName) return [];
	const result = await pi.exec(
		"gh",
		["api", `repos/${repoName}/actions/runs/${runId}/jobs`],
		{ cwd: repoPath },
	);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || "Failed to list GitHub Actions jobs");
	}
	try {
		const parsed = JSON.parse(result.stdout) as {
			jobs?: Array<{
				id?: number;
				name?: string;
				status?: string;
				conclusion?: string;
				started_at?: string;
				completed_at?: string;
				html_url?: string;
			}>;
		};
		if (!Array.isArray(parsed.jobs)) return [];
		return parsed.jobs.map((job) => ({
			id: job.id,
			name: job.name,
			status: job.status,
			conclusion: job.conclusion,
			startedAt: job.started_at,
			completedAt: job.completed_at,
			url: job.html_url,
		}));
	} catch {
		throw new Error("Failed to parse GitHub Actions job list");
	}
}

async function getRunLogs(
	pi: ExtensionAPI,
	repoPath: string,
	runId: number,
	jobId?: number,
): Promise<string> {
	if (jobId) {
		const failed = await pi.exec("gh", ["run", "view", "--job", String(jobId), "--log-failed"], {
			cwd: repoPath,
		});
		if (failed.code === 0 && failed.stdout.trim()) {
			return failed.stdout;
		}

		const full = await pi.exec("gh", ["run", "view", "--job", String(jobId), "--log"], {
			cwd: repoPath,
		});
		if (full.code !== 0) {
			throw new Error(full.stderr.trim() || "Failed to fetch GitHub Actions job logs");
		}
		return full.stdout;
	}

	const failed = await pi.exec("gh", ["run", "view", String(runId), "--log-failed"], {
		cwd: repoPath,
	});
	if (failed.code === 0 && failed.stdout.trim()) {
		return failed.stdout;
	}

	const full = await pi.exec("gh", ["run", "view", String(runId), "--log"], {
		cwd: repoPath,
	});
	if (full.code !== 0) {
		throw new Error(full.stderr.trim() || "Failed to fetch GitHub Actions logs");
	}
	return full.stdout;
}

async function getArtifacts(
	pi: ExtensionAPI,
	repoPath: string,
	repoName?: string,
	runId?: number,
): Promise<ArtifactInfo[]> {
	if (!runId) return [];
	const direct = await pi.exec("gh", ["run", "view", String(runId), "--json", "artifacts"], {
		cwd: repoPath,
	});
	if (direct.code === 0) {
		try {
			const data = JSON.parse(direct.stdout) as { artifacts?: ArtifactInfo[] };
			if (Array.isArray(data.artifacts)) return data.artifacts;
		} catch {
			// fall through to API
		}
	}
	if (!repoName) return [];
	const api = await pi.exec(
		"gh",
		["api", `repos/${repoName}/actions/runs/${runId}/artifacts`],
		{ cwd: repoPath },
	);
	if (api.code !== 0) return [];
	try {
		const parsed = JSON.parse(api.stdout) as {
			artifacts?: Array<{ name: string; size_in_bytes?: number; expired?: boolean }>;
		};
		if (!Array.isArray(parsed.artifacts)) return [];
		return parsed.artifacts.map((artifact) => ({
			name: artifact.name,
			sizeInBytes: artifact.size_in_bytes,
			expired: artifact.expired,
		}));
	} catch {
		return [];
	}
}

async function downloadArtifacts(
	pi: ExtensionAPI,
	repoPath: string,
	runId: number,
	artifacts: ArtifactInfo[],
): Promise<{ directory?: string; error?: string }> {
	if (artifacts.length === 0) return {};
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `pi-gh-faults-${runId}-`));
	const result = await pi.exec(
		"gh",
		["run", "download", String(runId), "--dir", dir],
		{ cwd: repoPath },
	);
	if (result.code !== 0) {
		return { directory: dir, error: result.stderr.trim() || "Failed to download artifacts" };
	}
	return { directory: dir };
}

async function summarizeLogs(runId: number, logs: string): Promise<LogSummary> {
	const truncation = truncateTail(logs, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let text = truncation.content || "(no log output)";
	let fullLogPath: string | undefined;

	if (truncation.truncated) {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `pi-gh-faults-log-${runId}-`));
		fullLogPath = path.join(tempDir, "run.log");
		await fs.writeFile(fullLogPath, logs);
		text +=
			"\n\n[Log truncated: showing " +
			`${truncation.outputLines} of ${truncation.totalLines} lines ` +
			`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
			`Full log saved to: ${fullLogPath}]`;
	}

	return { text, truncation: truncation.truncated ? truncation : undefined, fullLogPath };
}

function buildPrompt(options: {
	repo: RepoInfo | null;
	run: RunSummary;
	details: RunDetails | null;
	job?: JobSummary | null;
	logs: LogSummary;
	artifacts: ArtifactInfo[];
	artifactsDir?: string;
	artifactError?: string;
}): string {
	const runId = getRunId(options.run);
	const details = options.details;
	const repoName = options.repo?.nameWithOwner ?? "unknown repo";
	const workflowName = details?.workflowName ?? options.run.workflowName;
	const displayTitle = details?.displayTitle ?? options.run.displayTitle;
	const conclusion = details?.conclusion ?? options.run.conclusion;
	const event = details?.event ?? options.run.event;
	const headBranch = details?.headBranch ?? options.run.headBranch;
	const headSha = details?.headSha ?? options.run.headSha;
	const createdAt = details?.createdAt ?? options.run.createdAt;
	const updatedAt = details?.updatedAt ?? options.run.updatedAt;
	const job = options.job ?? null;
	const jobId = job ? getJobId(job) : null;
	const jobLabel = job?.name ?? (jobId ? `job #${jobId}` : "selected job");

	const metadata = [
		`Repository: ${repoName}`,
		runId ? `Run ID: ${runId}` : "",
		workflowName ? `Workflow: ${workflowName}` : "",
		displayTitle ? `Title: ${displayTitle}` : "",
		details?.status ? `Status: ${details.status}` : "",
		conclusion ? `Conclusion: ${conclusion}` : "",
		event ? `Event: ${event}` : "",
		headBranch ? `Branch: ${headBranch}` : "",
		headSha ? `SHA: ${headSha}` : "",
		createdAt ? `Created: ${createdAt}` : "",
		updatedAt ? `Updated: ${updatedAt}` : "",
		details?.url ? `Run URL: ${details.url}` : "",
		jobId ? `Job ID: ${jobId}` : "",
		job?.name ? `Job: ${job.name}` : "",
		job?.status ? `Job Status: ${job.status}` : "",
		job?.conclusion ? `Job Conclusion: ${job.conclusion}` : "",
		job?.startedAt ? `Job Started: ${job.startedAt}` : "",
		job?.completedAt ? `Job Completed: ${job.completedAt}` : "",
		job?.url ? `Job URL: ${job.url}` : "",
	].filter(Boolean);

	const artifactSection = [
		"Artifacts:",
		formatArtifacts(options.artifacts),
		options.artifactsDir ? `Artifacts downloaded to: ${options.artifactsDir}` : "",
		options.artifactError ? `Artifact download error: ${options.artifactError}` : "",
	]
		.filter(Boolean)
		.join("\n");

	const logLabel = job
		? `Logs for ${jobLabel} (failed steps where available):`
		: "Logs (failed steps where available):";

	return (
		"Please analyze this GitHub Actions failure. Provide a clear root-cause analysis with evidence, " +
		"then list practical options for fixing (short-term and long-term). " +
		"Do not run commands or make changes unless I ask. If more info is needed, say what to gather.\n\n" +
		metadata.join("\n") +
		"\n\n" +
		artifactSection +
		"\n\n" +
		logLabel +
		"\n```text\n" +
		options.logs.text +
		"\n```\n"
	);
}

export default function ghActionFaultsExtension(pi: ExtensionAPI) {
	pi.registerCommand("gh-faults", {
		description: "Inspect failed GitHub Actions runs and summarize root cause",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}

			ctx.ui.setStatus("gh-faults", "Checking repository…");
			try {
				let repoPath = await ensureRepoPath(pi, ctx.cwd, args);
				if (!repoPath) {
					repoPath = await promptForRepoPath(pi, ctx);
				}
				if (!repoPath) {
					ctx.ui.setStatus("gh-faults", undefined);
					return;
				}

				const authOk = await ensureGhAuth(pi, repoPath);
				if (!authOk) {
					ctx.ui.setStatus("gh-faults", undefined);
					ctx.ui.notify("GitHub CLI not authenticated. Run 'gh auth login' and retry.", "error");
					return;
				}

				ctx.ui.setStatus("gh-faults", "Loading repository info…");
				const repoInfo = await getRepoInfo(pi, repoPath);
				if (!repoInfo?.nameWithOwner) {
					ctx.ui.setStatus("gh-faults", undefined);
					ctx.ui.notify("Unable to resolve GitHub repository. Is this a GitHub repo?", "error");
					return;
				}

				ctx.ui.setStatus("gh-faults", "Fetching failed runs…");
				const runs = await listFailedRuns(pi, repoPath);
				if (runs.length === 0) {
					ctx.ui.setStatus("gh-faults", undefined);
					ctx.ui.notify("No failed runs found.", "info");
					return;
				}

				const runLabels = runs.map(formatRunLabel);
				ctx.ui.setStatus("gh-faults", undefined);
				const selectedLabel = await ctx.ui.select("Select a failed run:", runLabels);
				if (!selectedLabel) return;

				const runIndex = runLabels.indexOf(selectedLabel);
				const selectedRun = runs[runIndex];
				const runId = selectedRun ? getRunId(selectedRun) : null;
				if (!selectedRun || !runId) {
					ctx.ui.notify("Unable to resolve selected run.", "error");
					return;
				}

				ctx.ui.setStatus("gh-faults", "Fetching run details…");
				const runDetails = await getRunDetails(pi, repoPath, runId);

				ctx.ui.setStatus("gh-faults", "Fetching jobs…");
				const jobs = await listRunJobs(pi, repoPath, repoInfo.nameWithOwner, runId);
				if (jobs.length === 0) {
					ctx.ui.setStatus("gh-faults", undefined);
					ctx.ui.notify("No jobs found for the selected run.", "error");
					return;
				}

				const jobLabels = jobs.map(formatJobLabel);
				const runLogOption = "Entire run (all failed steps)";
				ctx.ui.setStatus("gh-faults", undefined);
				const selectedJobLabel = await ctx.ui.select(
					"Select a job to analyze:",
					[runLogOption, ...jobLabels],
				);
				if (!selectedJobLabel) return;

				let selectedJob: JobSummary | null = null;
				let selectedJobId: number | null = null;
				if (selectedJobLabel !== runLogOption) {
					const jobIndex = jobLabels.indexOf(selectedJobLabel);
					selectedJob = jobs[jobIndex];
					selectedJobId = selectedJob ? getJobId(selectedJob) : null;
					if (!selectedJob || !selectedJobId) {
						ctx.ui.notify("Unable to resolve selected job.", "error");
						return;
					}
				}

				ctx.ui.setStatus(
					"gh-faults",
					selectedJob ? "Fetching job logs…" : "Fetching logs…",
				);
				const logs = await getRunLogs(pi, repoPath, runId, selectedJobId ?? undefined);
				const logSummary = await summarizeLogs(selectedJobId ?? runId, logs);

				ctx.ui.setStatus("gh-faults", "Checking artifacts…");
				const artifacts = await getArtifacts(pi, repoPath, repoInfo.nameWithOwner, runId);
				let artifactsDir: string | undefined;
				let artifactError: string | undefined;
				if (artifacts.length > 0) {
					ctx.ui.setStatus("gh-faults", "Downloading artifacts…");
					const download = await downloadArtifacts(pi, repoPath, runId, artifacts);
					artifactsDir = download.directory;
					artifactError = download.error;
				}

				ctx.ui.setStatus("gh-faults", undefined);

				const prompt = buildPrompt({
					repo: repoInfo,
					run: selectedRun,
					details: runDetails,
					job: selectedJob,
					logs: logSummary,
					artifacts,
					artifactsDir,
					artifactError,
				});

				pi.sendUserMessage(prompt);
			} catch (error) {
				ctx.ui.setStatus("gh-faults", undefined);
				ctx.ui.notify(`Failed to inspect GitHub Actions runs: ${String(error)}`, "error");
			}
		},
	});
}
