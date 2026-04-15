# Customer onboarding

Per-install checklist for the operator. In today's product, the only AWS resource the Pi actually authenticates against is ECR — and the ECR pull credentials are shared across all customer installs (see [operator-setup.md § 5](operator-setup.md#5-create-the-shared-ecr-pull-iam-user)). So per-customer onboarding is light.

## Why there's no per-customer IAM user today

The backend has code paths for S3 (file uploads) and SES (account emails) but neither feature is used by the product. The install writes placeholder AWS credentials into `.env` to satisfy env-var validation — no actual AWS calls are made with them.

If/when S3 or SES features are wired in later, each customer will need an IAM user with policies scoped to their bucket + SES domain. That setup has been captured in the [Future: per-customer AWS setup](#future-per-customer-aws-setup) section below so the procedure isn't lost.

## 1. Choose a domain

Pick the public hostname the customer will use (e.g. `borzoi.acme.example`). They (or you) add an A record pointing at the Pi's public IP.

## 2. Assemble the credentials packet

Text file to hand to the installer. Delete from your machine after delivery; keep only a secure copy in your password manager.

```
================================================================
Borzoi installation credentials — KEEP SECRET
================================================================

Customer:         Acme Heating
Public domain:    borzoi.acme.example
Pi hardware:      Raspberry Pi 5, 8GB

─── ECR pull credentials (shared installer — same for all sites) ───
Paste this JSON block when setup.sh asks for it:

{
  "ecr_region":        "eu-north-1",
  "ecr_registry":      "123456789012.dkr.ecr.eu-north-1.amazonaws.com",
  "access_key_id":     "AKIA...",
  "secret_access_key": "..."
}

─── Bootstrap admin ───
Admin email:      admin@acme.example
(password is auto-generated during setup.sh and printed once)

─── Cloudflare Tunnel ───
Tunnel token:     <paste from Zero Trust dashboard>
================================================================
```

## 3. Hand off

Send the packet to the installer (or the customer if they're self-installing). They'll use it during the [installation](installation.md) step.

## Revocation

If a Pi is stolen, decommissioned, or compromised:

- **Single compromised install**: there's nothing customer-specific to revoke today beyond the bootstrap admin password (which is installation-specific anyway). Wipe the Pi and reinstall.
- **Shared ECR installer compromised**: rotate the installer IAM user's credentials globally and push updates to every customer Pi (see [operator-setup.md § 7](operator-setup.md#7-rotation-cadence)).

---

## Future: per-customer AWS setup

**Only perform these steps if/when the backend starts using S3 or SES in earnest.** Today they are skipped.

### S3 bucket

```bash
CUSTOMER=acme-heating
AWS_REGION=eu-north-1

aws s3api create-bucket \
  --bucket borzoi-$CUSTOMER \
  --region $AWS_REGION \
  --create-bucket-configuration LocationConstraint=$AWS_REGION

aws s3api put-public-access-block \
  --bucket borzoi-$CUSTOMER \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

### SES sender verification

Either domain or individual email address:

```bash
aws ses verify-domain-identity --domain customer.example
# Customer adds the returned TXT record to DNS

# or for a single address:
aws ses verify-email-identity --email-address no-reply@customer.example
```

If the SES account is still in the sandbox, verify every recipient too, or request production access.

### Per-customer IAM user

```bash
CUSTOMER=acme-heating

aws iam create-user --user-name borzoi-app-$CUSTOMER

aws iam put-user-policy \
  --user-name borzoi-app-$CUSTOMER \
  --policy-name borzoi-app \
  --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3",
      "Effect": "Allow",
      "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::borzoi-$CUSTOMER",
        "arn:aws:s3:::borzoi-$CUSTOMER/*"
      ]
    },
    {
      "Sid": "SES",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": "*"
    }
  ]
}
EOF
)"

aws iam create-access-key --user-name borzoi-app-$CUSTOMER
```

### Update `.env` on the Pi

Replace the placeholder values:

```bash
cd /opt/borzoi
# Edit .env:
AWS_ACCESS_KEY_ID=AKIA...          # real app key
AWS_SECRET_ACCESS_KEY=...
S3_BUCKET=borzoi-acme-heating
SES_SENDER=no-reply@acme.example

docker compose restart backend
```

### Revocation (future)

When the per-customer IAM user exists:

```bash
aws iam list-access-keys --user-name borzoi-app-$CUSTOMER
aws iam delete-access-key --user-name borzoi-app-$CUSTOMER --access-key-id AKIA...
aws iam delete-user-policy --user-name borzoi-app-$CUSTOMER --policy-name borzoi-app
aws iam delete-user --user-name borzoi-app-$CUSTOMER
```

Other customers are unaffected.
