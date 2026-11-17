# Image delivery

Idnest has two delivery stages:

1. GitHub Actions builds, scans, smoke-tests, and publishes public ARM64 images.
2. An operator runs a local script on the VPS to deploy a published version.

There is no cluster deployment workflow, GitHub-to-VPS SSH path, signed release
queue, or Kubernetes chart in this repository.

## Build and publish

`.github/workflows/build-application-image.yml` accepts:

- `component`: `auth`, `admin`, or `all`
- `version`: an immutable semantic version such as `1.4.0`

For `all`, auth and admin are built in parallel and neither final version tag is
published unless both candidates pass. Published tags are `auth-v1.4.0` and
`admin-v1.4.0`. Images contain the matching backend and frontend together.

The workflows use only the `ecr-build` GitHub Environment:

- `AWS_ACCOUNT_ID`
- `AWS_BUILD_ROLE_ARN`
- `ECR_PUBLIC_REGION`
- `ECR_PUBLIC_REGISTRY`
- `AUTH_ECR_REPOSITORY`
- `ADMIN_ECR_REPOSITORY`
- `BUILDER_ECR_REPOSITORY`

After applying a reviewed Terraform plan, synchronize those non-secret values:

```bash
./deploy/tools/sync-ecr-build-github.sh
```

## VPS deployment and rollback

The VPS pulls public ECR images anonymously. After the one-time host bootstrap
and runtime environment setup, deploy both applications with:

```bash
sudo deploy-idnest-version 1.4.0 all
```

Deploy only one component by passing `auth` or `admin`. Rollback uses the same
command with an older published version:

```bash
sudo deploy-idnest-version 1.3.0 all
```

The script resolves each tag to an immutable digest before starting it, runs
identity and authorization migrations, provisions the admin OAuth client when
needed, checks container/loopback/public health, and records the deployed
digests under `/var/lib/idnest`. If an application fails readiness, its prior
image is restored. Database migrations are forward-only and are not reversed by
an image rollback.

See [vps/README.md](vps/README.md) for host setup and [OPERATIONS.md](OPERATIONS.md)
for the end-to-end operator checklist.
