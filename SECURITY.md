# Security policy

Report a suspected vulnerability through this repository's GitHub private
vulnerability reporting channel, when enabled. Do not include credentials,
private repository data, or an unpublished exploit in a public issue. If that
channel is unavailable, open a minimal public issue asking for a private contact
without disclosing the vulnerability itself.

The security boundary is the dedicated App identity, protected environment,
trusted default-branch code, and authenticated Codex evidence. Protect changes
to those components. Never execute pull request code with the App token or PEM
key available. Do not broaden the App beyond metadata read and commit-status
write access.

The gate reads PR conversation comments, formal reviews, reactions, commit
resolution, existing statuses, and bridge workflow metadata/source through
GitHub's API. It writes the `Codex Review` status and logs the PR number, short
head SHA, and decision. It does not send PR content to an external service.
The separate Codex review integration has its own access and data handling.

The gate is event driven. Reactions require scheduled or manual reconciliation,
and an outage can prevent revoking a prior success. Administrators who can alter
the App installation, required-check source, environment rules, or trusted code
can change or bypass enforcement. Review evidence is not a security audit or a
guarantee that a change is safe.

Support currently targets the latest code in this repository. There is no
guaranteed response time or independent security certification.
