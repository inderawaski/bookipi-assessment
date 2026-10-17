# Project Agent Instructions

## Project Context

- Product: Flash sale architecture prototype
- Users: Developers
- Stack: TypeScript, Fastify, React + Vite, PostgreSQL, Redis + Lua, Redis Streams, Docker Compose, Vitest, Playwright, k6, pnpm

## Engineering Priorities

- Correct behavior, simplicity, maintainability, and clear boundaries.
- Follow existing patterns unless they cause a concrete problem.
- Organize primarily by business domain, with responsibility separation within each domain.
- Avoid speculative abstractions and unrelated refactoring.
- See `.agents/references/architecture-principles.md` and the installed `project-structure` skill.

## Request Modes

- **Discussion:** Answer and inspect as needed; do not edit code unless asked.
- **Implement issue:** Read the issue and linked context; inspect the repository; implement the agreed behavior; verify.
- **Direct change:** Proceed on small, clear tasks. Ask focused questions or suggest specification discovery if behavior or scope is materially unclear.

## Decision Boundaries

- Make routine technical choices autonomously.
- Ask before consequential changes to user-visible behavior, data, security, APIs, architecture, or scope.
- If the approved spec conflicts with the codebase or constraints, surface the conflict; don't silently rewrite requirements.
- Do not perform destructive actions, deploy, publish, or change external tickets without explicit authorization.

## Quality and Completion

- Use available skills for architecture, debugging, testing, verification, and review when the task calls for them; availability does not mean every skill must be invoked on every change.
- For failures, use systematic debugging to find the cause before changing code. Choose tests by observable behavior and risk; test-first work is useful when it clarifies behavior or guards a regression, but is not mandatory.
- Run relevant tests, lint, type checks, and build commands where available; do not claim unrun checks passed.
- Use the code-review skill when a review is requested or a change is consequential, broad, or security-sensitive. Tiny changes need a proportionate self-check, not a separate review stage or reviewer agent.
- Report changed behavior, checks run, limitations, and unresolved issues.
