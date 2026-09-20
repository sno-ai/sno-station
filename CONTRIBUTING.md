# Contributing to Sno Station

Thanks for helping build Sno Station in public. This page is short on purpose.

## Before you start

- **Questions and ideas** go to [Discussions](https://github.com/sno-ai/sno-station/discussions).
- **Bugs and feature requests** use the issue templates.
- **Security problems** never go in a public issue. See [SECURITY.md](SECURITY.md).
- **Using Claude Code and Codex together already?** Open a
  [design partner issue](.github/ISSUE_TEMPLATE/design-partner.yml). We want to hear from you first.

## Making a change

1. Fork and branch from `main`.
2. Keep one change per pull request. A PR that does two things gets split.
3. Run the checks that apply to what you touched:

   ```bash
   npm ci
   npm run build
   npm run typecheck
   npm run lint
   npm run test:unit --workspace <package-you-changed>
   ```

4. Sign off every commit (DCO). We do not use a CLA.

   ```bash
   git commit -s -m "fix: describe the change"
   ```

   The sign-off certifies the [Developer Certificate of Origin](https://developercertificate.org/).

5. Open the PR using the template. Say what changed, why, and how you tested it.

## What we will ask you to remove

- Benchmark numbers or vendor comparisons added to docs. Numbers live in `evals/` with a receipt,
  nowhere else.
- Any private host name, absolute home path, credential, or link to a private document.
- Text that names one model vendor as the careful one and the other as the fast one. It flips by
  month and by job; the product is that they differ.

## Code of conduct

Everyone participating is expected to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
