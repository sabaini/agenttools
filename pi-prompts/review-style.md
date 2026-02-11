---
description: Review for style
---
Review the code for style and convention compliance.

**Look for:**
- Naming convention violations
- Formatting inconsistencies
- Import organization issues
- Comment quality (missing, outdated, or obvious)
- Documentation gaps for public APIs
- Inconsistent patterns within the codebase
- Lint/format violations
- Test naming and organization
- Log message quality and levels

**In a charm, also check for:**
- Config keys not using lowercase-hyphen convention as expected by Juju
- Status messages that are unclear to operators — they should be concise and actionable
- Inconsistent naming between metadata.yaml identifiers and Python references (e.g., relation names, config options)

**Questions to answer:**
- Does this match the rest of the codebase?
- Would the style guide approve?
- Is the code self-documenting where possible?