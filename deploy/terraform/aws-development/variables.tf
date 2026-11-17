variable "aws_region" {
  type        = string
  description = "AWS region containing the temporarily retained legacy private ECR repositories."
  default     = "ap-south-1"
  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$", var.aws_region))
    error_message = "aws_region must be a valid AWS region name."
  }
}

variable "ecr_public_region" {
  type        = string
  description = "AWS control-plane region for Amazon ECR Public. AWS requires us-east-1."
  default     = "us-east-1"
  validation {
    condition     = var.ecr_public_region == "us-east-1"
    error_message = "ecr_public_region must be us-east-1 for Amazon ECR Public."
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

variable "github_repository_owner_id" {
  type        = string
  description = "Immutable numeric GitHub identifier for the repository owner."
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.github_repository_owner_id))
    error_message = "github_repository_owner_id must be a positive numeric GitHub owner ID."
  }
}

variable "github_repository_id" {
  type        = string
  description = "Immutable numeric GitHub identifier for the repository."
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.github_repository_id))
    error_message = "github_repository_id must be a positive numeric GitHub repository ID."
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

variable "ecr_repository_names" {
  type        = map(string)
  description = "ECR Public repository name for each application."
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

variable "builder_ecr_repository_name" {
  type        = string
  description = "ECR Public repository containing CI builder dependency images."
  default     = "idnest/builder-base"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._/-]*$", var.builder_ecr_repository_name))
    error_message = "builder_ecr_repository_name must be a valid ECR repository name."
  }
}

variable "build_role_name" {
  type        = string
  description = "GitHub Actions role that builds and pushes both images."
  default     = "idnest-development-build"
}

variable "create_github_oidc_provider" {
  type        = bool
  description = "Create the account-wide GitHub OIDC provider; false references an existing provider."
  default     = false
}

variable "retain_legacy_private_ecr_repositories" {
  type        = bool
  description = "Retain the Terraform-managed private ECR repositories during migration. Set false only after public images are verified and private images may be retired."
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
