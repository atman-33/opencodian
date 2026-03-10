## Why

Opencodian already supports `@`-based file and skill mentions, but it does not offer a guided `/` workflow for discovering executable commands and skills from the chat composer. Adding slash suggestions now will make advanced workflows easier to discover and align the Obsidian chat experience with the proven interaction pattern already used in multi-agent-ff15.

## What Changes

- Add slash-triggered suggestions to the chat composer when the user types `/` at the beginning of a token.
- Show candidate items from `.claude/skills` folder names, `.opencode/command` file names, and `.opencode/skills` folder names.
- Let users navigate suggestions with keyboard and mouse, then insert the selected slash command text into the composer.
- Reuse the existing mention-style dropdown behavior and visual affordances already used by Opencodian's chat input where practical.
- Exclude hidden entries and normalize command filenames so markdown extensions do not appear in inserted slash commands.

## Capabilities

### New Capabilities
- `slash-command-suggestions`: Provide discoverable `/` suggestions in the chat composer for local commands and skills sourced from supported project directories.

### Modified Capabilities
- None.

## Impact

- Affected code: `src/features/chat/OpencodianView.ts`, `src/features/chat/FileMention.ts`, and any new chat suggestion helpers or types.
- Affected behavior: chat input parsing, suggestion dropdown rendering, keyboard interaction, and inserted prompt text.
- Dependencies/systems: Obsidian vault adapter for `.claude/skills`, local filesystem access for `.opencode/command` and `.opencode/skills`, and the existing chat composer mention UX.
