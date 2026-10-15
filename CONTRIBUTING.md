# Contributing

Open an issue describing the problem or submit a focused pull request. Include
the behavior before and after the change and the relevant `npm test` and
`npm run check` results. Add regression cases for changes to stamp evaluation or
trust boundaries. Keep GitHub Action references pinned to full commit SHAs.

Use synthetic examples. Never upload private PR text, repository names,
credentials, private keys, or production configuration in fixtures or reports.

Do not execute untrusted PR code from the privileged publisher, replace the
dedicated App identity with GitHub Actions, or weaken environment restrictions.
Changes to review formats should preserve authentication, exact current-head
binding, and conservative treatment of ambiguous evidence.

For security reports, follow [SECURITY.md](SECURITY.md).
