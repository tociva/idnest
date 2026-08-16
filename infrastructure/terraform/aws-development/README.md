# AWS and GitHub deployment bootstrap

This state-compatible Terraform stack provisions the AWS resources used by
both development and production deployments:

- two immutable, encrypted, scan-on-push ECR repositories;
- the account-wide GitHub Actions OIDC provider, or a reference to an existing
  provider;
- one `ecr-build` role that can push both application images;
- separate pull-only roles for `development-auth`, `development-admin`,
  `production-auth`, and `production-admin`.

No IAM user or long-lived AWS access key is created. Trust policies require the
exact `tociva/ory-auth-apps` GitHub environment subject. Production consumes the
same immutable ECR digests tested by development.

## 1. Prerequisites

Install Terraform, AWS CLI, `jq`, GitHub CLI, and OpenSSL. Authenticate AWS with
an administrator role that can manage ECR, IAM roles/policies, and the GitHub
OIDC provider.

```sh
terraform version
aws --version
jq --version
gh --version
openssl version
aws sts get-caller-identity
gh auth status
```

Use an encrypted remote backend for shared operation. Terraform state and saved
plans can contain infrastructure metadata and must not be committed.

## 2. Configure inputs

```sh
cp infrastructure/terraform/aws-development/terraform.tfvars.example \
  infrastructure/terraform/aws-development/terraform.tfvars
${EDITOR:-vi} infrastructure/terraform/aws-development/terraform.tfvars
```

Replace all `.example.com` VPS hosts. Auth and admin can share a VPS, but every
GitHub environment is explicit so the services can be separated later.

If this AWS account already has the GitHub Actions OIDC provider, keep:

```hcl
create_github_oidc_provider = false
```

Set it to `true` only when this stack should create the account-wide provider.
Likewise, set `create_ecr_repositories=false` when the repositories already
exist as data sources rather than Terraform-managed resources.

## 3. Initialize, validate, plan, and apply

```sh
terraform -chdir=infrastructure/terraform/aws-development init
terraform -chdir=infrastructure/terraform/aws-development fmt -check
terraform -chdir=infrastructure/terraform/aws-development validate
terraform -chdir=infrastructure/terraform/aws-development plan \
  -out=ory-auth-deployment.tfplan
terraform -chdir=infrastructure/terraform/aws-development apply \
  ory-auth-deployment.tfplan
terraform -chdir=infrastructure/terraform/aws-development output \
  github_environment_variables
```

Review the plan carefully. Creating the two production roles should be additive;
the existing development role and ECR addresses are intentionally unchanged.

## 4. Render bulk GitHub variable files

From the repository root:

```sh
install -d -m 700 tmp/github-environments
scripts/deploy/render-github-environment-vars.sh \
  infrastructure/terraform/aws-development \
  tmp/github-environments
```

This creates mode-`0600` files accepted directly by `gh variable set`:

```text
tmp/github-environments/ecr-build.vars.env
tmp/github-environments/development-auth.vars.env
tmp/github-environments/development-admin.vars.env
tmp/github-environments/production-auth.vars.env
tmp/github-environments/production-admin.vars.env
```

The renderer rejects incomplete Terraform output and placeholder VPS hosts.
These files contain non-secret AWS/VPS metadata only and are ignored by Git.

## 5. Existing-resource imports

Import a resource only when Terraform is configured to manage it. Do not import
the OIDC provider when `create_github_oidc_provider=false`, and do not import ECR
repositories when `create_ecr_repositories=false`.

```sh
terraform -chdir=infrastructure/terraform/aws-development import \
  'aws_ecr_repository.app["auth"]' idnest/auth-app
terraform -chdir=infrastructure/terraform/aws-development import \
  'aws_ecr_repository.app["admin"]' idnest/admin-app
terraform -chdir=infrastructure/terraform/aws-development import \
  aws_iam_role.build ory-auth-development-build
terraform -chdir=infrastructure/terraform/aws-development import \
  'aws_iam_role.deploy["auth"]' ory-auth-development-deploy
terraform -chdir=infrastructure/terraform/aws-development import \
  'aws_iam_role.deploy["admin"]' ory-admin-development-deploy
terraform -chdir=infrastructure/terraform/aws-development import \
  'aws_iam_role.production_deploy["auth"]' ory-auth-production-deploy
terraform -chdir=infrastructure/terraform/aws-development import \
  'aws_iam_role.production_deploy["admin"]' ory-admin-production-deploy
```

The exclusive IAM policy resources intentionally remove inline or attached
policies not declared by this stack. Audit imported roles before applying.

By default Terraform cannot delete non-empty repositories. Keep
`force_delete_ecr_repositories=false` except during deliberate decommissioning.
Do not destroy an account-wide OIDC provider while another repository uses it.
