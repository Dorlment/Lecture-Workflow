# Contributing to Lecture Workflow

Thank you for helping improve Lecture Workflow. Contributions should stay focused, protect user data, and preserve the separation between classroom capture, realtime transcription, visual understanding, and final note generation.

## Reporting bugs

Use the repository's **Bug report** issue form and provide the smallest reliable reproduction. Search existing issues first and test the latest available release when practical.

Never post API keys, access tokens, passwords, Authorization headers, complete `data.json` contents, private classroom notes, transcript content, screenshots containing personal information, or unsanitized logs. Redact local paths and device identifiers when they are not essential to the report.

## Requesting features

Use the **Feature request** issue form. Describe the learning problem, the proposed behavior, and how it fits into a normal classroom workflow. Keep requests scoped; unrelated changes are easier to review as separate issues.

## Security and privacy

Do not disclose vulnerability details or secrets in a public issue. Use GitHub's private vulnerability reporting for this repository when it is available. If no private channel is available, open a minimal public issue asking the maintainer for a private contact method without including exploit details or sensitive data.

Lecture Workflow can process classroom notes, screenshots, realtime audio, transcripts, and provider credentials. Tests and examples must use synthetic, non-sensitive data.

## Development setup

Requirements:

- Node.js and npm compatible with the checked-in lockfile
- Obsidian desktop for manual plugin validation
- .NET 10 SDK for Windows Audio Companion development
- Windows for real WASAPI validation

Install JavaScript dependencies and run the standard checks from the repository root:

```powershell
npm ci
npm run lint
npm test
npx tsc --noEmit --skipLibCheck
npm run build
git diff --check
```

Build and test the optional Windows Audio Companion from the repository root:

```powershell
dotnet build companion/windows/LectureWorkflow.AudioCompanion.Windows.sln
dotnet test --solution companion/windows/LectureWorkflow.AudioCompanion.Windows.sln
```

The automated tests must use fake transports, fake capture sources, and synthetic PCM. Do not access real provider services or real WASAPI devices from automated tests.

## Pull requests

- Create a focused branch from the latest `main`.
- Keep each pull request limited to one coherent change.
- Add or update tests for changed behavior.
- Explain user-visible changes, validation performed, security implications, and anything intentionally left out of scope.
- Preserve existing protocol and lifecycle contracts unless the pull request explicitly proposes and documents a compatible change.
- Do not mix generated release artifacts with source changes.

Before requesting review, run the relevant targeted tests and the full checks listed above.

## Files that must not be committed

Do not commit:

- API keys, tokens, passwords, Authorization headers, `.env` files, or complete `data.json` files
- private classroom notes, transcripts, screenshots, PCM, recordings, or other user content
- `main.js` development copies from a Vault
- Windows Helper publish output, EXE, DLL, PDB, ZIP, or checksum release artifacts
- `bin/`, `obj/`, `TestResults/`, logs, dumps, caches, or temporary staging directories
- machine-specific absolute paths or editor-local configuration

## Scope and compatibility

Lecture Workflow is an Obsidian desktop plugin with a minimum supported Obsidian version defined in `manifest.json`. Windows system-audio capture uses an optional, manually installed Windows Audio Companion. Changes should continue to allow the plugin's non-audio classroom and AI workflows to function when that Helper is absent.

The Windows Audio Companion protocol is documented in [`docs/audio-companion-protocol.md`](docs/audio-companion-protocol.md). Verified V0.1 capability boundaries are documented in [`docs/v0.1-capability-boundaries.md`](docs/v0.1-capability-boundaries.md).

## License

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE). This project does not require a Contributor License Agreement.
