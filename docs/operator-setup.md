# Operator setup (one-time)

Work you do **once** as the developer before any customer installation. Most of this happens on your Mac.

## Prerequisites

- An AWS account you control (for ECR, and separate sub-accounts or IAM users per customer for S3 + SES)
- `aws-cli` v2 installed and configured on your Mac
- Docker Desktop (or equivalent) with Buildx
- A GitHub account with access to the `@borzoihub/*` and `@digistrada/*` npm packages
- A GitHub Personal Access Token with `read:packages` scope — needed only for **building** images locally, not for running them

## 1. Stash the GitHub Packages token for image builds

The backend and frontend Dockerfiles use a BuildKit secret to auth against GitHub Packages. Put the token in a file with mode 600:

```bash
echo "ghp_your_token_here" > ~/.borzoi-ghcr-token
chmod 600 ~/.borzoi-ghcr-token
```

The secret is never baked into the image — BuildKit mounts it only for the duration of `npm ci`.

## 2. Set the ECR registry env var

Add this to your shell profile (`~/.zshrc` / `~/.bashrc`):

```bash
export BORZOI_ECR_REGISTRY=<account-id>.dkr.ecr.<region>.amazonaws.com
export AWS_REGION=eu-north-1
```

Replace `<account-id>` and `<region>` with your AWS account and region.

## 3. Create ECR repos + shared installer IAM user (automated)

The `scripts/aws-setup.sh` in `borzoi-deploy` handles everything in one shot: creates the two ECR repos, creates the `borzoi-installer` IAM user, writes its inline policy, and issues access keys. Idempotent — safe to re-run.

```bash
cd /path/to/borzoi-deploy
./scripts/aws-setup.sh
```

The script:
1. **Asks for AWS admin credentials** interactively. These are held in environment variables for the duration of the script only — never written to disk, never committed to shell history, gone when the script exits.
2. Creates `borzoi-backend` and `borzoi-frontend` ECR repos (scan-on-push enabled, AES256 encryption).
3. Creates or updates the `borzoi-installer` IAM user with a policy scoped to pull-only on just those two repos.
4. Issues a new access key (on first run), or reports the existing key ID (on re-runs).
5. **Prints the installer credentials JSON to stdout** (copy-paste-ready for `setup.sh`) **and writes it to `./installer-creds.json`** (mode 600) for safekeeping on the operator machine. The file is gitignored. Pass `--json-out /dev/null` to skip the file write.

Flags:
- `--region <aws-region>` — override the region (default `$AWS_REGION` or `eu-north-1`)
- `--rotate-key` — delete existing access keys and issue a new one. Use when rotating on schedule or if you've lost the secret.

**Save the printed JSON block (or the `installer-creds.json` file) somewhere durable** — password manager is ideal. The secret is shown only at creation time and is not retrievable from AWS later. If you lose it, re-run with `--rotate-key` to issue a new access key.

**Flags:**
- `--region <aws-region>` — override the region
- `--rotate-key` — delete existing access keys and issue a new one
- `--json-out <path>` — override the file output path (default `./installer-creds.json`). Pass `/dev/null` to skip writing the file.

## 3a. Manual equivalent (if you prefer not to run the script)

Everything the script does, you can do by hand:

```bash
# ECR repos
aws ecr create-repository --repository-name borzoi-backend \
  --region eu-north-1 --image-scanning-configuration scanOnPush=true
aws ecr create-repository --repository-name borzoi-frontend \
  --region eu-north-1 --image-scanning-configuration scanOnPush=true

# IAM user
aws iam create-user --user-name borzoi-installer
aws iam put-user-policy --user-name borzoi-installer \
  --policy-name borzoi-ecr-pull \
  --policy-document file://borzoi-installer-policy.json
aws iam create-access-key --user-name borzoi-installer
```

The `borzoi-installer-policy.json` template appears in step 5 below.

## 4. Publishing images

One-time auth per 12-hour ECR token lifetime:

```bash
cd /path/to/borzoi-backend
npm run docker:login
```

Then bump the version and release:

```bash
# In borzoi-backend
npm version patch  # or minor/major
npm run docker:release

# In borzoi-frontend
npm version patch
npm run docker:release
```

`docker:release` does:
1. `docker buildx build --platform linux/arm64 --secret id=ghtoken,src=~/.borzoi-ghcr-token --load -t $BORZOI_ECR_REGISTRY/borzoi-<name>:<version> -t $BORZOI_ECR_REGISTRY/borzoi-<name>:latest .`
2. `docker push` both tags

Native arm64 build takes ~1-2 minutes on Apple Silicon. On Intel Macs, QEMU emulation adds ~2-3×.

## 5. IAM policy reference

(Already applied automatically by `scripts/aws-setup.sh` in step 3. This reference exists for audit / the manual path in step 3a.)

`borzoi-installer-policy.json`:

```json
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
        "arn:aws:ecr:<region>:<account-id>:repository/borzoi-backend",
        "arn:aws:ecr:<region>:<account-id>:repository/borzoi-frontend"
      ]
    }
  ]
}
```

Replace `<region>` and `<account-id>` with yours. **Save the access key ID and secret** — you'll hand these to every customer install.

## 6. Prepare the deploy bundle repo

Host `borzoi-deploy` somewhere reachable by customer Pis. Options:

- **Public GitHub repo** — simplest. No secrets in the repo, just the compose file and setup scripts. Customers `git clone` directly.
- **Private GitHub repo** — requires the Pi to auth. Not recommended unless you have a reason.
- **S3-hosted tarball** — host a tarball of `borzoi-deploy` at a stable URL, skip git entirely. `install.sh` downloads and extracts.

Update `install.sh` to point at wherever you host it:

```bash
# In borzoi-deploy/install.sh
BORZOI_DEPLOY_REPO="${BORZOI_DEPLOY_REPO:-https://github.com/borzoihub/borzoi-deploy.git}"
```

## 7. Rotation cadence

Plan to rotate the shared ECR installer credentials on a schedule (annual is reasonable). Rotation requires updating the `[borzoi-ecr]` profile on every customer Pi. Script it or document the SSH sequence.

App credentials (per-customer S3/SES) are rotated independently when an individual customer requires it — those rotations don't affect other customers.
