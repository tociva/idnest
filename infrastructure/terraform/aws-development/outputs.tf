output "aws_account_id" {
  value       = data.aws_caller_identity.current.account_id
  description = "AWS account ID used by all GitHub deployment environments."
}

output "aws_region" {
  value       = var.aws_region
  description = "AWS region used by all GitHub deployment environments."
}

output "aws_build_role_arn" {
  value       = aws_iam_role.build.arn
  description = "AWS_BUILD_ROLE_ARN for ecr-build."
}

output "aws_deploy_role_arns" {
  value       = { for kind, role in aws_iam_role.deploy : kind => role.arn }
  description = "Pull-only development deployment role ARN for auth and admin."
}

output "aws_production_deploy_role_arns" {
  value       = { for kind, role in aws_iam_role.production_deploy : kind => role.arn }
  description = "Pull-only production deployment role ARN for auth and admin."
}

output "ecr_repositories" {
  value       = var.ecr_repository_names
  description = "ECR repository names consumed by the workflows."
}

output "github_environment_variables" {
  description = "Complete non-secret values for bulk configuration of all five GitHub environments."
  value = {
    "ecr-build" = {
      AWS_ACCOUNT_ID       = data.aws_caller_identity.current.account_id
      AWS_REGION           = var.aws_region
      AWS_BUILD_ROLE_ARN   = aws_iam_role.build.arn
      AUTH_ECR_REPOSITORY  = var.ecr_repository_names.auth
      ADMIN_ECR_REPOSITORY = var.ecr_repository_names.admin
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
    "production-auth" = {
      AWS_ACCOUNT_ID      = data.aws_caller_identity.current.account_id
      AWS_REGION          = var.aws_region
      AWS_DEPLOY_ROLE_ARN = aws_iam_role.production_deploy["auth"].arn
      ECR_REPOSITORY      = var.ecr_repository_names.auth
      VPS_HOST            = var.github_deployment_targets["production-auth"].vps_host
      VPS_PORT            = tostring(var.github_deployment_targets["production-auth"].vps_port)
      VPS_USER            = var.github_deployment_targets["production-auth"].vps_user
    }
    "production-admin" = {
      AWS_ACCOUNT_ID      = data.aws_caller_identity.current.account_id
      AWS_REGION          = var.aws_region
      AWS_DEPLOY_ROLE_ARN = aws_iam_role.production_deploy["admin"].arn
      ECR_REPOSITORY      = var.ecr_repository_names.admin
      VPS_HOST            = var.github_deployment_targets["production-admin"].vps_host
      VPS_PORT            = tostring(var.github_deployment_targets["production-admin"].vps_port)
      VPS_USER            = var.github_deployment_targets["production-admin"].vps_user
    }
  }
}
