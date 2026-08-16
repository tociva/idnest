#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 OWNER/REPOSITORY PREPARED_DIRECTORY" >&2
  exit 2
fi

repository="$1"
prepared_directory="$2"
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "Repository must use owner/name form." >&2
  exit 1
}
[ -d "$prepared_directory" ] && [ ! -L "$prepared_directory" ] || {
  echo "Prepared directory must be a regular directory." >&2
  exit 1
}
for command in awk gh openssl stat uname; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Missing required command: $command" >&2
    exit 1
  }
done
gh auth status >/dev/null

file_mode() {
  if [ "$(uname -s)" = Darwin ]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

validate_env_contract() {
  file=$1
  expected_keys=$2
  reject_placeholders=$3
  awk -v expected="$expected_keys" -v reject_placeholders="$reject_placeholders" -v source="$file" '
    BEGIN {
      count = split(expected, expected_list, " ")
      for (idx = 1; idx <= count; idx++) required[expected_list[idx]] = 1
    }
    {
      sub(/\r$/, "")
      separator = index($0, "=")
      if (separator == 0) {
        printf "Invalid dotenv line %d in %s\n", NR, source > "/dev/stderr"
        failed = 1
        exit 1
      }
      key = substr($0, 1, separator - 1)
      value = substr($0, separator + 1)
      if (key !~ /^[A-Z][A-Z0-9_]*$/ || !(key in required)) {
        printf "Unexpected key on line %d in %s\n", NR, source > "/dev/stderr"
        failed = 1
        exit 1
      }
      if (seen[key]++) {
        printf "Duplicate key %s in %s\n", key, source > "/dev/stderr"
        failed = 1
        exit 1
      }
      if (length(value) == 0) {
        printf "Empty value for %s in %s\n", key, source > "/dev/stderr"
        failed = 1
        exit 1
      }
      if (reject_placeholders == "true" && (value ~ /replace-with/ || value ~ /\.example\.com$/)) {
        printf "Placeholder value for %s in %s\n", key, source > "/dev/stderr"
        failed = 1
        exit 1
      }
      malformed = 0
      if (key == "AWS_ACCOUNT_ID" && (length(value) != 12 || value !~ /^[0-9]+$/)) malformed = 1
      if (key == "AWS_REGION" && value !~ /^[a-z][a-z](-gov)?-[a-z]+-[0-9]+$/) malformed = 1
      if ((key == "AWS_BUILD_ROLE_ARN" || key == "AWS_DEPLOY_ROLE_ARN") && value !~ /^arn:aws:iam::[0-9]+:role\/[A-Za-z0-9+=,.@_\/-]+$/) malformed = 1
      if ((key == "AUTH_ECR_REPOSITORY" || key == "ADMIN_ECR_REPOSITORY" || key == "ECR_REPOSITORY") && value !~ /^[a-z0-9][a-z0-9._\/-]*$/) malformed = 1
      if (key == "VPS_HOST" && value !~ /^[A-Za-z0-9.-]+$/) malformed = 1
      if (key == "VPS_PORT" && (value !~ /^[0-9]+$/ || value < 1 || value > 65535)) malformed = 1
      if (key == "VPS_USER" && value !~ /^[A-Za-z_][A-Za-z0-9._-]*$/) malformed = 1
      if (malformed) {
        printf "Malformed value for %s in %s\n", key, source > "/dev/stderr"
        failed = 1
        exit 1
      }
    }
    END {
      if (failed) exit 1
      if (NR == 0) exit 1
      for (key in required) {
        if (!(key in seen)) {
          printf "Missing key %s in %s\n", key, source > "/dev/stderr"
          exit 1
        }
      }
    }
  ' "$file"
}

for environment in ecr-build development-auth development-admin; do
  variables="$prepared_directory/$environment.vars.env"
  [ -f "$variables" ] && [ ! -L "$variables" ] && [ -s "$variables" ] || {
    echo "Missing non-empty variables file: $variables" >&2
    exit 1
  }
  [ "$(file_mode "$variables")" = 600 ] || {
    echo "Variable file must have mode 600: $variables" >&2
    exit 1
  }
  case "$environment" in
    ecr-build)
      expected="AWS_ACCOUNT_ID AWS_REGION AWS_BUILD_ROLE_ARN AUTH_ECR_REPOSITORY ADMIN_ECR_REPOSITORY"
      ;;
    *)
      expected="AWS_ACCOUNT_ID AWS_REGION AWS_DEPLOY_ROLE_ARN ECR_REPOSITORY VPS_HOST VPS_PORT VPS_USER"
      ;;
  esac
  validate_env_contract "$variables" "$expected" true
done
for environment in development-auth development-admin; do
  secrets="$prepared_directory/$environment.secrets.env"
  [ -f "$secrets" ] && [ ! -L "$secrets" ] && [ -s "$secrets" ] || {
    echo "Missing non-empty secrets file: $secrets" >&2
    exit 1
  }
  secret_mode="$(file_mode "$secrets")"
  [ "$secret_mode" = 600 ] || {
    echo "Secret file must have mode 600: $secrets" >&2
    exit 1
  }
  validate_env_contract "$secrets" \
    "VPS_SSH_PRIVATE_KEY_B64 VPS_SSH_KNOWN_HOSTS_B64 HOST_RELEASE_SIGNING_PRIVATE_KEY_B64" false
  while IFS='=' read -r key value; do
    printf '%s' "$value" | openssl base64 -d -A >/dev/null 2>&1 || {
      echo "Invalid base64 value for $key in $secrets" >&2
      exit 1
    }
  done <"$secrets"
done

for environment in ecr-build development-auth development-admin; do
  if ! gh api "repos/$repository/environments/$environment" >/dev/null 2>&1; then
    gh api --method PUT "repos/$repository/environments/$environment" >/dev/null
    echo "Created GitHub environment $environment."
  fi
  gh variable set --repo "$repository" --env "$environment" \
    --env-file "$prepared_directory/$environment.vars.env"
  echo "Updated variables for $environment."
done

for environment in development-auth development-admin; do
  gh secret set --repo "$repository" --env "$environment" \
    --env-file "$prepared_directory/$environment.secrets.env"
  echo "Updated secrets for $environment."
done

echo "Development GitHub environments were updated without printing secret values."
