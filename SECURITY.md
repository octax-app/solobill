# Security

Octax Solobill holds client names, invoices and prices, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/octax-app/solobill/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a
reply within a few days. Once a fix is released, you'll be credited in the advisory unless you'd
rather not be.

This covers the code in this repository and the hosted service at https://inv.octax.dev. Please
test only against your own account or your own installation. Don't access other people's data,
degrade the service, or run automated scans against the hosted service.

## Supported versions

Security fixes go into `main` and the newest release. Self-hosted installs should stay on the latest
image (`docker compose pull && docker compose up -d`).
