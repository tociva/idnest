# AWS Development Terraform

This guide covers the AWS development infrastructure used by the GitHub Actions
image build and publication flow.

## Provision AWS with Terraform

Install Terraform, AWS CLI, GitHub CLI, `jq`, OpenSSL, and OpenSSH on a trusted
workstation. Authenticate AWS with permission to manage ECR Public, IAM roles and
policies, and the account-wide GitHub OIDC provider.

```bash
aws sts get-caller-identity
gh auth status

gh api repos/tociva/idnest --jq '
  "github_repository          = \"\(.full_name)\"",
  "github_repository_owner_id = \"\(.owner.id)\"",
  "github_repository_id       = \"\(.id)\""
'

cp infrastructure/terraform/aws-development/terraform.tfvars.example \
  infrastructure/terraform/aws-development/terraform.tfvars
```

Open `infrastructure/terraform/aws-development/terraform.tfvars` with any
editor. The checked-in example contains the complete development configuration:

```hcl
aws_region                 = "ap-south-1"
ecr_public_region          = "us-east-1"
github_repository          = "tociva/idnest"
github_repository_owner_id = "217876362"
github_repository_id       = "1016627095"

build_environment_name = "ecr-build"
deploy_environment_names = {
  auth  = "development-auth"
  admin = "development-admin"
}

ecr_repository_names = {
  auth  = "idnest/auth-app"
  admin = "idnest/admin-app"
}
builder_ecr_repository_name = "idnest/builder-base"

build_role_name = "idnest-development-build"
deploy_role_names = {
  auth  = "idnest-auth-development-deploy"
  admin = "idnest-admin-development-deploy"
}

create_github_oidc_provider   = false
retain_legacy_private_ecr_repositories = true
force_delete_ecr_repositories          = false

github_deployment_targets = {
  development-auth = {
    vps_host = "vps-dev.idnest.cloud"
    vps_port = 22
    vps_user = "idnest-deploy"
  }
  development-admin = {
    vps_host = "vps-dev.idnest.cloud"
    vps_port = 22
    vps_user = "idnest-deploy"
  }
  development-identity = {
    vps_host = "vps-dev.idnest.cloud"
    vps_port = 22
    vps_user = "idnest-deploy"
  }
}

tags = {
  Project = "idnest"
}
```

Terraform also applies the provider-level tags `Application=idnest`,
`Environment=development`, and `ManagedBy=terraform` to supported AWS
resources. Values in `tags` are merged with those defaults.

Terraform creates three public repositories in the account's ECR Public
registry: `idnest/auth-app`, `idnest/admin-app`, and `idnest/builder-base`.
ECR Public's control plane is fixed to `us-east-1`, independently of the
application region. The build role can push, describe, promote, and remove
images in only these public repositories. Public pulls require no AWS role.

ECR Public does not provide private ECR's repository immutability, lifecycle,
or scan-on-push controls. The workflows therefore reject an existing semantic
version before publication, remove temporary candidate tags, and run Trivy
against each candidate before creating its release tag.

These defaults reuse the account's existing GitHub OIDC provider. AWS permits only one provider for
`https://token.actions.githubusercontent.com` in an account, so it is shared
with other projects. Set `create_github_oidc_provider=true` only in a new AWS
account where that provider does not exist.

`retain_legacy_private_ecr_repositories=true` deliberately keeps the existing
private repositories during the migration, so applying this change does not
delete previously published images. After the public images and VPS pulls are
verified, those repositories can be retired in a separate reviewed plan by
setting the value to `false`. Keep `force_delete_ecr_repositories=false` unless
their remaining images have been deliberately removed first.

Idnest remains isolated through its own `idnest-*` IAM roles and ECR Public
repositories. Each role's trust policy also restricts tokens to the immutable
`tociva@217876362/idnest@1016627095` repository identity and the exact GitHub
environment used by that role. Verify the immutable repository values before
applying with the `gh api repos/tociva/idnest` command above, using the logged-in
GitHub CLI session.

`vps-dev.idnest.cloud` is the direct SSH endpoint and is not routed through
Cloudflare. Auth, admin, and identity share this VPS but remain separate GitHub
deployment environments. `development-identity` receives only the VPS values;
it needs no AWS role because Hydra and Kratos use public upstream images.
`vps_user` is intentionally `idnest-deploy`: Terraform records it in the
validated output, and the development deployment guide synchronizes it through
`tmp/development.env` to GitHub Actions, which must not connect as `root`.

This Terraform directory manages development only. Production will use a
separate Terraform directory, state, IAM roles, and GitHub environments. Only
`development-auth`, `development-admin`, and `development-identity` are valid
deployment targets here.

For a shared environment, configure the Terraform directory to use an encrypted
remote backend before initialization. After saving `terraform.tfvars`, run:

```bash
terraform -chdir=infrastructure/terraform/aws-development init
terraform -chdir=infrastructure/terraform/aws-development fmt
terraform -chdir=infrastructure/terraform/aws-development validate
terraform -chdir=infrastructure/terraform/aws-development plan \
  -out=idnest-deployment.tfplan
terraform -chdir=infrastructure/terraform/aws-development apply \
  idnest-deployment.tfplan
terraform -chdir=infrastructure/terraform/aws-development output \
  github_environment_variables

./scripts/deploy/update-development-env-from-terraform.sh
./scripts/deploy/update-development-github-environments.sh
```

Run the output and synchronization commands only after a successful apply.
Terraform derives `ECR_PUBLIC_REGISTRY` from the AWS-assigned public registry
alias, then the sync scripts replace the temporary marker in
`tmp/development.env` and update the protected `ecr-build` GitHub Environment.
