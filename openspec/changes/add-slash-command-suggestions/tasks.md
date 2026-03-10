## 1. Expand chat input suggestion model

- [x] 1.1 Extend the existing chat suggestion controller to detect `/` tokens alongside `@` tokens in the contenteditable composer.
- [x] 1.2 Add a dedicated slash suggestion item shape and single-dropdown state handling that preserves existing at-mention behavior.

## 2. Load and normalize slash suggestion sources

- [x] 2.1 Read `.claude/skills` folder names and convert them into slash suggestion entries.
- [x] 2.2 Read `.opencode/command` filenames and `.opencode/skills` folder names, normalize command names, exclude hidden entries, and merge the results deterministically.

## 3. Render and apply slash suggestions

- [x] 3.1 Update dropdown rendering so slash suggestions display clear labels/source context and support keyboard and mouse selection.
- [x] 3.2 Implement slash insertion so selecting an item replaces only the active `/query` token and preserves surrounding composer content.

## 4. Verify composer behavior

- [x] 4.1 Verify slash filtering, Enter/Tab/arrow navigation, and graceful behavior when source directories are missing.
- [x] 4.2 Run `npm run typecheck && npm run lint && npm run build` and fix any issues introduced by the change.
