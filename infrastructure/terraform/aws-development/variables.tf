variable "aws_region" {
  type        = string
  description = "AWS region for the application ECR repositories."
  default     = "ap-south-1"
  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$", var.aws_region))
    error_message = "aws_region must be a valid AWS region name."
  }
}

variable "github_repository" {
  type        = string
  description = "GitHub repository in owner/name form."
  default     = "tociva/idnest"
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must use owner/name form."
  }
}

variable "build_environment_name" {
  type        = string
  description = "Protected GitHub environment used to build and push both images."
  default     = "ecr-build"
  validation {
    condition     = var.build_environment_name == "ecr-build"
    error_message = "build_environment_name must match the ecr-build environment used by the workflows."
  }
}

variable "deploy_environment_names" {
  type        = map(string)
  description = "Protected development GitHub deployment environment for each application."
  default = {
    auth  = "development-auth"
    admin = "development-admin"
  }
  validation {
    condition = (
      length(var.deploy_environment_names) == 2 &&
      lookup(var.deploy_environment_names, "auth", "") == "development-auth" &&
      lookup(var.deploy_environment_names, "admin", "") == "development-admin"
    )
    error_message = "deploy_environment_names must match the development-auth and development-admin workflow environments."
  }
}

variable "ecr_repository_names" {
  type        = map(string)
  description = "Private ECR repository name for each application."
  default = {
    auth  = "idnest/auth-app"
    admin = "idnest/admin-app"
  }
  validation {
    condition = (
      length(var.ecr_repository_names) == 2 &&
      alltrue([for key in ["auth", "admin"] : contains(keys(var.ecr_repository_names), key)]) &&
      alltrue([for name in values(var.ecr_repository_names) : can(regex("^[a-z0-9][a-z0-9._/-]*$", name))])
    )
    error_message = "ecr_repository_names must define valid auth and admin repositories."
  }
}

variable "build_role_name" {
  type        = string
  description = "GitHub Actions role that builds and pushes both images."
  default     = "idnest-development-build"
}

variable "deploy_role_names" {
  type        = map(string)
  description = "Pull-only development GitHub Actions deployment role for each application."
  default = {
    auth  = "idnest-auth-development-deploy"
    admin = "idnest-admin-development-deploy"
  }
  validation {
    condition = (
      length(var.deploy_role_names) == 2 &&
      alltrue([for key in ["auth", "admin"] : contains(keys(var.deploy_role_names), key)])
    )
    error_message = "deploy_role_names must define exactly auth and admin."
  }
}

variable "github_deployment_targets" {
  type = map(object({
    vps_host = string
    vps_port = number
    vps_user = string
  }))
  description = "Non-secret VPS connection variables emitted for the development GitHub deployment environments."

  validation {
    condition = length(var.github_deployment_targets) == 3 && alltrue([
      for key in ["development-auth", "development-admin", "development-identity"] :
      contains(keys(var.github_deployment_targets), key)
    ])
    error_message = "github_deployment_targets must define exactly development-auth, development-admin, and development-identity."
  }
  validation {
    condition = alltrue([
      for target in values(var.github_deployment_targets) :
      can(regex("^[A-Za-z0-9.-]+$", target.vps_host)) &&
      !can(regex("(^replace-|\\.example\\.com$)", lower(target.vps_host))) &&
      target.vps_port >= 1 && target.vps_port <= 65535 && floor(target.vps_port) == target.vps_port &&
      can(regex("^[A-Za-z_][A-Za-z0-9._-]*$", target.vps_user))
    ])
    error_message = "Every deployment target must have a valid host, TCP port, and deployment user."
  }
}

variable "create_github_oidc_provider" {
  type        = bool
  description = "Create the account-wide GitHub OIDC provider; false references an existing provider."
  default     = false
}

variable "create_ecr_repositories" {
  type        = bool
  description = "Create both ECR repositories; false references existing repositories."
  default     = true
}

variable "force_delete_ecr_repositories" {
  type        = bool
  description = "Permit repository destruction with images. Keep false except deliberate decommissioning."
  default     = false
}

variable "tags" {
  type        = map(string)
  description = "Additional tags for Terraform-managed resources."
  default     = {}
}
