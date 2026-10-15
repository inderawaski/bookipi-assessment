---
name: testing-strategy
description: Choose useful tests for a change based on observable behavior, regression risk, and cost.
---

# Testing strategy

Use this skill when deciding what to test or reviewing whether a change has adequate tests. Follow the repository's existing conventions unless they make an important behavior hard to verify.

## Choose tests by behavior and risk

- Identify the user-visible or system behavior that could regress, including important boundaries and failure paths.
- Prefer tests at the narrowest level that gives reliable evidence: unit tests for isolated rules, integration tests for component boundaries and persistence, and end-to-end tests for a small number of critical user journeys.
- Add regression coverage for the defect or failure mode being fixed. Test the externally observable result, not private implementation details, unless a lower-level invariant is itself important.
- Increase coverage for data loss, security, authorization, payments, migrations, concurrency, and hard-to-reverse behavior. Keep low-risk text or mechanical changes proportionate.

## Keep tests meaningful

- Use real collaborators when their behavior is part of the contract; mock unstable or expensive boundaries such as network services, clocks, and external providers.
- Keep tests isolated and deterministic. Avoid shared mutable state, timing assumptions, and broad snapshots that obscure the assertion.
- Assert outcomes and relevant side effects. A test that only exercises a line or mirrors implementation branches without guarding behavior adds little value.
- Reuse established fixtures and helpers; add abstractions only when they reduce repeated setup without hiding what the test proves.
- Prefer the smallest reliable set of tests. Do not add a test solely to increase a count or duplicate stronger coverage at another level.

## Test-first is an option

Write a failing test first when it clarifies an unknown behavior, demonstrates a regression, or makes a small change safer. For exploratory work, UI work, infrastructure, or changes whose behavior is better evaluated at a higher level, an implementation-first or mixed approach can be more effective. Do not mandate a universal red-green-refactor sequence.

## Report evidence accurately

Run the relevant tests when requested and practical. State which commands ran and whether they passed. Never imply a check ran when it did not.
