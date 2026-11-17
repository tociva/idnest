terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.17.0, < 7.0.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge({
      Application = "idnest"
      Environment = "development"
      ManagedBy   = "terraform"
    }, var.tags)
  }
}

# Amazon ECR Public's control plane is available only in us-east-1. The
# application region remains independent so the existing regional resources
# do not move when the public registry is introduced.
provider "aws" {
  alias  = "ecr_public"
  region = var.ecr_public_region

  default_tags {
    tags = merge({
      Application = "idnest"
      Environment = "development"
      ManagedBy   = "terraform"
    }, var.tags)
  }
}
