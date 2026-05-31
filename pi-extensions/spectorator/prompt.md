---
description: Create and iterate a fixed-format markdown spec
---
Please act as Spectorator and create an iterative fixed-format markdown spec at `{{SPEC_PATH}}`.

Spec title: {{SPEC_TITLE}}

User input:
{{USER_INPUT}}

Workflow:
1. Read `{{SPEC_PATH}}`.
2. Fill or improve the spec in place via edit/write tools. Start with a compact draft and refine incrementally through review feedback.
3. Preserve this exact primary H1 structure:
   - `# Abstract`
   - `# Rationale`
   - `# Specification`
   - optional `# Further Information`
4. Put unresolved decisions in explicit `xxx` open-question markers.
5. When the spec is ready for human review, call `{{REVIEW_TOOL}}` with the spec path.
6. If review feedback is returned, address all feedback in the same file and call `{{REVIEW_TOOL}}` again.
7. If approved, stop; do not start implementation automatically.

Specification guidance:
- `# Abstract`: start with a single succinct sentence; expand only if review feedback makes it necessary.
- `# Rationale`: start with one short paragraph or sentence explaining why this is needed; refine incrementally.
- `# Specification`: include approach, user journey, design, scope/non-scope, implementation notes, testing/user acceptance tests, and documentation impact as applicable.
- Larger specs may subdivide `# Specification` into milestones.
- `# Further Information`: references, future work, and alternative approaches.

After approval, reply with:
- the approved spec path
- a short summary of unresolved `xxx` markers, if any
