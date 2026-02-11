---
description: Review for test quality
---
Verify tests are actually testing something meaningful.

Coverage numbers lie. A test that can't fail provides no value.

**Look for:**
- Weak assertions
  - Only checking != nil / !== null / is not None
  - Using .is_ok() without checking the value
  - assertTrue(true) or equivalent

- Missing negative test cases
  - Happy path only, no error cases
  - No boundary testing
  - No invalid input testing

- Tests that can't fail
  - Mocked so heavily the test is meaningless
  - Testing implementation details, not behavior

- Flaky test indicators
  - Sleep/delay in tests
  - Time-dependent assertions

**In a charm, also check for:**
- Mocking so much of the Juju framework that the test only verifies mock wiring, not actual charm behavior
- No harness or scenario tests for key lifecycle events (install, config-changed, relation-joined/changed/departed)
- Integration tests that only check active status without verifying the underlying service is actually configured correctly

**Questions to answer:**
- Do these tests actually verify behavior?
- Would a bug in the implementation cause a test failure?
- Are edge cases and error paths tested?