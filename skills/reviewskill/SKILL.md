---
name: reviewskill
description: Prepare and perform deterministic all-rubric code reviews for working-tree changes, branch/range diffs, GitHub pull requests, or complete repositories. Use when the user asks for a code review.
---

# Review Skill

Requirements: `python3` and `git`; GitHub PR reviews additionally require an authenticated `gh` CLI.

Resolve all relative paths below against this skill directory.

## Scope selection

If the user did not specify what to review, ask a short clarification. Preserve these choices:

- Working tree: staged, unstaged, and untracked local changes.
- Branch/range: current branch versus a base ref, an explicit `base..head` or `base...head` range, or a revision expression such as `abc123^!`.
- GitHub pull request: PR number, URL, or other ref accepted by `gh pr view` / `gh pr diff`.
- Repository: complete tracked + untracked repository snapshot, excluding `.gitignored` files.

Do not ask the user to select rubrics. This skill always reviews with all rubrics in `rubrics/`.

## Prepare the review packet

Run `scripts/prepare_review.py` using its absolute path while your shell is in the target repository, or pass `--cwd` for the target repository. The script finds the git repository root, gathers deterministic input, loads all rubrics, writes a Markdown packet, and prints the packet path plus the intended review-report path.

Examples, where `<skill-dir>` is this skill directory:

```bash
# Uncommitted changes, including staged, unstaged, and untracked files
python3 <skill-dir>/scripts/prepare_review.py --scope working-tree

# Current branch versus main, using merge-base diff semantics
python3 <skill-dir>/scripts/prepare_review.py --scope branch --base main

# Current branch versus another base ref
python3 <skill-dir>/scripts/prepare_review.py --scope branch --base release/v1

# Explicit range expressions
python3 <skill-dir>/scripts/prepare_review.py --scope branch --range 'main...feature-branch'
python3 <skill-dir>/scripts/prepare_review.py --scope branch --range 'v1.2.0..main'
python3 <skill-dir>/scripts/prepare_review.py --scope branch --range 'abc123^!'

# GitHub PR; requires gh to be installed and authenticated
python3 <skill-dir>/scripts/prepare_review.py --scope pull-request --pr 123
python3 <skill-dir>/scripts/prepare_review.py --scope pull-request --pr 'https://github.com/org/repo/pull/123'

# Complete codebase review
python3 <skill-dir>/scripts/prepare_review.py --scope repository

# Override output locations
python3 <skill-dir>/scripts/prepare_review.py --scope working-tree \
  --packet-path .agent/review-packets/my-packet.md \
  --review-output .agent/reviews/my-review.md
```

Useful options:

- `--cwd PATH`: directory inside the target git repository.
- `--packet-path PATH`: where to write the packet Markdown.
- `--review-output PATH`: path the packet instructs you to use for the final review report.
- `--max-lines N` and `--max-bytes N`: packet input truncation limits.
- `--json`: print a machine-readable summary.

## Perform the review

After preparing the packet:

1. Read the printed packet path.
2. Follow the packet instructions exactly.
3. Write the final review report to the packet's `Review report target` path. If your harness cannot write files, provide the review inline and say that file output was unavailable.
4. Respond to the user with a brief summary and the report path.

If the packet contains a truncation notice with a full-input path, read that full-input file before finalizing whenever your harness can read local files. If you cannot inspect it, state that limitation in the review.

Review expectations:

- Use all bundled rubrics.
- Prioritize concrete, actionable defects over style-only nits.
- Cite evidence from the packet: file names, functions, diff hunks, PR context, or commit log.
- Do not invent findings. If no material issue exists for a rubric, do not force one.
- Include test-quality observations when tests are missing, weak, or mismatched to risk.

## Optional browser presentation

Do this if a browser and GUI is on the PATH. After writing the Markdown review report, run:

```bash
python3 <skill-dir>/scripts/present_review.py <review-report.md>
```

This writes a sibling `.html` file with a small dependency-free renderer and attempts to open it in the default browser when a GUI is available.

Options:

```bash
python3 <skill-dir>/scripts/present_review.py <review-report.md> --no-open
python3 <skill-dir>/scripts/present_review.py <review-report.md> --html-path /tmp/review.html
```

If no GUI or browser is available, continue normally and tell the user where the Markdown and HTML files are.
