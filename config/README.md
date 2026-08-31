# Configuration Assets

This directory contains Ory Kratos configuration templates, identity schema
assets, and OIDC mapper configuration used by local and development identity
services.

The generated Kratos runtime configuration is rendered from `config/kratos.tpl.yml`.
After changing that template locally, recreate the Kratos container so the
rendered configuration is refreshed:

```bash
docker compose -f scripts/docker/docker-compose.yml up -d --force-recreate kratos
```

Identity-service environment ownership and CORS boundaries are documented in
[scripts/setup/README.md](../scripts/setup/README.md) for local development and
[scripts/deploy/README.md](../scripts/deploy/README.md) for development
deployments.
