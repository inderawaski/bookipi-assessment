---
name: project-structure
description: Generic guidance for domain-first, responsibility-separated project organization without a rigid folder template.
---

# Project structure

Use for new domains, module boundaries, refactors, and project initialization.

- Inspect existing structure and conventions before proposing changes.
- Organize primarily by domain when useful, then separate responsibilities inside each domain.
- Colocate feature-specific behavior; extract shared code for demonstrated reuse.
- Keep domain rules distinct from framework and infrastructure glue where practical.
- Prefer simple interfaces and dependency direction over ceremonial layers.
- Avoid premature abstractions, universal folder schemas, and unrelated refactors.
- Check how structure affects tests, imports, navigation, and change locality.
- State meaningful tradeoffs and exceptions.

This skill is intentionally framework-agnostic. Projects may add concrete examples in local references.
