data "aws_caller_identity" "current" {}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0
  url   = "https://token.actions.githubusercontent.com"
  client_id_list = [
    "sts.amazonaws.com",
  ]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"

  lifecycle {
    postcondition {
      condition     = contains(self.client_id_list, "sts.amazonaws.com")
      error_message = "The existing GitHub OIDC provider must allow the sts.amazonaws.com audience."
    }
  }
}

resource "aws_ecrpublic_repository" "app" {
  for_each = var.ecr_repository_names

  repository_name = each.value

  catalog_data {
    architectures     = ["ARM 64"]
    operating_systems = ["Linux"]
    description       = "Idnest ${each.key} application image"
    about_text        = "Official ARM64 Linux container images for the open-source Idnest ${each.key} application."
    usage_text        = "Pull a versioned image with `docker pull ${each.value}:<tag>` after prefixing the repository with its public.ecr.aws registry URI."
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_ecrpublic_repository" "builder" {
  repository_name = var.builder_ecr_repository_name

  catalog_data {
    architectures     = ["ARM 64"]
    operating_systems = ["Linux"]
    description       = "Idnest reproducible dependency builder image"
    about_text        = "Dependency-only ARM64 Linux builder image used by the open-source Idnest CI pipeline. It contains no application source or runtime secrets."
    usage_text        = "This repository is consumed by the Idnest application image build pipeline and is pinned by digest."
  }

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  github_oidc_provider_arn = var.create_github_oidc_provider ? one(aws_iam_openid_connect_provider.github[*].arn) : one(data.aws_iam_openid_connect_provider.github[*].arn)
  github_repository_parts  = split("/", var.github_repository)
  github_oidc_subject_prefix = format(
    "repo:%s@%s/%s@%s",
    local.github_repository_parts[0],
    var.github_repository_owner_id,
    local.github_repository_parts[1],
    var.github_repository_id,
  )
  ecr_public_repository_arns = {
    for kind, repository in aws_ecrpublic_repository.app : kind => repository.arn
  }
  ecr_public_registry = trimsuffix(
    aws_ecrpublic_repository.app["auth"].repository_uri,
    "/${var.ecr_repository_names.auth}",
  )
  oidc_audience_key = "token.actions.githubusercontent.com:aud"
  oidc_subject_key  = "token.actions.githubusercontent.com:sub"
}

data "aws_iam_policy_document" "build_assume_role" {
  statement {
    sid     = "GitHubActionsEcrBuild"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = local.oidc_audience_key
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = local.oidc_subject_key
      values   = ["${local.github_oidc_subject_prefix}:environment:${var.build_environment_name}"]
    }
  }
}

resource "aws_iam_role" "build" {
  name                  = var.build_role_name
  description           = "GitHub Actions build/push role for Idnest application and builder images"
  assume_role_policy    = data.aws_iam_policy_document.build_assume_role.json
  max_session_duration  = 3600
  force_detach_policies = true
}

data "aws_iam_policy_document" "build_ecr" {
  statement {
    sid    = "GetEcrPublicAuthorizationToken"
    effect = "Allow"
    actions = [
      "ecr-public:GetAuthorizationToken",
      "sts:GetServiceBearerToken",
    ]
    resources = ["*"]
  }
  statement {
    sid    = "ManagePublicBuildImages"
    effect = "Allow"
    actions = [
      "ecr-public:BatchCheckLayerAvailability",
      "ecr-public:BatchDeleteImage",
      "ecr-public:CompleteLayerUpload",
      "ecr-public:DescribeImages",
      "ecr-public:InitiateLayerUpload",
      "ecr-public:PutImage",
      "ecr-public:UploadLayerPart",
    ]
    resources = concat(values(local.ecr_public_repository_arns), [aws_ecrpublic_repository.builder.arn])
  }
}

resource "aws_iam_role_policy" "build" {
  name   = "${var.build_role_name}-ecr"
  role   = aws_iam_role.build.id
  policy = data.aws_iam_policy_document.build_ecr.json
}

resource "aws_iam_role_policies_exclusive" "build" {
  role_name    = aws_iam_role.build.name
  policy_names = [aws_iam_role_policy.build.name]
}

resource "aws_iam_role_policy_attachments_exclusive" "build" {
  role_name   = aws_iam_role.build.name
  policy_arns = []
}
