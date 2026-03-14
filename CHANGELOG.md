# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-03-14

### Added
- Bundled OpenCode runtime support with plugin-local config handling and runtime status surfaced in settings
- Agent-aware `@` mentions and richer request parts for chat prompts
- Two-level mention picker improvements for files, skills, and agents with fuzzy matching

### Changed
- Improved provider/model loading with clearer summaries and debug logging
- Updated settings guidance to explain bundled runtime behavior and config fallback behavior
- Refined mention and composer UX, including slash-command discovery in the chat input

### Fixed
- Prompt/request handling edge cases in `OpenCodeService`, including null-body responses and timeout/error propagation
- Windows startup fallback when auto-detected OpenCode is a `.cmd` launcher
- Startup fallback to system OpenCode when bundled runtime or plugin-local config is missing

## [0.2.0] - 2026-03-11

### Added
- Slash command suggestions in chat composer (`/` trigger) for discoverability of commands and skills
- Suggestions sourced from `.claude/skills`, `.opencode/command`, and `.opencode/skills` directories
- Keyboard and mouse navigation for slash suggestion dropdown

## [0.1.2] - 2026-02-10

### Added
- Clickable internal note links in assistant messages for seamless navigation
- New skills for OpenSpec workflows (obsidian-plugin-deploy, obsidian-plugin-release, pr-to-origin-main)

### Changed
- Enhanced assistant message display with interactive link support

## [0.1.1] - 2026-02-07

### Added
- Progressive timeout notices for chat responses (15s and 30s thresholds)
- Rate limit error detection with user-friendly messages

### Changed
- Improved error handling in OpenCodeService to abort event streams on prompt failures

### Fixed
- Fixed UI hanging indefinitely when rate limit errors occur
- Fixed linting issues: replaced `require('fs')` with ES module import
- Fixed unused variable warnings in OpenCodeService

[Unreleased]: https://github.com/DanielDaniel2201/opencodian/compare/0.3.0...HEAD
[0.3.0]: https://github.com/DanielDaniel2201/opencodian/compare/0.2.0...0.3.0
[0.2.0]: https://github.com/DanielDaniel2201/opencodian/compare/0.1.2...0.2.0
[0.1.2]: https://github.com/DanielDaniel2201/opencodian/compare/0.1.1...0.1.2
[0.1.1]: https://github.com/DanielDaniel2201/opencodian/releases/tag/0.1.1
