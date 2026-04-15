#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Borzoi operator AWS setup — one-time bootstrap of ECR + shared installer
# IAM user.
#
# Run ONCE as the operator, with AWS credentials that can:
#   - Create ECR repositories
#   - Create IAM users, attach inline policies, create access keys
#
# This script is idempotent:
#   - Existing ECR repos are left untouched
#   - Existing IAM user is updated (policy refreshed); new access key issued
#     only if --rotate-key is passed
#
# Output: an installer credentials packet to stdout. Save it, then paste
# the access keys into each customer's setup.sh prompt.
# ============================================================================

REGION="${AWS_REGION:-eu-north-1}"
USER_NAME="borzoi-installer"
POLICY_NAME="borzoi-ecr-pull"
ROTATE_KEY=0
JSON_OUT="./installer-creds.json"

while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --rotate-key) ROTATE_KEY=1; shift ;;
    --json-out) JSON_OUT="$2"; shift 2 ;;
    -h|--help)
      cat <<USAGE
Usage: $0 [--region <aws-region>] [--rotate-key] [--json-out <path>]

Creates (or updates) the ECR repositories borzoi-backend and
borzoi-frontend, and the shared installer IAM user with read-only
ECR access. Prints the installer credentials JSON to stdout AND
writes it to ./installer-creds.json (mode 600) for safekeeping on
the operator machine.

Options:
  --region       AWS region for ECR (default: \$AWS_REGION or eu-north-1)
  --rotate-key   Delete existing access keys and issue a new one.
                 Required if the secret has been lost — secrets cannot
                 be retrieved after initial creation.
  --json-out     Path to write the installer-creds JSON file
                 (default: ./installer-creds.json). Pass /dev/null to
                 skip writing the file (stdout-only).
USAGE
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ---------- preflight ------------------------------------------------------

command -v aws >/dev/null 2>&1 || { echo "ERROR: aws-cli not installed" >&2; exit 1; }

# Prompt the operator for AWS credentials. We do NOT use any pre-existing
# ~/.aws/credentials to avoid accidentally running against the wrong
# account. Credentials are held in environment variables for this
# process only — never written to disk, never added to the shell history,
# gone the moment the script exits.
echo "AWS admin credentials are required to create ECR repos + IAM user."
echo "They will be used only for this script's duration — NOT saved to disk."
echo

read -rp "AWS Access Key ID: " AWS_ACCESS_KEY_ID
if [ -z "$AWS_ACCESS_KEY_ID" ]; then echo "ERROR: access key required" >&2; exit 1; fi

read -rsp "AWS Secret Access Key: " AWS_SECRET_ACCESS_KEY
echo
if [ -z "$AWS_SECRET_ACCESS_KEY" ]; then echo "ERROR: secret key required" >&2; exit 1; fi

read -rp "Session token (empty unless using temporary creds): " AWS_SESSION_TOKEN

# Export for all subsequent aws-cli calls in this process. Subshells
# inherit these; they vanish when this script exits. Nothing writes
# them to disk.
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION="$REGION"
if [ -n "$AWS_SESSION_TOKEN" ]; then
  export AWS_SESSION_TOKEN
else
  unset AWS_SESSION_TOKEN
fi

# Prevent aws-cli from falling back to anything on disk.
export AWS_SHARED_CREDENTIALS_FILE=/dev/null
export AWS_CONFIG_FILE=/dev/null
export AWS_PROFILE=""
unset AWS_PROFILE

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "ERROR: AWS credentials rejected by STS. Check the values and try again." >&2
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
CALLER_ARN=$(aws sts get-caller-identity --query Arn --output text)
echo
echo "AWS account:    $ACCOUNT_ID"
echo "Region:         $REGION"
echo "Running as:     $CALLER_ARN"
echo

# ---------- ECR repositories ----------------------------------------------

ensure_repo() {
  local name="$1"
  if aws ecr describe-repositories \
       --repository-names "$name" \
       --region "$REGION" >/dev/null 2>&1; then
    echo "ECR repo exists:   $name"
  else
    aws ecr create-repository \
      --repository-name "$name" \
      --region "$REGION" \
      --image-scanning-configuration scanOnPush=true \
      --encryption-configuration encryptionType=AES256 >/dev/null
    echo "ECR repo created:  $name"
  fi
}

ensure_repo "borzoi-backend"
ensure_repo "borzoi-frontend"

# ---------- IAM user ------------------------------------------------------

if aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  echo "IAM user exists:   $USER_NAME"
else
  aws iam create-user --user-name "$USER_NAME" >/dev/null
  echo "IAM user created:  $USER_NAME"
fi

# ---------- inline policy (overwrites on every run — source of truth) ----

POLICY_DOC=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GetAuthToken",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "PullBorzoiImages",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchCheckLayerAvailability"
      ],
      "Resource": [
        "arn:aws:ecr:${REGION}:${ACCOUNT_ID}:repository/borzoi-backend",
        "arn:aws:ecr:${REGION}:${ACCOUNT_ID}:repository/borzoi-frontend"
      ]
    }
  ]
}
EOF
)

aws iam put-user-policy \
  --user-name "$USER_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "$POLICY_DOC"
echo "Policy updated:    $POLICY_NAME (scoped to borzoi-backend, borzoi-frontend pull only)"

# ---------- access key ----------------------------------------------------

EXISTING_KEYS=$(aws iam list-access-keys \
  --user-name "$USER_NAME" \
  --query 'AccessKeyMetadata[].AccessKeyId' \
  --output text)

NEW_ACCESS_KEY_ID=""
NEW_ACCESS_KEY_SECRET=""

if [ "$ROTATE_KEY" = "1" ] && [ -n "$EXISTING_KEYS" ]; then
  for k in $EXISTING_KEYS; do
    aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$k"
    echo "Deleted old key:   $k"
  done
  EXISTING_KEYS=""
fi

if [ -z "$EXISTING_KEYS" ]; then
  KEY_JSON=$(aws iam create-access-key --user-name "$USER_NAME")
  NEW_ACCESS_KEY_ID=$(echo "$KEY_JSON" | awk -F'"' '/"AccessKeyId"/ {print $4}')
  NEW_ACCESS_KEY_SECRET=$(echo "$KEY_JSON" | awk -F'"' '/"SecretAccessKey"/ {print $4}')
  echo "Access key issued: $NEW_ACCESS_KEY_ID"
else
  echo "Access key exists: $EXISTING_KEYS"
  echo "(Secret is not retrievable after initial creation.)"
  echo "Re-run with --rotate-key to delete it and issue a new one."
fi

# ---------- credentials packet --------------------------------------------

ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

if [ -n "$NEW_ACCESS_KEY_ID" ] && [ -n "$NEW_ACCESS_KEY_SECRET" ]; then
  JSON_BLOCK=$(cat <<EOF
{
  "ecr_region":        "$REGION",
  "ecr_registry":      "$ECR_REGISTRY",
  "access_key_id":     "$NEW_ACCESS_KEY_ID",
  "secret_access_key": "$NEW_ACCESS_KEY_SECRET"
}
EOF
)
  cat <<EOF

============================================================
Copy the JSON block below and paste it into setup.sh on the
customer Pi (when it asks for the installer credentials JSON).

The secret is shown ONLY here, ONLY now. It cannot be
retrieved later.
============================================================
$JSON_BLOCK
============================================================
EOF

  if [ "$JSON_OUT" != "/dev/null" ]; then
    umask 077
    printf '%s\n' "$JSON_BLOCK" > "$JSON_OUT"
    chmod 600 "$JSON_OUT"
    echo
    echo "Also written to: $JSON_OUT (mode 600)."
    echo "Keep this file on the operator machine — it's gitignored."
  fi
else
  cat <<EOF

============================================================
Reusing existing access key: $EXISTING_KEYS
============================================================
Its secret is not stored in AWS and cannot be retrieved.
If you've lost it, re-run with:
  $0 --rotate-key
to delete the old key and issue a new one (with a visible secret).

Unchanged values:
  ECR region:    $REGION
  ECR registry:  $ECR_REGISTRY
EOF
fi
