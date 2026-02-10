## Why

Currently, when assistant messages contain Obsidian note names (rendered as `[[Note Name]]` wikilinks), they appear visually styled but are not interactive—clicking them does nothing. Users expect these links to open the referenced notes, just like the clickable mention chips in user messages. This creates an inconsistent user experience and limits navigation efficiency within the chat interface.

## What Changes

- Add click handlers to internal links (`.internal-link` elements) in assistant messages
- Extract note path/name from `data-href` attribute and open files using existing `FileMention.openFile()` logic
- Support modifier keys (Ctrl/Cmd+Click for new tab, middle-click for new tab)
- Maintain visual consistency with existing link styling (no UI changes)

## Capabilities

### New Capabilities
- `clickable-assistant-links`: Enable click interaction for Obsidian internal links in assistant messages, allowing users to open referenced notes directly from the chat

### Modified Capabilities
<!-- No existing capabilities are being modified -->

## Impact

**Affected code:**
- `src/features/chat/OpencodianView.ts` - Add `enrichInternalLinks()` method and wire it into `renderMarkdown()` pipeline

**User experience:**
- Improved navigation: users can click note links in assistant responses to immediately open files
- Consistent behavior: assistant message links behave the same as user message mention chips
- No breaking changes: visual appearance remains unchanged
