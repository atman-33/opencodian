## 1. Implement link enrichment infrastructure

- [x] 1.1 Add `enrichInternalLinks()` private method to OpencodianView class
- [x] 1.2 Call `enrichInternalLinks()` in `renderMarkdown()` after `enrichCodeBlocks()`

## 2. Implement click handlers for internal links

- [x] 2.1 Query all `.internal-link` elements within the rendered container
- [x] 2.2 Extract `data-href` attribute from each internal link element
- [x] 2.3 Add click event listener that prevents default and stops propagation
- [x] 2.4 Implement normal click handling using `FileMention.openFile()`
- [x] 2.5 Implement Ctrl/Cmd+Click handling using `workspace.openLinkText()` with newLeaf=true
- [x] 2.6 Add middle-click (auxclick) event listener for opening in new tab

## 3. Testing and verification

- [x] 3.1 Test clicking internal links in assistant messages opens files in current tab
- [x] 3.2 Test Ctrl/Cmd+Click opens files in new tab
- [x] 3.3 Test middle-click opens files in new tab
- [x] 3.4 Test clicking non-existent file links fails gracefully
- [x] 3.5 Test messages with multiple internal links all work correctly
- [x] 3.6 Test messages without internal links render without errors
- [x] 3.7 Run typecheck, lint, and build commands to verify no regressions
