# Idnest Authentication Platform

Idnest is an independent authentication, identity, OAuth 2.0, and OpenID
Connect platform. It is built upon Ory Hydra and Ory Kratos, with Express
backends, Angular frontends, PostgreSQL, and a shared authorization store in an
Nx workspace.

This root README is the project entry point. Detailed operational guidance lives
next to the files and scripts it describes.

## Documentation

| Area | Guide |
| --- | --- |
| Local setup and environment files | [scripts/setup/README.md](scripts/setup/README.md) |
| Local Hydra/Kratos Docker stack and application images | [scripts/docker/README.md](scripts/docker/README.md) |
| Development deployments and GitHub environments | [scripts/deploy/README.md](scripts/deploy/README.md) |
| Development VPS bootstrap and host operations | [scripts/deploy/vps/README.md](scripts/deploy/vps/README.md) |
| AWS development infrastructure | [infrastructure/terraform/aws-development/README.md](infrastructure/terraform/aws-development/README.md) |
| Auth backend, OAuth flow, and delegated authorization | [monorepo/apps/auth-backend/README.md](monorepo/apps/auth-backend/README.md) |
| Admin backend and OAuth client administration | [monorepo/apps/admin-backend/README.md](monorepo/apps/admin-backend/README.md) |
| Kratos configuration assets | [config/README.md](config/README.md) |

## Architecture

| Component | Local endpoint | Direct port | Responsibility |
| --- | --- | ---: | --- |
| Auth backend | `https://auth-local.idnest.cloud` | `4000` | Trusted Hydra/Kratos orchestration and delegated-token broker |
| Auth frontend | `https://auth-local.idnest.cloud/auth/` | `4502` | Branded login, consent, and error UI |
| Admin backend | `https://admin-local.idnest.cloud/api` | `4100` | Confidential BFF and administration API |
| Admin frontend | `https://admin-local.idnest.cloud` | `4501` | Identity and OAuth administration console |
| Hydra public API | `https://hydra-local.idnest.cloud` | `4444` | OAuth 2.0 and OpenID Connect endpoints |
| Hydra admin API | Server-side only | `4445` | Privileged OAuth administration |
| Kratos public API | `https://kratos-local.idnest.cloud` | `4433` | Identity self-service and sessions |
| Kratos admin API | Server-side only | `4434` | Privileged identity administration |

The browser-facing local hostnames require a developer-managed, locally trusted
HTTPS gateway that maps them to the direct ports below. This repository does
not install or configure that gateway. The Express backends call the Hydra and
Kratos admin APIs directly; those privileged endpoints must never be
browser-accessible.

## Repository layout

```text
.
├── config/                         # Kratos templates, identity schema, and OIDC mappers
├── infrastructure/                 # Infrastructure source files
├── monorepo/
│   ├── apps/auth-backend/          # Express OAuth orchestration service
│   ├── apps/auth-frontend/         # Angular authentication UI
│   ├── apps/admin-backend/         # Express admin BFF/API
│   ├── apps/admin-frontend/        # Angular admin console
│   └── libs/                       # Shared authorization, runtime, and types
├── scripts/
│   ├── authz/                      # Authorization database migrations
│   ├── deploy/                     # Deployment, CI release, and VPS bootstrap tooling
│   ├── docker/                     # Local Hydra and Kratos stack
│   └── setup/                      # Local bootstrap and database setup
├── .env.example                    # Hydra and Kratos configuration template
├── monorepo/.env.example           # Application configuration template
└── package.json                    # Root commands
```

## Quick Local Start

See [scripts/setup/README.md](scripts/setup/README.md) for the full local setup.
The short version is:

```bash
nvm use
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm workspace:install
cp .env.example .env
cp monorepo/.env.example monorepo/.env
pnpm bootstrap:local
```

Run the applications from separate terminals:

```bash
pnpm auth-backend:serve
pnpm auth-frontend:serve
pnpm admin-backend:serve
pnpm admin-frontend:serve
```

## Common commands

Run commands from the repository root.

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build every Nx application |
| `pnpm test` | Run all configured tests |
| `pnpm test:cors:config` | Verify that local and deployment renderers use the split Hydra, Kratos, and auth origin settings |
| `pnpm test:cors` | Run the CORS configuration check and the container-backed Hydra client integration test |
| `pnpm test:cors:live -- https://hydra-dev.idnest.cloud` | Verify metadata-only wildcard CORS and denied protected-route origins |
| `pnpm test:client-cors:integration` | Create a client in an isolated Hydra v26.2.0 container and verify its runtime CORS origins |
| `pnpm test:deploy` | Verify deployment scripts, manifests, workflow helper usage, and Compose contracts |
| `pnpm typecheck` | Type-check all projects |
| `pnpm lint` | Lint all projects |
| `pnpm auth-backend:build` | Build only the auth backend |
| `pnpm auth-frontend:build` | Build only the auth frontend |
| `pnpm admin-backend:build` | Build only the admin backend |
| `pnpm admin-frontend:build` | Build only the admin frontend |
| `pnpm authz:migrate` | Run authorization-store migrations |
| `pnpm nx -- graph` | Open the Nx project graph |

See [scripts/docker/README.md](scripts/docker/README.md) for local Hydra,
Kratos, image, and builder-image operations.

## Security notes

- Never expose the Hydra or Kratos admin APIs publicly.
- Never commit `.env` files, private keys, tokens, or generated secrets.
- Use separate random values for independent secrets and rotate exposed values.
- The admin browser receives only an opaque, HttpOnly BFF session cookie.
- The backend revalidates identity status, verified email, and active grants for
  privileged operations.
- Social identities without a verified email are rejected before tokens are
  issued.
- UI visibility is not authorization; enforcement belongs in the backend.
