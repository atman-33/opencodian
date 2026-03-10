## Context

Opencodian already has a mature input enhancement layer through `FileMention`, which handles `@`-triggered suggestions, dropdown rendering, keyboard navigation, and chip insertion for files and skills. The new slash workflow overlaps with the same composer surface, but differs in two important ways: slash suggestions are plain text insertions rather than chips, and the data source spans three directories with mixed file and folder semantics.

The multi-agent-ff15 desktop app provides a proven reference pattern: detect `/` at token boundaries, filter a preloaded suggestion list, show a dropdown above the input, and insert descriptive text on selection. In Opencodian, the existing contenteditable-based composer means reusing or extending `FileMention` is preferable to introducing a separate parallel input controller that could conflict with current keyboard handling.

Constraints:
- The composer already reserves Enter/Tab/Arrow keys for mention suggestions when open.
- `.claude/skills` is read through the Obsidian vault adapter, while `.opencode/command` and `.opencode/skills` may require filesystem access rooted at the vault path.
- Existing skill mentions use chip insertion for `@`; slash suggestions must not mutate that behavior.

## Goals / Non-Goals

**Goals:**
- Add `/`-triggered suggestions to the existing chat composer without regressing `@` mentions.
- Source candidates from `.claude/skills` folder names, `.opencode/command` file names, and `.opencode/skills` folder names.
- Support keyboard and mouse selection with behavior consistent with the current suggestion UX.
- Insert normalized slash command text that is immediately ready to send or further edit.

**Non-Goals:**
- Executing commands directly from the dropdown.
- Parsing command metadata from markdown file contents for the first version.
- Supporting additional slash sources beyond the three requested directories.
- Replacing the existing `@` chip-based file and skill mention workflow.

## Decisions

### 1. Extend `FileMention` into a unified trigger controller
The slash feature will be implemented in the same controller that already manages input suggestions, rather than as a second suggestion manager.

Rationale:
- `FileMention` already owns caret tracking, dropdown lifecycle, and keyboard interception for the contenteditable input.
- A second controller would compete for the same keydown/input events and increase risk of conflicting open states.
- The slash dropdown can reuse the same rendering and selection infrastructure with a new item type and trigger detection path.

Alternative considered:
- Create a new `SlashSuggestion` controller attached beside `FileMention`. Rejected because it duplicates DOM/range logic and makes trigger precedence harder to reason about.

### 2. Represent slash items as a dedicated suggestion variant with plain-text insertion
The suggestion model will gain a slash-specific item type containing label, inserted value, source, and optional descriptive text. Selecting a slash item will replace the active `/query` token with plain text rather than a chip.

Rationale:
- Slash items differ semantically from files and skills: they guide prompt composition, not structured mentions.
- A dedicated type keeps rendering rules explicit and avoids overloading file/skill chip logic.
- Plain-text insertion preserves user editability and matches the proven multi-agent-ff15 UX.

Alternative considered:
- Reuse the existing skill item type for slash entries. Rejected because slash entries originate from both command files and skill folders and need different insertion text semantics.

### 3. Read slash sources with source-specific adapters, then merge and sort
The implementation will gather items from:
- `.claude/skills` via the Obsidian adapter (folder names only)
- `.opencode/command` via the Obsidian adapter when present in-vault, filtering markdown files and stripping extensions
- `.opencode/skills` via the Obsidian adapter when present in-vault, using folder names only

Items will be merged, deduplicated by displayed command value, and sorted alphabetically for stable navigation.

Rationale:
- In Opencodian, all requested paths are project-relative and naturally rooted in the vault, so the Obsidian adapter is the simplest and most portable access path.
- Source-specific normalization keeps command filenames and skill folder names predictable.
- Deterministic ordering makes keyboard selection easier to learn and test.

Alternative considered:
- Load slash data from a backend service or OpenCode process. Rejected because the sources are local project files already available to the plugin.

### 4. Preserve single-open-dropdown behavior with trigger precedence based on nearest active token
The composer will show either an `@` dropdown or a `/` dropdown, never both. Trigger detection will inspect text before the caret and activate the nearest valid token boundary.

Rationale:
- A single open suggestion surface matches the current mental model and avoids ambiguous keyboard routing.
- Nearest-token precedence supports mixed text such as `note @file then /opsx` without requiring mode switches.

Alternative considered:
- Make `@` always win when both are present in the input. Rejected because users often type both in one message and expect the most recent token to control suggestions.

## Risks / Trade-offs

- [Trigger detection in contenteditable is fragile] → Reuse existing range and before-caret helpers, and extend them carefully instead of introducing separate DOM parsing logic.
- [Directory contents may be missing or partially unreadable] → Fail closed per source, return partial results, and avoid blocking message composition.
- [Mixed suggestion types could make rendering harder to scan] → Use clear labels/icons/source badges so slash items remain distinguishable from file and skill mentions.
- [Deduplication may hide intentionally duplicated names across sources] → Deduplicate by inserted slash value only, while exposing source metadata in the label so later revisions can revisit precedence if needed.

## Migration Plan

1. Extend the suggestion controller and item model to support slash triggers.
2. Add source readers and normalization for the three requested directories.
3. Update dropdown rendering and keyboard selection to handle slash entries.
4. Verify that existing `@` file/skill mentions continue to work unchanged.
5. Release with no content migration required; rollback is a code-only revert.

## Open Questions

- Should slash insertion use bare command text like `/opsx-ff ` or a descriptive instruction sentence for some entries? The initial implementation will use direct slash command insertion unless coding reveals a stronger compatibility need.
- If both `.claude/skills` and `.opencode/skills` contain the same folder name, should the UI prefer one source or show both? The initial implementation will deduplicate identical inserted values.
