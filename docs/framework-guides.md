# Official framework guides consulted

Consulted on 2026-10-15. Exact direct versions and the pnpm lockfile pin dependencies. Node 22 is the shared runtime; TypeScript 5.9 remains a compatible compiler for this bootstrap.

- [pnpm workspaces](https://pnpm.io/workspaces): workspace manifest and local dependencies.
- [Fastify](https://fastify.dev/docs/latest/Guides/Getting-Started/): ESM, async startup, binding and injection tests.
- [React](https://react.dev/learn/build-a-react-app-from-scratch), [Vite](https://vite.dev/guide/): React/Vite TypeScript entry and builds.
- [TypeScript](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html): NodeNext server and Bundler browser modules.
- [Vitest](https://vitest.dev/guide/), [Playwright](https://playwright.dev/docs/intro), [k6](https://grafana.com/docs/k6/latest/get-started/running-k6/): test runners and smoke setup.
- [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/): dependency health gates.
- [PostgreSQL](https://www.postgresql.org/docs/current/tutorial-start.html), [node-postgres](https://node-postgres.com/features/connecting): pooled connections.
- [Redis connections](https://redis.io/docs/latest/develop/clients/nodejs/connect/), [WAITAOF](https://redis.io/docs/latest/commands/waitaof/): connection isolation and same-connection barriers.
- [Nginx upstreams](https://nginx.org/en/docs/http/ngx_http_upstream_module.html): DNS resolution for replica routing.

- [ESLint](https://eslint.org/docs/latest/use/getting-started): flat configuration and supported Node runtime.
