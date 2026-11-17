# Idnest application image delivery

Idnest publishes public ARM64 application images for auth and admin. Legacy
Kubernetes and VPS deployment assets remain grouped here but are not part of
the current image-publication pipeline.

## Build and publish

`build-application-image.yml` accepts `auth`, `admin`, or `all` and an immutable
semantic version such as `1.4.0`. It validates the selected components, builds
the current `development` revision natively for `linux/arm64`, pushes Git/run
candidates to ECR Public, scans them with Trivy, and smoke-tests their digests.
Only after every selected image passes does it add the `auth-vX.Y.Z` and/or
`admin-vX.Y.Z` release tags.

The build uses the existing `ecr-build` GitHub Environment and its variables:

- `AWS_ACCOUNT_ID`
- `AWS_REGION`
- `ECR_PUBLIC_REGION`
- `ECR_PUBLIC_REGISTRY`
- `AWS_BUILD_ROLE_ARN`
- `AUTH_ECR_REPOSITORY`
- `ADMIN_ECR_REPOSITORY`
- `BUILDER_ECR_REPOSITORY`

Apply the development Terraform after an IAM or repository update so the build
role can publish and clean up candidates in the public repositories.

## Deploy or roll back

`deploy-application-version.yml` accepts an environment, component, and
published version. It resolves that tag to its immutable ECR digest and Git
revision, rechecks the scan, and deploys `repository@sha256:digest` with Helm.
Running it with an older version is the rollback procedure; Helm history is not
used to select an image.

The selected `development-auth`, `development-admin`, `production-auth`, or
`production-admin` GitHub Environment must provide:

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `AWS_ACCOUNT_ID` | ECR account |
| Variable | `AWS_REGION` | ECR region |
| Variable | `AWS_DEPLOY_ROLE_ARN` | Pull/scan deployment role |
| Variable | `ECR_REPOSITORY` | Component repository |
| Variable | `KUBE_NAMESPACE` | Existing target namespace |
| Variable | `APP_SECRET_NAME` | Existing component runtime Secret |
| Variable | `PUBLIC_HEALTH_URL` | Optional public `/health` URL |
| Secret | `KUBECONFIG_BASE64` | Restricted kubeconfig encoded as one base64 line |

For a Kubernetes API protected by Cloudflare Access, also configure:

| Kind | Name |
| --- | --- |
| Variable | `KUBERNETES_ACCESS_HOSTNAME` |
| Variable | `CLOUDFLARED_VERSION` |
| Variable | `CLOUDFLARED_LINUX_AMD64_SHA256` |
| Secret | `CLOUDFLARE_ACCESS_CLIENT_ID` |
| Secret | `CLOUDFLARE_ACCESS_CLIENT_SECRET` |

Leave `KUBERNETES_ACCESS_HOSTNAME` empty when the kubeconfig endpoint is
directly reachable from a GitHub-hosted runner. The kubeconfig identity must be
namespace restricted but able to manage Deployments, Services, Jobs, and
ServiceAccounts and read the named runtime Secret.

Set `ECR_IMAGE_PULL_SECRET` only on clusters that do not have an AWS/ECR
credential provider. The workflow refreshes that Docker registry Secret before
the Helm release. Because an ECR login token expires, a long-running non-EKS
cluster should use an ECR credential provider instead of depending on this
deployment-time refresh.

The protected development environment updater preserves these manually added
cluster variables and secrets; it does not generate them from the VPS source
file.

## Runtime Secrets

The chart does not create application credentials. Provision the Secrets before
the first deployment, with one key per environment variable:

```sh
kubectl create secret generic idnest-auth-secrets \
  --namespace idnest-development \
  --from-env-file=/absolute/protected/path/auth.env

kubectl create secret generic idnest-admin-secrets \
  --namespace idnest-development \
  --from-env-file=/absolute/protected/path/admin.env
```

The auth and admin environment files must use cluster-reachable Hydra, Kratos,
PostgreSQL, and authorization-database addresses. Never commit them.

The chart runs `migrations/authz-migrate.cjs` as a blocking pre-install or
pre-upgrade hook. Admin additionally runs the existing OAuth client provisioner
after a successful rollout. Database migrations are forward-only and are not
reversed when an older image is deployed.

## Commands

Publish an auth version:

```sh
gh workflow run build-application-image.yml \
  --repo tociva/idnest --ref development \
  -f component=auth -f version=1.4.0
```

Deploy it:

```sh
gh workflow run deploy-application-version.yml \
  --repo tociva/idnest --ref development \
  -f environment=development -f component=auth -f version=1.4.0 \
  -f confirm=DEPLOY -f reason='development release 1.4.0'
```

Roll back through the same workflow:

```sh
gh workflow run deploy-application-version.yml \
  --repo tociva/idnest --ref development \
  -f environment=development -f component=auth -f version=1.3.0 \
  -f confirm=DEPLOY -f reason='rollback after 1.4.0 regression'
```

Validate the chart locally:

```sh
deploy/ci/test-kubernetes-deployment-contracts.sh
```

