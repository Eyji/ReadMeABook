# Contributing to ReadMeABook

Thanks for wanting to help. Fixes and features are both welcome. This page covers how to get set up and what I look for in a pull request.

## Getting Help

Setup, configuration and "how do I" questions belong on [Discord](https://discord.gg/kaw6jKbKts), not in issues. It's also the best place to talk through an idea before you start building it.

Security problems should be reported privately. See [SECURITY.md](SECURITY.md).

## Development Setup

Requirements: Node.js 20 and npm. Installing `ffmpeg` and `ffprobe` is optional, but without them the real-ffmpeg integration tests are skipped.

```bash
npm ci
npx prisma generate
npm test
```

`npm test` runs the full Vitest suite. It should pass before you open a pull request.

## Project Standards

The full standards live in [CLAUDE.md](CLAUDE.md). The short version:

- **Docs first:** documentation lives in `documentation/`. Start at `documentation/TABLEOFCONTENTS.md` to find the doc for the area you are changing.
- **Docs format:** keep docs in the token-efficient format described in CLAUDE.md (bullets, tables, compact code blocks, no long prose). Update the relevant doc in the same PR as the code, and add new docs to `TABLEOFCONTENTS.md`.
- **File headers:** every code file starts with a header comment naming the component and linking to its doc:
  ```typescript
  /**
   * Component: User Authentication Service
   * Documentation: documentation/backend/services/auth.md
   */
  ```
- **File size:** keep files at or under 400 lines. Split a file that grows past that.

## Pull Requests

- Keep each PR small and focused on one change. Unrelated fixes go in their own PR.
- Link the issue it addresses, or explain the problem if there isn't one.
- Add or update tests for the behavior you change, and make sure the full `npm test` suite passes.
- Include screenshots for UI changes.
- Never commit secrets, tokens or API keys, including in test fixtures and screenshots.

Triage of issues and pull requests on this repo is AI-assisted.
