# Development VPS

This guide covers the development VPS preparation, bootstrap transfer, host
runtime boundaries, public hostname routing, and host diagnostics.

## Bootstrap the development VPS

Use an approved administrative account with `sudo` access. SSH private-key
paths are workstation-specific and must not be stored in Terraform, GitHub
variables, or repository files. The VPS runner supports Debian and Ubuntu; when
Docker is absent, it configures Docker's official Apt repository and installs
Docker Engine with the Compose and Buildx plugins following the
[official Docker installation method](https://docs.docker.com/engine/install/ubuntu/).

When a new VPS has only the provider-created `root` account, run this one-time
administrator preparation script from the trusted Mac:

```bash
./scripts/deploy/prepare-development-vps-admin.sh \
  /absolute/path/to/vps-admin-ssh-private-key
```

It defaults to creating `idnest-admin` on `vps-dev.idnest.cloud:22`, derives the
public half of the supplied SSH key locally, installs only that public key for
the new account, adds it to the standard `sudo` group, and verifies non-root SSH
and sudo before succeeding. It securely prompts for the new sudo password over
SSH; the password is not placed in command arguments or repository files. The
private key never leaves the Mac. Pass alternative values when needed:

```bash
./scripts/deploy/prepare-development-vps-admin.sh \
  ROOT_SSH_PRIVATE_KEY VPS_ADMIN_USER VPS_HOST VPS_PORT
```

This one-time preparation is the only repository script that logs in through
the provider `root` account. It does not disable provider root access, allowing
it to remain available for VPS recovery. Normal transfer, bootstrap, and GitHub
Actions deployment paths continue to reject `root`.

Before transferring the bootstrap, create one remotely managed named tunnel in
Cloudflare Zero Trust, for example `idnest-development`. Add these public
hostname routes to that tunnel:

| Public hostname | Service URL |
| --- | --- |
| `auth-dev.idnest.cloud` | `http://127.0.0.1:8444` |
| `admin-dev.idnest.cloud` | `http://127.0.0.1:8445` |
| `hydra-dev.idnest.cloud` | `http://127.0.0.1:8446` |
| `kratos-dev.idnest.cloud` | `http://127.0.0.1:8447` |

The dashboard creates the proxied DNS records for these routes. Install and run
the Cloudflare-provided `cloudflared` connector command on the VPS outside this
bootstrap flow. Initialize the protected local environment if it does not
already exist and synchronize the Terraform-owned VPS values:

```bash
test -e tmp/development.env || ./scripts/deploy/create-development-env.sh
./scripts/deploy/update-development-env-from-terraform.sh
```

At this stage the Google OAuth and bootstrap admin email placeholders may
remain; the transfer script reads only `VPS_HOST` and `VPS_PORT`. Keep this file
mode `0600`.

On the trusted Mac, run the transfer script from the repository root. Supply
the existing non-root administrative account, its workstation SSH private key,
and the protected environment file:

```bash
./scripts/deploy/transfer-development-vps-bootstrap.sh \
  idnest-admin \
  /absolute/path/to/vps-admin-ssh-private-key \
  tmp/development.env
```

The defaults are `vps-dev.idnest.cloud` and SSH port `22`. Pass a different
management endpoint after the required arguments when necessary:

```bash
./scripts/deploy/transfer-development-vps-bootstrap.sh \
  VPS_ADMIN_USER VPS_ADMIN_SSH_KEY DEVELOPMENT_ENV VPS_HOST VPS_PORT
```

The script creates the development-only archive and checksum under
`../idnest-secure`, creates `~/idnest-bootstrap` on the VPS, and transfers the
archive, checksum, VPS bootstrap runner, release-signing public key, deployment
SSH public key. It then verifies every upload on the VPS. Its explicit archive
manifest excludes production files and all application and identity secrets.
It rejects `root` and `idnest-deploy` as the administrative account; use a
separate non-root account that already has `sudo` access. The administrative
key is not the generated `idnest-deploy` key.

On the VPS, execute the transferred runner as that same non-root administrative
account:

```bash
~/idnest-bootstrap/bootstrap-development-vps.sh
```

The runner verifies all transferred checksums again before doing any privileged
work. It extracts a fresh repository tree, installs the minimum host packages
and Docker from their official Apt repositories, creates `idnest-deploy` when
needed, provisions the release processor, and installs the development
configuration templates. It invokes `sudo` only
for operations that require host privileges and refuses direct execution as
`root`. The bootstrap creates `idnest-runtime-development` with the explicit
subnet `172.23.0.0/16`. If the network already exists, provisioning verifies
that it still uses exactly this subnet and fails instead of silently accepting
network drift. The final host check proves Docker and the signed release queue
are active and rejects any Idnest origin port that is listening on a public
interface.

After the bootstrap runner completes, install and configure VPS-local
PostgreSQL from the trusted Mac. The helper reads the protected
`tmp/development.env` locally, derives the Hydra, Kratos, and Authz database
roles, passwords, and database names from the DSNs, and sends only those
database values over SSH. It does not copy the full development environment
file to the VPS.

```bash
./scripts/deploy/setup-development-vps-postgres.sh \
  idnest-admin \
  /absolute/path/to/vps-admin-ssh-private-key \
  tmp/development.env
```

The helper installs PostgreSQL when missing, creates or updates the required
roles and databases, configures PostgreSQL to listen for Docker container
traffic, adds `pg_hba.conf` entries for `idnest-runtime-development`
(`172.23.0.0/16`), restarts PostgreSQL, and verifies connectivity from a Docker
container before the first identity deployment. Run it from an interactive
terminal; the remote `sudo` commands may prompt for the `idnest-admin`
password. No separate `pg_hba.conf` edit is required after this helper succeeds.

## Validate Public Hostname Routing

The application hostnames must be public-hostname routes on the named tunnel,
not `A` or `AAAA` records that expose the VPS. The separate DNS-only
`vps-dev.idnest.cloud` record remains the SSH management endpoint. On the VPS,
confirm all Idnest ports are loopback-only:

```bash
sudo /usr/local/sbin/validate-idnest-development-host
sudo ss -ltnp
```

The provider firewall needs inbound SSH only from approved administration and
CI sources. No inbound rule is required for `8444`–`8447` when the manually
managed Cloudflare Tunnel is running. Never expose those origin ports, Hydra
admin `4445`, Kratos admin `4434`, PostgreSQL `5432`, or the Docker socket.
