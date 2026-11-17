# Direct VPS deployment

The VPS deployment path is intentionally local and contains two scripts:

- `bootstrap-idnest-host.sh` installs tracked runtime assets once.
- `deploy-idnest-version.sh` pulls and deploys one published version.

GitHub Actions does not connect to the server. Amazon ECR Public pulls require
no AWS credentials on the host.

## Prerequisites

Use a Linux ARM64 server with Docker Engine and the Docker Compose plugin. The
host also needs PostgreSQL reachable from the runtime Docker network. Keep the
application origin ports loopback-only and publish them through your existing
reverse proxy or Cloudflare Tunnel:

| Service | Loopback origin |
| --- | --- |
| Auth | `http://127.0.0.1:8444` |
| Admin | `http://127.0.0.1:8445` |
| Hydra public | `http://127.0.0.1:8446` |
| Kratos public | `http://127.0.0.1:8447` |

Hydra admin `4445`, Kratos admin `4434`, PostgreSQL, and the Docker socket must
not be publicly reachable.

## Bootstrap

Upload `deploy/` and `config/` from a trusted checkout, then run from the
uploaded repository root:

```bash
sudo ./deploy/vps/bootstrap-idnest-host.sh
```

The bootstrap copies compose/configuration assets into `/opt/idnest`, installs
the validator and deploy command under `/usr/local/sbin`, creates the runtime
network, and creates configuration templates only when they do not already
exist. Re-running it refreshes tracked scripts and compose assets without
overwriting operator configuration or runtime secrets.

Set the AWS-assigned public registry alias in `/etc/idnest/deploy.conf`. The
repository names normally remain `idnest/auth-app` and `idnest/admin-app`.
Review the other `/etc/idnest/*.conf` files for the target environment.

Install these root-owned mode-`0600` runtime files separately:

```text
/etc/idnest/idnest.env
/etc/idnest/auth-app.env
/etc/idnest/admin-app.env
```

Use the repository renderers on a trusted workstation; do not build secret
files interactively in shell history on the server.

## Deploy and roll back

```bash
sudo deploy-idnest-version VERSION [auth|admin|all]
```

Examples:

```bash
sudo deploy-idnest-version 1.4.0 all
sudo deploy-idnest-version 1.4.1 auth
sudo deploy-idnest-version 1.3.0 all  # rollback
```

The script pulls release tags, pins them to local digest references, starts and
checks Hydra/Kratos, runs their migrations, runs the Authz migration once,
provisions the admin OAuth client when admin is selected, starts the requested
applications, and checks readiness. The current release is recorded in
`/var/lib/idnest/active.env`; immutable history is kept in
`/var/lib/idnest/releases/`.

Set `SKIP_PUBLIC_HEALTH_CHECK=true` in `/etc/idnest/deploy.conf` only when the
public endpoints are intentionally not reachable from the VPS. Container and
loopback checks still run.

Application containers are restored automatically if a new application image
fails readiness. Schema changes are forward-only, so deploying an older image
does not reverse a database migration. Test backward compatibility before using
an older version as a rollback.
