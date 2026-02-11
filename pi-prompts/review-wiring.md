---
description: Review for wiring gaps
---
Detect dependencies, configs, or libraries that were added but not actually used.

This catches subtle bugs where the implementer THINKS they integrated something,
but the old implementation is still being used.

**Look for:**
- New dependency in manifest but never imported
  - Go: module in go.mod but no import
  - Rust: crate in Cargo.toml but no `use`
  - Node: package in package.json but no import/require
  - Python: package in requirements.txt or pyproject.toml but no import

- SDK added but old implementation remains

- Config/env var defined but never loaded
  - New .env var that isn't accessed in code

**In a charm, also check for:**
- New relation defined in metadata.yaml/charmcraft.yaml but no corresponding event handler registered in the charm
- New config option defined but never read via self.config[...] or self.config.get(...)
- Library added to lib/ but never imported in charm code or tests

**Questions to answer:**
- Is every new dependency actually used?
- Are there old patterns that should have been replaced?
- Is there dead config that suggests incomplete migration?