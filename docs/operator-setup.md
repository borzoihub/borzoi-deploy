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

## 3. Create the ECR repositories

One-time, per repo. Run these from the respective repo directories:

```bash
cd /path/to/borzoi-backend
npm run docker:setup

cd /path/to/borzoi-frontend
npm run docker:setup
```

Each `docker:setup` is idempotent — it skips if the repo already exists. It also enables scan-on-push.

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

## 5. Create the shared ECR pull IAM user

This IAM user's credentials go on **every** customer Pi. It's pull-only, scoped to just the borzoi repos.

```bash
# Create the user
aws iam create-user --user-name borzoi-installer

# Attach the policy (save this as borzoi-installer-policy.json first)
aws iam put-user-policy \
  --user-name borzoi-installer \
  --policy-name borzoi-ecr-pull \
  --policy-document file://borzoi-installer-policy.json

# Generate access keys
aws iam create-access-key --user-name borzoi-installer
```

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
