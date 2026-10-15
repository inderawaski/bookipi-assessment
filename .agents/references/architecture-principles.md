# Architecture principles

These are defaults, not an obligatory directory schema.

- **Domain boundaries:** group code by business capability where it improves navigation and ownership.
- **Responsibility boundaries:** keep UI, domain logic, data access, and integration responsibilities distinguishable.
- **Colocation:** keep feature-specific code near its feature; promote shared code only for proven reuse or clear stable boundaries.
- **Dependency direction:** domain behavior should not be needlessly coupled to framework details.
- **Local consistency:** prefer established project conventions over reorganizing code without reason.
- **Pragmatism:** avoid abstractions for imagined future features.
- **Change safety:** prefer small, reversible changes and focused tests.
- **Exceptions:** explain intentional departures in the relevant PR or project docs.

Example (illustrative, not mandatory):

```text
src/
  domains/
    billing/
      components/
      services/
      data/
    accounts/
      components/
      services/
      data/
  shared/
```
