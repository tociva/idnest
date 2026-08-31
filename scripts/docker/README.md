# Docker and Images

This guide covers the local Hydra/Kratos Docker stack, Kratos configuration
refreshes, CORS integration checks, and the shared ARM64 dependency builder
image used by development deployments.

## Local Hydra and Kratos

Manage the local Hydra and Kratos services directly when needed:

```bash
docker compose -f scripts/docker/docker-compose.yml up -d
docker compose -f scripts/docker/docker-compose.yml ps
docker compose -f scripts/docker/docker-compose.yml logs -f
docker compose -f scripts/docker/docker-compose.yml down
```

After changing `.env` or `config/kratos.tpl.yml`, recreate Kratos so the
generated configuration is refreshed:

```bash
docker compose -f scripts/docker/docker-compose.yml up -d --force-recreate kratos
```

## ARM64 dependency builder image

The auth and admin image builds share a private dependency image in
`idnest/builder-base`. It contains Node, Corepack, pnpm, and the frozen workspace
dependency tree, but no application source, build output, environment file, or
runtime secret. The Node 22.22.0 image is pinned by its Docker manifest digest,
which includes the required Linux ARM64 variant. The builder is a build input
only and is never deployed to the VPS.

The development VPS reports `aarch64`, so application and builder jobs run on
GitHub's native `ubuntu-24.04-arm` runner and publish only `linux/arm64`. QEMU and
the unused AMD64 application build are intentionally absent. Validation still
runs independently before the protected build job; the release compilation
runs exactly once inside the ARM64 application-image build.

### Provisioning and GitHub variables

Terraform creates the separate immutable ECR repository, enables scan-on-push,
and applies a lifecycle policy that removes untagged images after seven days and
retains the latest twenty tagged dependency images. Only the `ecr-build` role
can push or pull builder images; application deployment roles remain limited to
their respective runtime repositories.

After applying a reviewed Terraform plan, synchronize the repository name
through the existing protected bulk-update path:

```bash
terraform -chdir=infrastructure/terraform/aws-development plan \
  -out=idnest-builder.tfplan
terraform -chdir=infrastructure/terraform/aws-development apply \
  idnest-builder.tfplan

./scripts/deploy/update-development-env-from-terraform.sh
./scripts/deploy/update-development-github-environments.sh
```

This adds the non-secret `BUILDER_ECR_REPOSITORY` variable only to the protected
`ecr-build` GitHub Environment. Do not maintain it manually in GitHub.

### Image identity and rebuilds

`scripts/docker/builder-image-key.sh` hashes the builder Dockerfile, its hashing
schema, target platform, pnpm lockfile, workspace configuration, root manifest,
and every workspace package manifest. Images use the immutable tag
`deps-<sha256>`. Source-only changes reuse the existing image; dependency,
toolchain, or builder-definition changes produce a new tag.

The `build-builder-base-development.yml` workflow runs automatically on the
`development` branch when any builder input changes. It can also be run
manually:

```bash
gh workflow run build-builder-base-development.yml \
  --repo tociva/idnest --ref development
gh run watch --repo tociva/idnest --exit-status
```

The workflow uses short-lived GitHub OIDC credentials, checks ECR before
building, builds only on a miss, publishes SBOM and maximum provenance
attestations, resolves the immutable digest, and verifies Node, pnpm,
`node_modules`, and the ARM64 architecture. Auth and admin call the same ensure
helper as a fallback, preventing a deployment race when a new dependency image
has not completed yet.

Inspect the published images without printing credentials:

```bash
aws ecr describe-images \
  --region ap-south-1 \
  --repository-name idnest/builder-base \
  --query 'reverse(sort_by(imageDetails,& imagePushedAt))[:5].[imageTags[0],imageDigest,imagePushedAt]' \
  --output table
```

The application Dockerfiles receive the builder by `repository@sha256:digest`,
copy the tracked source over its dependency workspace, compile once, and copy
only the bundled server, browser assets, and migration bundle into the existing
slim non-root runtime image.

### Troubleshooting and rollback

If the builder workflow reports a missing repository or variable, apply the
Terraform changes and rerun both environment synchronization commands. If a
builder push loses an immutable-tag race, the ensure helper re-queries ECR and
uses the successfully published digest. A genuine build failure remains fatal.

Changing only application source must not change the output of:

```bash
./scripts/docker/builder-image-key.sh
```

Changing `pnpm-lock.yaml`, a package manifest, or the builder Dockerfile must
change it. Run `./scripts/docker/test-builder-contract.sh` to verify these key,
Dockerfile, runner, and target-platform invariants together. Existing
auth/admin images are self-contained and do not depend on a
builder image after publication. Rollback therefore continues to select the
previous application digest; deleting or rebuilding a builder image does not
alter an already published runtime image.
