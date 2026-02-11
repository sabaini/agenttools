---
description: Review for code smells
---
Review the code for code smells and anti-patterns.

**Look for:**
- Long methods (>50 lines is suspicious)
- Deep nesting (>3 levels)
- Shotgun surgery patterns
- Feature envy
- Data clumps
- Primitive obsession
- Temporary fields
- Refused bequest
- Speculative generality
- God classes/functions
- Copy-paste code, code duplication (DRY violations)
- TODO/FIXME accumulation

**In a charm, also check for:**
- God charm class that handles every relation, action, and config option directly instead of delegating to focused handler classes/modules
- Duplicated relation handling logic across multiple event handlers instead of a shared reconcile/configure method
- Hardcoded Ceph or service constants scattered across multiple files instead of centralized in one place

**Questions to answer:**
- What will cause pain during the next change?
- What would you refactor if you owned this code?
- Is technical debt being added or paid down?
