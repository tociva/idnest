output "aws_account_id" {
  value       = data.aws_caller_identity.current.account_id
  description = "AWS account ID used by the development GitHub environments."
}

output "aws_region" {
  value       = var.aws_region
  description = "AWS region used by the development GitHub environments."
}

output "aws_build_role_arn" {
  value       = aws_iam_role.build.arn
  description = "AWS_BUILD_ROLE_ARN for ecr-build."
}

output "aws_deploy_role_arns" {
  value       = { for kind, role in aws_iam_role.deploy : kind => role.arn }
  description = "Pull-only development deployment role ARN for auth and admin."
}

output "ecr_repositories" {
  value       = var.ecr_repository_names
  description = "ECR Public repository names consumed by the workflows."
}

output "ecr_public_region" {
  value       = var.ecr_public_region
  description = "Amazon ECR Public control-plane region."
}

output "ecr_public_registry" {
  value       = local.ecr_public_registry
  description = "ECR Public registry URI including the AWS-assigned registry alias."
}

output "ecr_public_repository_urls" {
  value = merge(
    { for kind, repository in aws_ecrpublic_repository.app : kind => repository.repository_uri },
    { builder = aws_ecrpublic_repository.builder.repository_uri },
  )
  description = "Complete ECR Public repository URIs for application and builder images."
}

output "builder_ecr_repository_name" {
  value       = var.builder_ecr_repository_name
  description = "ECR Public repository name for the dependency builder image."
}

output "builder_ecr_repository_arn" {
  value       = aws_ecrpublic_repository.builder.arn
  description = "ECR Public repository ARN for the dependency builder image."
}

output "builder_ecr_repository_url" {
  value       = aws_ecrpublic_repository.builder.repository_uri
  description = "ECR Public repository URL for the dependency builder image."
}

output "github_environment_variables" {
  description = "Complete non-secret infrastructure values for the four development GitHub environments."
  value = {
    "ecr-build" = {
      AWS_ACCOUNT_ID         = data.aws_caller_identity.current.account_id
      AWS_REGION             = var.aws_region
      ECR_PUBLIC_REGION      = var.ecr_public_region
      ECR_PUBLIC_REGISTRY    = local.ecr_public_registry
      AWS_BUILD_ROLE_ARN     = aws_iam_role.build.arn
      AUTH_ECR_REPOSITORY    = var.ecr_repository_names.auth
      ADMIN_ECR_REPOSITORY   = var.ecr_repository_names.admin
      BUILDER_ECR_REPOSITORY = var.builder_ecr_repository_name
    }
    "development-auth" = {
      AWS_ACCOUNT_ID      = data.aws_caller_identity.current.account_id
      AWS_REGION          = var.aws_region
      AWS_DEPLOY_ROLE_ARN = aws_iam_role.deploy["auth"].arn
      ECR_REPOSITORY      = var.ecr_repository_names.auth
      VPS_HOST            = var.github_deployment_targets["development-auth"].vps_host
      VPS_PORT            = tostring(var.github_deployment_targets["development-auth"].vps_port)
      VPS_USER            = var.github_deployment_targets["development-auth"].vps_user
    }
    "development-admin" = {
      AWS_ACCOUNT_ID      = data.aws_caller_identity.current.account_id
      AWS_REGION          = var.aws_region
      AWS_DEPLOY_ROLE_ARN = aws_iam_role.deploy["admin"].arn
      ECR_REPOSITORY      = var.ecr_repository_names.admin
      VPS_HOST            = var.github_deployment_targets["development-admin"].vps_host
      VPS_PORT            = tostring(var.github_deployment_targets["development-admin"].vps_port)
      VPS_USER            = var.github_deployment_targets["development-admin"].vps_user
    }
    "development-identity" = {
      VPS_HOST = var.github_deployment_targets["development-identity"].vps_host
      VPS_PORT = tostring(var.github_deployment_targets["development-identity"].vps_port)
      VPS_USER = var.github_deployment_targets["development-identity"].vps_user
    }
  }
}
