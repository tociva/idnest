# Direct VPS deployment

This runbook starts the complete Idnest application stack on one ARM64 VPS:

- Ory Hydra
- Ory Kratos
- the Auth backend and frontend image
- the Admin backend and frontend image

The deployment runs locally on the VPS. GitHub Actions does not SSH to the
server, and Amazon ECR Public pulls do not require AWS credentials.

PostgreSQL is an external prerequisite. This repository does not create or
back up PostgreSQL on the VPS. Before deploying, provide reachable databases
and users for Hydra, Kratos, and Authz.

## Network layout

All application origins bind only to loopback. Publish them through an HTTPS
reverse proxy or Cloudflare Tunnel:

| Public service | VPS origin |
| --- | --- |
| Auth | http://127.0.0.1:8444 |
| Admin | http://127.0.0.1:8445 |
| Hydra public | http://127.0.0.1:8446 |
| Kratos public | http://127.0.0.1:8447 |

Hydra admin port 4445, Kratos admin port 4434, PostgreSQL, and the Docker socket
must not be publicly reachable. Normally only SSH, HTTP, and HTTPS are allowed
through the VPS firewall.

## Complete setup on a fresh Ubuntu ARM64 VPS

The commands below assume Ubuntu 24.04 ARM64 and an SSH user with sudo access.
For another Linux distribution, install Docker Engine and the Compose plugin
using Docker's distribution-specific instructions.

### 1. Prepare and upload files from the trusted workstation

The repository's renderers create the development runtime files, including the
`*-dev.idnest.cloud` URLs. When configuring or rotating Apple login, import the
downloaded PKCS#8 `.p8` key directly into the protected source file:

~~~bash
./deploy/tools/update-development-apple-key.sh \
  /secure/path/AuthKey_KEYID.p8
~~~

The command validates the key and updates only `APPLE_PRIVATE_KEY`; it does not
print the secret. Then render the three protected files on the trusted
workstation as described in [../OPERATIONS.md](../OPERATIONS.md):

~~~bash
./deploy/vps/validate-app-env.sh tmp/development.env development-source

set -a
source tmp/development.env
set +a
./deploy/tools/render-development-identity-env.sh tmp/idnest.env
./deploy/tools/render-development-app-env.sh auth tmp/auth-app.env
./deploy/tools/render-development-app-env.sh admin tmp/admin-app.env
~~~

Do not commit, print, or upload tmp/development.env. Upload only the tracked
deployment assets and the three rendered runtime files:

~~~bash
VPS=ubuntu@vps.example.com

ssh "$VPS" 'install -d -m 700 "$HOME/idnest-bootstrap"'
rsync -a deploy config "$VPS:idnest-bootstrap/"
rsync -a --chmod=F600 \
  tmp/idnest.env tmp/auth-app.env tmp/admin-app.env \
  "$VPS:idnest-bootstrap/"
~~~

Replace ubuntu@vps.example.com with the real SSH user and DNS-only hostname or
IP address. Do not use a Cloudflare-proxied application hostname for SSH.

### 2. SSH into the VPS and confirm ARM64

~~~bash
ssh ubuntu@vps.example.com

uname -m
~~~

The result must be aarch64 or arm64 because the published application images
are ARM64-only.

### 3. Install Docker Engine and Docker Compose

If Docker Engine and the Compose plugin are already installed, skip the
installation commands and run only the verification commands.

Install Docker from Docker's official Ubuntu repository:

~~~bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y \
  docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
~~~

Enable Docker and containerd at boot, start them immediately, and verify the
installation:

~~~bash
sudo systemctl enable --now docker.service containerd.service
sudo systemctl is-enabled docker.service containerd.service
sudo systemctl is-active docker.service containerd.service
sudo docker version
sudo docker compose version
sudo docker run --rm hello-world
~~~

The deployment commands intentionally use sudo. Membership in the docker group
is not required and would grant the SSH user root-equivalent access.

Docker's current Ubuntu installation instructions are maintained at
https://docs.docker.com/engine/install/ubuntu/.

### 4. Install the Idnest host assets

From the SSH session:

~~~bash
cd "$HOME/idnest-bootstrap"
sudo ./deploy/vps/bootstrap-idnest-host.sh
~~~

The bootstrap command:

- copies Compose and Kratos assets to /opt/idnest;
- installs deploy-idnest-version and the environment validator under
  /usr/local/sbin;
- creates the external runtime Docker network;
- creates configuration templates under /etc/idnest only when they do not
  already exist.

It is safe to rerun after uploading a newer trusted checkout. It refreshes
tracked deployment assets without replacing operator configuration or runtime
secrets.

### 5. Select development or production configuration

Bootstrap installs the development examples on a new host. Review all four
files:

~~~bash
sudoedit /etc/idnest/deploy.conf
sudoedit /etc/idnest/idnest.conf
sudoedit /etc/idnest/auth.conf
sudoedit /etc/idnest/admin.conf
~~~

Set the public ECR registry alias and keep the published repository names:

~~~text
ECR_PUBLIC_REGISTRY=public.ecr.aws/replace-with-registry-alias
AUTH_ECR_REPOSITORY=idnest/auth-app
ADMIN_ECR_REPOSITORY=idnest/admin-app
SKIP_PUBLIC_HEALTH_CHECK=false
~~~

For production, install the production configuration templates before editing
them:

~~~bash
cd "$HOME/idnest-bootstrap"
sudo install -o root -g root -m 600 \
  deploy/vps/idnest.production.conf.example /etc/idnest/idnest.conf
sudo install -o root -g root -m 600 \
  deploy/vps/auth.production.conf.example /etc/idnest/auth.conf
sudo install -o root -g root -m 600 \
  deploy/vps/admin.production.conf.example /etc/idnest/admin.conf
~~~

Confirm that the Compose project names, Docker network names, public health
URLs, and loopback ports match the chosen environment.

The development renderers in step 1 do not generate production runtime files.
For production, prepare equivalent `idnest.env`, `auth-app.env`, and
`admin-app.env` files with production URLs on a trusted workstation, then run
the same validators and installation commands below.

### 6. Install and validate runtime secrets

Install the three rendered files as root-owned mode-0600 files:

~~~bash
cd "$HOME/idnest-bootstrap"
sudo install -o root -g root -m 600 idnest.env /etc/idnest/idnest.env
sudo install -o root -g root -m 600 auth-app.env /etc/idnest/auth-app.env
sudo install -o root -g root -m 600 admin-app.env /etc/idnest/admin-app.env

sudo validate-idnest-app-env /etc/idnest/idnest.env identity
sudo validate-idnest-app-env /etc/idnest/auth-app.env auth
sudo validate-idnest-app-env /etc/idnest/admin-app.env admin
~~~

After validation, remove only the staging copies; the protected copies remain
under /etc/idnest:

~~~bash
rm -f idnest.env auth-app.env admin-app.env
~~~

The Hydra, Kratos, and Authz PostgreSQL DSNs in these files must be reachable
from containers on the configured runtime network. When PostgreSQL runs on the
same VPS, host.docker.internal resolves to Docker's host gateway. PostgreSQL
must listen on that private gateway and authorize only the required Docker
network; do not expose port 5432 publicly.

### 7. Configure HTTPS routes

Before the first deployment, configure the reverse proxy or Cloudflare Tunnel
routes from the public hostnames to the four loopback origins in the network
table above.

The deployment command checks both loopback and public health endpoints. If the
public routes are intentionally unavailable during initial setup, temporarily
set this in /etc/idnest/deploy.conf:

~~~text
SKIP_PUBLIC_HEALTH_CHECK=true
~~~

Restore it to false after HTTPS routing is ready and run the deployment again
to verify public health.

### 8. Pull and start the complete application

Pass the semantic version without the component prefix. For the published tags
auth-v0.1.1 and admin-v0.1.1, run:

~~~bash
sudo deploy-idnest-version 0.1.1 all
~~~

The command:

1. pulls auth-v0.1.1 and admin-v0.1.1 anonymously from ECR Public;
2. resolves both tags to immutable image digests;
3. pulls and starts Hydra and builds the local Kratos wrapper;
4. runs Hydra, Kratos, and Authz migrations;
5. provisions the Admin OAuth client;
6. starts Auth and Admin with Docker Compose in detached mode;
7. waits for container, loopback, and public health checks;
8. records the active version and digests under /var/lib/idnest.

The command returns only after the requested services are healthy. The
containers continue running in the background after the SSH session closes.

## Verify the running application

List the containers and their health:

~~~bash
sudo docker ps --format \
  'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
~~~

Check all loopback origins:

~~~bash
curl --fail --silent --show-error http://127.0.0.1:8444/health
curl --fail --silent --show-error http://127.0.0.1:8445/health
curl --fail --silent --show-error http://127.0.0.1:8446/health/ready
curl --fail --silent --show-error http://127.0.0.1:8447/health/ready
~~~

Check the recorded deployment:

~~~bash
sudo cat /var/lib/idnest/active.env
sudo ls -1 /var/lib/idnest/releases
~~~

Inspect logs:

~~~bash
sudo docker logs --tail 100 idnest-hydra
sudo docker logs --tail 100 idnest-kratos

sudo docker compose \
  --file /opt/idnest/auth/compose.yaml \
  --env-file /opt/idnest/auth/release.env \
  logs --tail 100 auth

sudo docker compose \
  --file /opt/idnest/admin/compose.yaml \
  --env-file /opt/idnest/admin/release.env \
  logs --tail 100 admin
~~~

## Automatic restart after a VPS reboot

No separate application systemd unit or cron job is required:

- Docker and containerd are enabled through systemd.
- Every Hydra, Kratos, Auth, and Admin service uses restart: unless-stopped.
- The deployment command creates the containers with Compose in detached mode.

Verify the restart policy:

~~~bash
sudo docker inspect \
  --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}}' \
  $(sudo docker ps --quiet)
~~~

Every Idnest container must report restart=unless-stopped.

Perform one controlled reboot test:

~~~bash
sudo reboot
~~~

The SSH connection will close. After the VPS returns, reconnect and verify:

~~~bash
ssh ubuntu@vps.example.com

sudo systemctl is-active docker.service containerd.service
sudo docker ps --format 'table {{.Names}}\t{{.Status}}'

curl --fail --silent --show-error http://127.0.0.1:8444/health
curl --fail --silent --show-error http://127.0.0.1:8445/health
curl --fail --silent --show-error http://127.0.0.1:8446/health/ready
curl --fail --silent --show-error http://127.0.0.1:8447/health/ready
~~~

Do not use docker compose stop when the services should return automatically
after reboot. The unless-stopped policy intentionally preserves a manual stop.
Run deploy-idnest-version again or use docker compose up --detach to re-enable
an intentionally stopped service.

## Deploy one component or roll back

Deploy only one application:

~~~bash
sudo deploy-idnest-version 0.1.2 auth
sudo deploy-idnest-version 0.1.2 admin
~~~

Rollback uses the same command with an older published version:

~~~bash
sudo deploy-idnest-version 0.1.1 all
~~~

If a new application container fails readiness, the script restores its
previous image automatically. Database migrations are forward-only and are not
reversed by an image rollback. Verify migration backward compatibility before
rolling back.

If /etc/idnest/pre-deploy-backup exists and is executable, the deployment
script invokes it before application migrations:

~~~text
/etc/idnest/pre-deploy-backup COMPONENT VERSION
~~~

## Updating host deployment assets

When tracked Compose files, scripts, or Kratos configuration change, upload a
trusted checkout again and rerun bootstrap before deploying the new version:

~~~bash
cd "$HOME/idnest-bootstrap"
sudo ./deploy/vps/bootstrap-idnest-host.sh
sudo deploy-idnest-version 0.1.2 all
~~~

Bootstrap does not overwrite /etc/idnest configuration or runtime secret files.

## Troubleshooting

Show stopped containers as well as running containers:

~~~bash
sudo docker ps --all
~~~

Inspect a failed application deployment:

~~~bash
sudo docker compose \
  --file /opt/idnest/auth/compose.yaml \
  --env-file /opt/idnest/auth/release.env \
  ps
sudo docker compose \
  --file /opt/idnest/auth/compose.yaml \
  --env-file /opt/idnest/auth/release.env \
  logs --tail 200 auth
~~~

Validate Compose configuration without starting containers:

~~~bash
sudo docker compose \
  --file /opt/idnest/auth/compose.yaml \
  --env-file /opt/idnest/auth/release.env \
  config --quiet
sudo docker compose \
  --file /opt/idnest/admin/compose.yaml \
  --env-file /opt/idnest/admin/release.env \
  config --quiet
~~~

Common causes of a failed first deployment are:

- the VPS is not ARM64;
- an incorrect ECR Public registry alias or repository name;
- missing root ownership or mode 0600 on /etc/idnest secret files;
- PostgreSQL DSNs that containers cannot reach;
- public health URLs not routed to the loopback origins;
- ports 8444 through 8447 already in use;
- an application hostname being used for SSH instead of a DNS-only SSH host.
