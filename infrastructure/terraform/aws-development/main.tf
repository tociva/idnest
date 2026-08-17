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

resource "aws_ecr_repository" "app" {
  for_each = var.create_ecr_repositories ? var.ecr_repository_names : {}

  name                 = each.value
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.force_delete_ecr_repositories

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }
}

data "aws_ecr_repository" "app" {
  for_each = var.create_ecr_repositories ? {} : var.ecr_repository_names
  name     = each.value
}

locals {
  github_oidc_provider_arn = var.create_github_oidc_provider ? one(aws_iam_openid_connect_provider.github[*].arn) : one(data.aws_iam_openid_connect_provider.github[*].arn)
  ecr_repository_arns = {
    for kind in keys(var.ecr_repository_names) : kind => (
      var.create_ecr_repositories ? aws_ecr_repository.app[kind].arn : data.aws_ecr_repository.app[kind].arn
    )
  }
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
      values   = ["repo:${var.github_repository}:environment:${var.build_environment_name}"]
    }
  }
}

data "aws_iam_policy_document" "deploy_assume_role" {
  for_each = var.deploy_environment_names
  statement {
    sid     = "GitHubActionsDevelopmentDeploy"
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
      values   = ["repo:${var.github_repository}:environment:${each.value}"]
    }
  }
}

resource "aws_iam_role" "build" {
  name                  = var.build_role_name
  description           = "GitHub Actions build/push role for Idnest auth and admin images"
  assume_role_policy    = data.aws_iam_policy_document.build_assume_role.json
  max_session_duration  = 3600
  force_detach_policies = true
}

resource "aws_iam_role" "deploy" {
  for_each = var.deploy_role_names

  name                  = each.value
  description           = "GitHub Actions pull-only ${each.key} deployment role"
  assume_role_policy    = data.aws_iam_policy_document.deploy_assume_role[each.key].json
  max_session_duration  = 3600
  force_detach_policies = true
}

data "aws_iam_policy_document" "build_ecr" {
  statement {
    sid       = "GetEcrAuthorizationToken"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid    = "PushAndPullApplicationImages"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = values(local.ecr_repository_arns)
  }
}

data "aws_iam_policy_document" "deploy_ecr" {
  for_each = local.ecr_repository_arns
  statement {
    sid       = "GetEcrAuthorizationToken"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid    = "PullApplicationImage"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [each.value]
  }
}

resource "aws_iam_role_policy" "build" {
  name   = "${var.build_role_name}-ecr"
  role   = aws_iam_role.build.id
  policy = data.aws_iam_policy_document.build_ecr.json
}

resource "aws_iam_role_policy" "deploy" {
  for_each = aws_iam_role.deploy
  name     = "${each.value.name}-ecr"
  role     = each.value.id
  policy   = data.aws_iam_policy_document.deploy_ecr[each.key].json
}

resource "aws_iam_role_policies_exclusive" "build" {
  role_name    = aws_iam_role.build.name
  policy_names = [aws_iam_role_policy.build.name]
}

resource "aws_iam_role_policies_exclusive" "deploy" {
  for_each     = aws_iam_role.deploy
  role_name    = each.value.name
  policy_names = [aws_iam_role_policy.deploy[each.key].name]
}

resource "aws_iam_role_policy_attachments_exclusive" "build" {
  role_name   = aws_iam_role.build.name
  policy_arns = []
}

resource "aws_iam_role_policy_attachments_exclusive" "deploy" {
  for_each    = aws_iam_role.deploy
  role_name   = each.value.name
  policy_arns = []
}
