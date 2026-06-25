#!/usr/bin/env python3
"""Prepare a deterministic code-review packet for an agent skill.

This script is intentionally dependency-free. It collects git/GitHub review input,
loads all bundled rubrics, writes a Markdown packet, and prints the packet path for
an agent to read and follow.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

DEFAULT_MAX_BYTES = 50 * 1024
DEFAULT_MAX_LINES = 2000
DEFAULT_MAIN_BRANCH = "main"
REVIEW_PREFIX = "review-"


class ReviewError(RuntimeError):
    """User-facing review preparation failure."""


@dataclass(frozen=True)
class CommandResult:
    args: list[str]
    returncode: int
    stdout: str
    stderr: str


@dataclass(frozen=True)
class Rubric:
    id: str
    label: str
    body: str
    path: Path


@dataclass(frozen=True)
class TruncationResult:
    content: str
    notice: str | None
    full_input_path: str | None


@dataclass(frozen=True)
class RepositorySnapshotStats:
    scanned_files: int
    ignored_files: int
    skipped_binary_files: int
    skipped_unreadable_files: int


@dataclass(frozen=True)
class ReviewInput:
    text: str
    label: str
    title: str
    fence_language: str
    scope_description: str
    commit_log: str = ""
    pr_context: str = ""
    repository_stats: RepositorySnapshotStats | None = None


@dataclass(frozen=True)
class RefRange:
    base: str
    head: str
    operator: str


def run(args: Iterable[str], cwd: Path, allowed_codes: tuple[int, ...] = (0,)) -> CommandResult:
    cmd = [str(arg) for arg in args]
    try:
        completed = subprocess.run(
            cmd,
            cwd=str(cwd),
            text=True,
            capture_output=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ReviewError(f"Required command not found: {cmd[0]}") from exc

    result = CommandResult(cmd, completed.returncode, completed.stdout, completed.stderr)
    if result.returncode not in allowed_codes:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}"
        raise ReviewError(f"Command failed ({' '.join(cmd)}): {detail}")
    return result


def git(args: Iterable[str], repo_root: Path, allowed_codes: tuple[int, ...] = (0,)) -> CommandResult:
    return run(["git", *args], repo_root, allowed_codes)


def find_repo_root(start: Path) -> Path:
    check = run(["git", "rev-parse", "--is-inside-work-tree"], start, allowed_codes=(0,))
    if check.stdout.strip() != "true":
        raise ReviewError(f"Not inside a git work tree: {start}")
    root = run(["git", "rev-parse", "--show-toplevel"], start, allowed_codes=(0,)).stdout.strip()
    if not root:
        raise ReviewError("Could not determine git repository root.")
    return Path(root).resolve()


def current_branch(repo_root: Path) -> str:
    result = git(["rev-parse", "--abbrev-ref", "HEAD"], repo_root, allowed_codes=(0, 128))
    branch = result.stdout.strip()
    return branch or "HEAD"


def sanitize_file_component(value: str) -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-.")
    return sanitized or "detached"


def timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")


def default_packet_path(branch: str, stamp: str) -> Path:
    return Path(".agent") / "review-packets" / f"review-packet-{stamp}-{sanitize_file_component(branch)}.md"


def default_review_output_path(branch: str, stamp: str) -> Path:
    return Path(".agent") / "reviews" / f"review-{stamp}-{sanitize_file_component(branch)}.md"


def resolve_path(value: str | None, default_relative: Path, repo_root: Path) -> tuple[Path, str]:
    raw = Path(os.path.expanduser(value)) if value else default_relative
    display = raw.as_posix()
    absolute = raw if raw.is_absolute() else repo_root / raw
    return absolute.resolve(), display


def strip_frontmatter(text: str) -> str:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return text.strip()
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            return "\n".join(lines[index + 1 :]).strip()
    return text.strip()


def review_label(review_id: str) -> str:
    if review_id.startswith(REVIEW_PREFIX):
        review_id = review_id[len(REVIEW_PREFIX) :]
    return review_id.replace("-", " ")


def load_rubrics(skill_dir: Path) -> list[Rubric]:
    rubric_dir = skill_dir / "rubrics"
    rubrics: list[Rubric] = []
    for path in sorted(rubric_dir.glob("review-*.md")):
        body = strip_frontmatter(path.read_text(encoding="utf-8"))
        if not body:
            raise ReviewError(f"Rubric is empty: {path}")
        rubrics.append(Rubric(path.stem, review_label(path.stem), body, path))
    if not rubrics:
        raise ReviewError(f"No review rubrics found in {rubric_dir}")
    return rubrics


def parse_ref_range(value: str) -> RefRange | None:
    normalized = value.strip()
    if not normalized:
        return None

    triple = normalized.find("...")
    if triple >= 0:
        base = normalized[:triple].strip()
        head = normalized[triple + 3 :].strip()
        if base and head:
            return RefRange(base, head, "...")
        return None

    double = normalized.find("..")
    if double >= 0:
        base = normalized[:double].strip()
        head = normalized[double + 2 :].strip()
        if base and head:
            return RefRange(base, head, "..")
        return None

    return None


def git_ref_exists(repo_root: Path, ref: str) -> bool:
    if not ref.strip():
        return False
    result = git(["rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"], repo_root, allowed_codes=(0, 1, 128))
    return result.returncode == 0


def git_revision_expression_exists(repo_root: Path, expression: str) -> bool:
    if not expression.strip():
        return False
    result = git(["rev-list", "--max-count=1", expression], repo_root, allowed_codes=(0, 128))
    return result.returncode == 0 and bool(result.stdout.strip())


def get_untracked_diff(repo_root: Path) -> str:
    listing = git(["ls-files", "--others", "--exclude-standard"], repo_root)
    files = [line.strip() for line in listing.stdout.splitlines() if line.strip()]
    output: list[str] = []
    for file_name in files:
        diff = git(["diff", "--no-index", "--", "/dev/null", file_name], repo_root, allowed_codes=(0, 1))
        output.append(diff.stdout)
    return "".join(output)


def get_working_diff(repo_root: Path) -> str:
    head_check = git(["rev-parse", "--verify", "HEAD"], repo_root, allowed_codes=(0, 128))
    output: list[str] = []
    if head_check.returncode == 0:
        output.append(git(["diff", "HEAD"], repo_root).stdout)
    else:
        output.append(git(["diff"], repo_root).stdout)
        output.append(git(["diff", "--cached"], repo_root).stdout)
    output.append(get_untracked_diff(repo_root))
    return "".join(output)


def get_branch_diff(repo_root: Path, base: str, head: str, operator: str) -> str:
    return git(["diff", f"{base}{operator}{head}"], repo_root).stdout


def get_revision_expression_diff(repo_root: Path, expression: str) -> str:
    return git(["diff", expression], repo_root).stdout


def get_commit_log(repo_root: Path, revision_expression: str) -> str:
    result = git(["log", "--oneline", revision_expression], repo_root, allowed_codes=(0, 128))
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def get_ignored_files(repo_root: Path) -> set[str]:
    ignored = git(
        ["ls-files", "--ignored", "--exclude-standard", "--cached", "--others"],
        repo_root,
    )
    return {line.strip() for line in ignored.stdout.splitlines() if line.strip()}


def is_binary(data: bytes) -> bool:
    return b"\0" in data


def get_repository_snapshot(repo_root: Path) -> tuple[str, RepositorySnapshotStats]:
    tracked = git(["ls-files"], repo_root)
    untracked = git(["ls-files", "--others", "--exclude-standard"], repo_root)
    ignored = get_ignored_files(repo_root)

    files = sorted(
        {
            line.strip()
            for line in f"{tracked.stdout}\n{untracked.stdout}".splitlines()
            if line.strip() and line.strip() not in ignored
        }
    )

    output: list[str] = []
    skipped_binary = 0
    skipped_unreadable = 0

    for file_name in files:
        path = repo_root / file_name
        try:
            if not path.is_file():
                continue
            data = path.read_bytes()
            if is_binary(data):
                skipped_binary += 1
                continue
            content = data.decode("utf-8", errors="replace")
            output.append(f"\n\n--- FILE: {file_name} ---\n{content}")
        except OSError:
            skipped_unreadable += 1

    stats = RepositorySnapshotStats(
        scanned_files=len(files),
        ignored_files=len(ignored),
        skipped_binary_files=skipped_binary,
        skipped_unreadable_files=skipped_unreadable,
    )
    header = (
        f"Repository snapshot ({stats.scanned_files} files scanned)"
        f"\nIgnored by .gitignore: {stats.ignored_files}"
        f"\nSkipped binary files: {stats.skipped_binary_files}"
        f"\nSkipped unreadable files: {stats.skipped_unreadable_files}"
    )
    return header + "".join(output), stats


def check_gh_auth(repo_root: Path) -> None:
    result = run(["gh", "auth", "status"], repo_root, allowed_codes=(0, 1, 2, 4))
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "gh auth status failed"
        raise ReviewError(f"GitHub CLI is not authenticated or unavailable: {detail}")


def gh_json(repo_root: Path, args: list[str]) -> dict:
    result = run(["gh", *args], repo_root)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ReviewError(f"Could not parse gh JSON output for {' '.join(args)}") from exc


def get_pr_review_input(repo_root: Path, pr_ref: str) -> ReviewInput:
    if not pr_ref.strip():
        raise ReviewError("Pull-request scope requires --pr.")
    check_gh_auth(repo_root)
    pr = gh_json(
        repo_root,
        [
            "pr",
            "view",
            pr_ref,
            "--json",
            "number,title,author,headRefName,baseRefName,url,body,state",
        ],
    )
    diff = run(["gh", "pr", "diff", pr_ref, "--color", "never"], repo_root).stdout
    commits_data = gh_json(repo_root, ["pr", "view", pr_ref, "--json", "commits"])
    commits = commits_data.get("commits") or []
    commit_log = "\n".join(
        f"{str(commit.get('oid', ''))[:7]} {commit.get('messageHeadline', '')}".rstrip()
        for commit in commits
    ).strip()

    author = pr.get("author") or {}
    body = (pr.get("body") or "").strip()
    pr_body = f"\n\nPR description:\n{body}" if body else ""
    number = pr.get("number")
    title = pr.get("title") or ""
    head_ref = pr.get("headRefName") or ""
    base_ref = pr.get("baseRefName") or ""
    context = (
        f"Pull Request: #{number} — {title}"
        f"\nAuthor: {author.get('login', '')}"
        f"\nBranches: {head_ref} → {base_ref}"
        f"\nURL: {pr.get('url', '')}"
        f"\nState: {pr.get('state', '')}"
        f"{pr_body}"
    )
    return ReviewInput(
        text=diff,
        label=f"PR #{number} ({head_ref} → {base_ref})",
        title="Diff",
        fence_language="diff",
        scope_description=f"GitHub pull request {pr_ref}",
        commit_log=commit_log,
        pr_context=context,
    )


def format_size(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes}B"
    if num_bytes < 1024 * 1024:
        value = num_bytes / 1024
        return f"{value:.1f}KB" if num_bytes < 10 * 1024 else f"{value:.0f}KB"
    return f"{num_bytes / (1024 * 1024):.1f}MB"


def truncate_head_text(text: str, max_lines: int, max_bytes: int) -> tuple[str, bool, int, int, int, int]:
    lines = text.splitlines()
    total_lines = len(lines)
    total_bytes = len(text.encode("utf-8"))
    kept: list[str] = []
    output_bytes = 0

    for index, line in enumerate(lines):
        candidate = line if index == 0 else f"\n{line}"
        candidate_bytes = len(candidate.encode("utf-8"))
        if len(kept) >= max_lines or output_bytes + candidate_bytes > max_bytes:
            break
        kept.append(line)
        output_bytes += candidate_bytes

    content = "\n".join(kept)
    truncated = len(kept) < total_lines or output_bytes < total_bytes
    return content, truncated, len(kept), total_lines, output_bytes, total_bytes


def apply_truncation_with_notice(
    text: str,
    label: str,
    extension: str,
    max_lines: int,
    max_bytes: int,
) -> TruncationResult:
    content, truncated, output_lines, total_lines, output_bytes, total_bytes = truncate_head_text(
        text,
        max_lines=max_lines,
        max_bytes=max_bytes,
    )
    if not truncated:
        return TruncationResult(content=text, notice=None, full_input_path=None)

    fd, temp_name = tempfile.mkstemp(prefix="review-input-", suffix=extension)
    os.close(fd)
    temp_path = Path(temp_name)
    temp_path.write_text(text, encoding="utf-8")
    notice = (
        f"{label} truncated: {output_lines} of {total_lines} lines "
        f"({format_size(output_bytes)} of {format_size(total_bytes)}). "
        f"Full {label.lower()} saved to: {temp_path}"
    )
    return TruncationResult(
        content=f"{content}\n\n[{notice}]",
        notice=notice,
        full_input_path=str(temp_path),
    )


def markdown_fence(content: str, language: str = "") -> str:
    longest = max((len(match.group(0)) for match in re.finditer(r"`+", content)), default=0)
    fence = "`" * max(3, longest + 1)
    suffix = language.strip()
    return f"{fence}{suffix}\n{content}\n{fence}"


def get_branch_review_input(
    repo_root: Path,
    branch: str,
    base_input: str | None,
    explicit_head: str | None,
    operator: str,
    range_input: str | None,
) -> ReviewInput:
    if range_input and (base_input or explicit_head):
        raise ReviewError("Use either --range or --base/--head for branch scope, not both.")

    base_text = (range_input or base_input or "").strip()
    if not base_text:
        raise ReviewError("Branch scope requires --base or --range.")

    base = base_text
    head = (explicit_head or branch).strip() or branch
    actual_operator = operator
    revision_expression: str | None = None

    if not explicit_head:
        parsed = parse_ref_range(base_text)
        if parsed:
            base = parsed.base
            head = parsed.head
            actual_operator = parsed.operator
        elif not git_ref_exists(repo_root, base_text):
            if git_revision_expression_exists(repo_root, base_text):
                revision_expression = base_text
            else:
                raise ReviewError(f"Base ref or revision expression not found: {base_text}")

    if revision_expression:
        diff = get_revision_expression_diff(repo_root, revision_expression)
        return ReviewInput(
            text=diff,
            label=revision_expression,
            title="Diff",
            fence_language="diff",
            scope_description=f"revision expression {revision_expression}",
            commit_log=get_commit_log(repo_root, revision_expression),
        )

    if not git_ref_exists(repo_root, base):
        raise ReviewError(f"Base ref not found: {base}")
    if not git_ref_exists(repo_root, head):
        raise ReviewError(f"Head ref not found: {head}")

    label = f"{base}{actual_operator}{head}"
    return ReviewInput(
        text=get_branch_diff(repo_root, base, head, actual_operator),
        label=label,
        title="Diff",
        fence_language="diff",
        scope_description=f"branch/range {label}",
        commit_log=get_commit_log(repo_root, f"{base}..{head}"),
    )


def get_review_input(args: argparse.Namespace, repo_root: Path, branch: str) -> ReviewInput:
    scope = args.scope
    if scope == "working-tree":
        return ReviewInput(
            text=get_working_diff(repo_root),
            label="working tree",
            title="Diff",
            fence_language="diff",
            scope_description="uncommitted working-tree changes, including staged, unstaged, and untracked files",
        )
    if scope == "branch":
        return get_branch_review_input(
            repo_root=repo_root,
            branch=branch,
            base_input=args.base,
            explicit_head=args.head,
            operator=args.operator,
            range_input=args.ref_range,
        )
    if scope == "pull-request":
        return get_pr_review_input(repo_root, args.pr_ref or "")
    if scope == "repository":
        snapshot, stats = get_repository_snapshot(repo_root)
        return ReviewInput(
            text=snapshot,
            label="repository snapshot",
            title="Codebase",
            fence_language="text",
            scope_description="complete repository snapshot: tracked plus untracked files, excluding .gitignored files",
            repository_stats=stats,
        )
    raise ReviewError(f"Unsupported scope: {scope}")


def build_packet(
    *,
    rubrics: list[Rubric],
    review_input: ReviewInput,
    repo_root: Path,
    branch: str,
    review_output_display: str,
    max_lines: int,
    max_bytes: int,
) -> str:
    truncated = apply_truncation_with_notice(
        review_input.text,
        review_input.title,
        ".diff" if review_input.fence_language == "diff" else ".txt",
        max_lines=max_lines,
        max_bytes=max_bytes,
    )

    if not review_input.text.strip():
        raise ReviewError("No review input detected for the selected scope.")

    rubric_blocks = "\n\n".join(f"### {rubric.label}\n\n{rubric.body}" for rubric in rubrics)

    repository_inventory = ""
    if review_input.repository_stats:
        stats = review_input.repository_stats
        repository_inventory = (
            "\n\n## Repository inventory\n\n"
            f"- Files scanned: {stats.scanned_files}\n"
            f"- Ignored by .gitignore: {stats.ignored_files}\n"
            f"- Skipped binary files: {stats.skipped_binary_files}\n"
            f"- Skipped unreadable files: {stats.skipped_unreadable_files}\n"
        )

    truncation_note = ""
    if truncated.notice:
        truncation_note = (
            "\n\n## Truncation notice\n\n"
            f"{truncated.notice}\n\n"
            "If your harness can read local files, inspect that full-input file before finalizing the review. "
            "If it cannot, clearly state that the review is based on the truncated packet.\n"
        )

    pr_context = ""
    if review_input.pr_context:
        pr_context = "\n\n## Pull request context\n\n" + markdown_fence(review_input.pr_context, "text") + "\n"

    commit_log = ""
    if review_input.commit_log:
        commit_log = "\n\n## Commit log\n\n" + markdown_fence(review_input.commit_log, "text") + "\n"

    scope_contract = ""
    if review_input.repository_stats:
        scope_contract = (
            "\n- This is a complete-codebase review. Do not limit the review to recent commits, "
            "branch diffs, or the last commit."
            "\n- Review the full repository snapshot represented below, subject to any truncation notice."
        )
    else:
        scope_contract = "\n- This is a change review. Focus on the diff/PR/range shown below."

    active_rubrics = ", ".join(rubric.id for rubric in rubrics)
    input_block = markdown_fence(truncated.content, review_input.fence_language)

    return f"""# Code review packet

Prepared: {datetime.now(timezone.utc).isoformat()}
Repository: `{repo_root}`
Current branch: `{branch}`
Scope: {review_input.scope_description}
Review input: {review_input.label}
Active rubrics: {active_rubrics}
Review report target: `{review_output_display}`

## Instructions for the reviewing agent

Use this packet as the deterministic source of review input. All bundled rubrics are active; do not ask the user to select rubrics.

Scope contract:{scope_contract}

Write the full review as Markdown to `{review_output_display}`. If your harness cannot write files, provide the review inline and say that file output was unavailable. After writing the review, respond to the user with a brief summary and the report path.

Review guidance:

- Prioritize actionable defects over style-only nits.
- Do not invent findings. Each finding should cite concrete evidence from the diff, snapshot, PR context, or commit log.
- Prefer fewer high-signal findings to exhaustive speculation.
- Include test-quality observations when tests are missing, weak, or insufficient for the risk introduced.
- Call out uncertainty explicitly when the packet is truncated or relevant context is unavailable.

Review calibration:

- Do not force findings for every rubric. "No material issues found" is a valid outcome.
- If a finding depends on external-system behavior, verify it against docs, source, or specs and cite it. If you cannot verify it after trying, mark it unverified and present it as a question/follow-up, not a blocker.
- Before marking a finding blocking/high-severity, identify the concrete fact that would make it not a bug and confirm that fact is false.
- Missing tests are test-quality gaps, not evidence that runtime behavior is broken.

Suggested report structure:

```markdown
# Review: {review_input.label}

## Summary

## Findings

### <severity>: <short title>
- Location: <file/function/line if available>
- Evidence: <what in the packet shows the problem>
- Impact: <why it matters>
- Recommendation: <specific fix or mitigation>

## Tests and follow-up
```
{repository_inventory}{truncation_note}
## Rubrics

{rubric_blocks}{pr_context}{commit_log}

## {review_input.title} ({review_input.label})

{input_block}
"""


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prepare a deterministic all-rubrics code-review packet.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--scope",
        required=True,
        choices=["working-tree", "branch", "pull-request", "repository"],
        help="What to review.",
    )
    parser.add_argument("--cwd", default=os.getcwd(), help="Directory inside the git repository.")
    parser.add_argument("--base", help="Base ref, tag, commit, or revision expression for branch scope.")
    parser.add_argument("--head", help="Head ref for branch scope. Defaults to the current branch.")
    parser.add_argument(
        "--range",
        dest="ref_range",
        help="Explicit ref range for branch scope, e.g. main...feature, v1.2.0..main, or abc123^!.",
    )
    parser.add_argument(
        "--operator",
        choices=["..", "..."],
        default="...",
        help="Diff operator to use with --base/--head.",
    )
    parser.add_argument("--pr", "--pr-ref", dest="pr_ref", help="PR number, URL, or branch accepted by gh pr view/diff.")
    parser.add_argument("--packet-path", help="Where to write the review packet Markdown.")
    parser.add_argument("--review-output", help="Review report path to instruct the agent to write.")
    parser.add_argument("--max-lines", type=int, default=DEFAULT_MAX_LINES, help="Maximum input lines embedded in the packet.")
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES, help="Maximum input bytes embedded in the packet.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON summary.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    try:
        start = Path(args.cwd).expanduser().resolve()
        repo_root = find_repo_root(start)
        branch = current_branch(repo_root)
        skill_dir = Path(__file__).resolve().parents[1]
        rubrics = load_rubrics(skill_dir)
        review_input = get_review_input(args, repo_root, branch)
        stamp = timestamp()

        packet_path, packet_display = resolve_path(args.packet_path, default_packet_path(branch, stamp), repo_root)
        review_output_path, review_output_display = resolve_path(
            args.review_output,
            default_review_output_path(branch, stamp),
            repo_root,
        )

        packet = build_packet(
            rubrics=rubrics,
            review_input=review_input,
            repo_root=repo_root,
            branch=branch,
            review_output_display=review_output_display,
            max_lines=args.max_lines,
            max_bytes=args.max_bytes,
        )

        packet_path.parent.mkdir(parents=True, exist_ok=True)
        review_output_path.parent.mkdir(parents=True, exist_ok=True)
        packet_path.write_text(packet, encoding="utf-8")

        if args.json:
            print(
                json.dumps(
                    {
                        "packet_path": str(packet_path),
                        "packet_display_path": packet_display,
                        "review_output_path": str(review_output_path),
                        "review_output_display_path": review_output_display,
                        "scope": args.scope,
                        "review_input_label": review_input.label,
                        "rubrics": [rubric.id for rubric in rubrics],
                    },
                    indent=2,
                )
            )
        else:
            print(f"Review packet written: {packet_path}")
            print(f"Review report target: {review_output_display}")
            print("Next: read the packet and follow its instructions to write the review report.")
        return 0
    except ReviewError as exc:
        print(f"prepare_review.py: error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("prepare_review.py: interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
