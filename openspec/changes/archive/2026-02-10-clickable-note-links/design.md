## Context

The Opencodian plugin uses Obsidian's `MarkdownRenderer` to render assistant messages, which automatically converts `[[Note Name]]` wikilinks to `<a class="internal-link" data-href="Note Name">` elements. However, these links lack custom click handlers, making them non-functional within the chat context. User message mention chips already have working click handlers via `openMentionedFile()` → `FileMention.openFile()`.

## Goals / Non-Goals

**Goals:**
- Add click interactivity to internal links in assistant messages without changing visual appearance
- Reuse existing file-opening logic (`FileMention.openFile()`) for consistency
- Support standard Obsidian navigation patterns (modifier keys for new tabs)

**Non-Goals:**
- Modifying how MarkdownRenderer processes wikilinks (keep default behavior)
- Changing link styling or visual design
- Adding click handlers to external links (http/https URLs)
- Supporting custom link formats beyond Obsidian's standard wikilinks

## Decisions

### Decision 1: Post-render enrichment pattern
**Choice:** Add `enrichInternalLinks()` method called after `MarkdownRenderer.render()`, similar to existing `enrichCodeBlocks()`

**Rationale:**
- Separates concerns: MarkdownRenderer handles parsing, enrichment adds interactivity
- Follows established pattern in codebase (`enrichCodeBlocks` at line 1846)
- Non-invasive: doesn't require modifying Obsidian's rendering pipeline

**Alternatives considered:**
- Custom markdown post-processor: More invasive, requires registering with Obsidian API
- Override link rendering: Complex, would break Obsidian's default link handling

### Decision 2: Reuse `FileMention.openFile()`
**Choice:** Delegate file opening to existing `FileMention.openFile(path)` method

**Rationale:**
- Already handles both `TFile` and `TFolder` cases correctly (lines 1137-1160 in FileMention.ts)
- Consistent behavior with user message mention chips
- Avoids code duplication

**Alternatives considered:**
- Direct `workspace.openLinkText()` call: Simpler but loses folder handling and future enhancements
- Duplicate file opening logic: Violates DRY principle

### Decision 3: Modifier key support
**Choice:** Implement Ctrl/Cmd+Click and middle-click for opening in new tab

**Rationale:**
- Standard Obsidian navigation pattern (users expect this behavior)
- Low implementation cost (check `e.ctrlKey || e.metaKey` and `e.button === 1`)
- Reference implementation exists in claudian codebase

**Implementation:**
```typescript
linkEl.addEventListener("click", (e: MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  const href = linkEl.getAttribute("data-href");
  if (e.ctrlKey || e.metaKey) {
    this.app.workspace.openLinkText(href, "", true); // new tab
  } else {
    this.fileMention.openFile(href);
  }
});
```

## Risks / Trade-offs

**[Risk] Breaking changes in Obsidian's MarkdownRenderer API**
→ Mitigation: Query `.internal-link` via standard DOM API, not relying on undocumented behavior

**[Risk] Performance with many links in long conversations**
→ Mitigation: Enrichment runs once per message, event listeners use event delegation where possible

**[Trade-off] Inconsistent behavior with Obsidian's core note links**
→ Accepted: Custom handling is necessary because default link behavior doesn't work in custom views

**[Trade-off] No visual indication that links are now clickable**
→ Accepted: Maintaining existing styling keeps changes minimal and non-breaking
