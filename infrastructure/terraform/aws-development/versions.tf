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
      Application = "ory-auth-apps"
      Environment = "shared-deployment"
      ManagedBy   = "terraform"
    }, var.tags)
  }
}
