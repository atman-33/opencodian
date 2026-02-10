# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-02-10

### Added
- Clickable internal note links in assistant messages for seamless navigation
- New skills for OpenSpec workflows (obsidian-plugin-deploy, obsidian-plugin-release, pr-to-origin-main)

### Changed
- Enhanced assistant message display with interactive link support

[0.1.2]: https://github.com/DanielDaniel2201/opencodian/compare/0.1.1...0.1.2

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

[0.1.1]: https://github.com/atman-33/opencodian/releases/tag/0.1.1
