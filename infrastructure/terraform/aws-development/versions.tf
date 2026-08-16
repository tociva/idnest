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
