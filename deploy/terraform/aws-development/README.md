# AWS build infrastructure

This Terraform directory manages the resources required to build and publish
Idnest images:

- public ECR repositories for auth, admin, and the dependency builder;
- the GitHub OIDC build role and least-privilege public ECR policy;
- optionally, the account-wide GitHub OIDC provider.

It does not manage VPS targets, GitHub deployment environments, SSH values, or
deployment IAM roles. Public image pulls require no AWS identity on the VPS.

## Configure

```bash
aws sts get-caller-identity
gh auth status

gh api repos/tociva/idnest --jq '
  "github_repository          = \"\(.full_name)\"",
  "github_repository_owner_id = \"\(.owner.id)\"",
  "github_repository_id       = \"\(.id)\""
'

cp deploy/terraform/aws-development/terraform.tfvars.example \
  deploy/terraform/aws-development/terraform.tfvars
```

The checked-in example contains the complete input shape. Verify the immutable
GitHub owner/repository IDs before applying. `create_github_oidc_provider=false`
reuses the account-wide provider that already exists.

The configuration is ECR Public-only. It contains no private ECR repository,
lifecycle-policy, regional ECR, or force-delete settings.

## Plan and apply

Back up the current state before the first simplification plan. Then run:

```bash
terraform -chdir=deploy/terraform/aws-development init
terraform -chdir=deploy/terraform/aws-development fmt
terraform -chdir=deploy/terraform/aws-development validate
terraform -chdir=deploy/terraform/aws-development plan \
  -out=idnest-build-only.tfplan
terraform -chdir=deploy/terraform/aws-development show idnest-build-only.tfplan
```

The first plan after this change should create or retain the public ECR
repositories, retain the build role and GitHub OIDC provider, and delete only
the obsolete auth/admin deployment IAM roles and their policies. It should
recognize the private ECR resources as already deleted and must not recreate
them. Apply only after that is confirmed:

```bash
terraform -chdir=deploy/terraform/aws-development apply idnest-build-only.tfplan
./deploy/tools/sync-ecr-build-github.sh
./deploy/tools/sync-development-ecr-values.sh
```

The second sync command updates only `ECR_PUBLIC_REGISTRY`,
`AUTH_ECR_REPOSITORY`, and `ADMIN_ECR_REPOSITORY` in
`tmp/development.env`. It preserves the operator-controlled
`SKIP_PUBLIC_HEALTH_CHECK` value and all application secrets. Create the local
source first with `./deploy/tools/create-development-env.sh` when it does not
yet exist.

The sync updates these variables only in the `ecr-build` GitHub Environment:

```text
AWS_ACCOUNT_ID
AWS_BUILD_ROLE_ARN
ECR_PUBLIC_REGION
ECR_PUBLIC_REGISTRY
AUTH_ECR_REPOSITORY
ADMIN_ECR_REPOSITORY
BUILDER_ECR_REPOSITORY
```

Deleting the old GitHub deployment environments is an independent manual
cleanup and is not performed by Terraform or the sync script.
