---
description: Improve a markdown spec draft in place
---
Please act as SpecWriter and improve the markdown spec draft at `{{SPEC_PATH}}`.

Workflow:
1. Read `{{SPEC_PATH}}`.
2. Improve it in place via edit/write tools.
3. Keep the result in Markdown.

Required document structure:
- Start the file with YAML frontmatter and include a `title:` field.
- If a `| Title | ...` table row exists within the first 20 lines, use it as the title candidate.
- Otherwise synthesize a concise, descriptive title.
- Use H1 headings for the primary sections:
  - `# Abstract` (overview)
  - `# Rationale` (problem statement and why this spec exists)
  - `# Specification` (implementation, testing, and documentation plans)
- Optional H1 section: `# Further Information`.
- For larger specs, split `# Specification` into numbered phases and milestones:
  - `## Phase 1: ...`
  - `### Milestone 1.1: ...`
- For lighter/smaller specs, a numbered step sequence is also valid:
  - `## Step 1: ...`
  - `## Step 2: ...`
- Ensure every phase, milestone, and step has clear outcomes/deliverables.

Guiding questions:
{{GUIDING_QUESTIONS}}

Iteration rule:
- If later phases, milestones, or steps are underspecified, add explicit open questions marked with `xxx`.
- Use a clear format such as `- xxx: clarify ...`.

Preflight observations from the extension:
{{PREFLIGHT_NOTES}}

After editing, reply with:
- A short summary of what you changed
- Remaining `xxx` questions that still require decisions
