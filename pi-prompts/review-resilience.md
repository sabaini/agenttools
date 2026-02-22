---
description: Review for resilience
---
Review the code for resilience and error handling.

**Look for:**
- Swallowed errors or empty catch blocks
- Missing error propagation
- Unclear error messages
- Insufficient retry/backoff logic
- Missing timeout handling
- Resource cleanup on failure (files, connections)
- Partial failure states
- Missing circuit breakers for external calls
- Unhelpful panic/crash behavior
- Recovery path gaps
- Missing debug logging

**In a charm, also check for:**
- Hooks that raise unhandled exceptions instead of catching errors and setting BlockedStatus/WaitingStatus with an actionable message
- Missing guards for not-yet-ready relations (e.g., accessing relation data before the relation exists)
- No idempotency — hooks that fail partway through and leave inconsistent state on retry

**Questions to answer:**
- What happens when external services fail?
- Can the system recover from partial failures?
- Are errors actionable for operators?
- Is logging helpful in troubleshooting?
