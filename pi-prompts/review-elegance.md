---
description: Review for elegance
---
Review the code for design quality.

**Look for:**
- Unclear abstractions or naming
- Functions doing too many things
- Missing or over-engineered abstractions
- Coupling that should be loose
- Dependencies that flow the wrong direction
- Unclear data flow or control flow
- Magic numbers/strings without explanation
- Inconsistent design patterns
- Violation of SOLID principles
- Reinventing existing utilities

**In a charm, also check for:**
- Charm logic mixed into hook handlers instead of being factored into testable domain methods
- Monolithic charm.py where concerns should be split into separate modules (e.g., relations, config, lifecycle)
- Direct subprocess calls scattered throughout instead of being wrapped in a service layer

**Questions to answer:**
- Would a new team member understand this?
- Does the structure match the problem domain?
- Is the complexity justified?