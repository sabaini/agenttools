---
description: Review for correctness
---
Review the code for logical errors and edge case handling.

**Look for:**
- Logic errors and bugs
- Off-by-one errors
- Null/nil/undefined handling
- Unhandled edge cases
- Race conditions in concurrent code
- Dead code or unreachable branches
- Incorrect assumptions in comments vs code
- Integer overflow/underflow potential
- Floating point comparison issues

**In a charm, also check for:**
- Incorrect hook ordering assumptions
- Relation data that is set but never read, or expected but never set
- Status messages that don't match actual state

**Questions to answer:**
- Does the code do what it claims to do?
- What inputs could cause unexpected behavior?
- Are all code paths tested or obviously correct?