---
description: Review for performance
---
Review the code for performance issues.

**Look for:**
- O(n²) or worse algorithms where O(n) is possible
- Unnecessary allocations in hot paths
- Missing caching opportunities
- N+1 query patterns (database or API)
- Blocking operations in async contexts
- Memory leaks or unbounded growth
- Excessive string concatenation
- Unoptimized regex or parsing

**In a charm, also check for:**
- Expensive operations inside frequently-fired hooks (e.g., update-status)
- Repeated subprocess calls where a single call could capture all needed data
- Large relation data bags that get serialized/deserialized on every hook invocation

**Questions to answer:**
- What happens at 10x, 100x, 1000x scale?
- Are there obvious optimizations being missed?
- Is performance being traded for readability appropriately?