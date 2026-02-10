## ADDED Requirements

### Requirement: Internal links SHALL be clickable in assistant messages
The system SHALL detect and enrich internal link elements (`.internal-link`) in assistant messages rendered by MarkdownRenderer, adding click event handlers that open the referenced file.

#### Scenario: User clicks internal link in assistant message
- **WHEN** user clicks an internal link in an assistant message
- **THEN** system opens the referenced file in the current Obsidian tab

#### Scenario: User Ctrl/Cmd+clicks internal link
- **WHEN** user holds Ctrl (Windows/Linux) or Cmd (Mac) and clicks an internal link
- **THEN** system opens the referenced file in a new Obsidian tab

#### Scenario: User middle-clicks internal link
- **WHEN** user middle-clicks (mouse button 1) an internal link
- **THEN** system opens the referenced file in a new Obsidian tab

#### Scenario: Internal link references non-existent file
- **WHEN** user clicks an internal link that references a file that does not exist in the vault
- **THEN** system fails gracefully without opening any file or displaying errors

### Requirement: Link enrichment SHALL run automatically after message rendering
The system SHALL invoke link enrichment (`enrichInternalLinks`) immediately after MarkdownRenderer completes, ensuring all internal links in newly rendered messages are interactive.

#### Scenario: Assistant message with multiple internal links is rendered
- **WHEN** MarkdownRenderer renders an assistant message containing multiple `[[Note Name]]` wikilinks
- **THEN** system processes all internal links and makes each clickable

#### Scenario: Assistant message with no internal links is rendered
- **WHEN** MarkdownRenderer renders an assistant message with no wikilinks
- **THEN** system completes enrichment without errors or side effects

### Requirement: Click handlers SHALL prevent default link behavior
The system SHALL call `preventDefault()` and `stopPropagation()` on click events to prevent browser navigation and event bubbling.

#### Scenario: Click event is intercepted
- **WHEN** user clicks an internal link
- **THEN** system prevents the browser from navigating to the href target
- **AND** system prevents the click event from propagating to parent elements

### Requirement: Link enrichment SHALL use existing file-opening logic
The system SHALL delegate file opening to the existing `FileMention.openFile()` method to ensure consistent behavior with user message mention chips.

#### Scenario: File is opened using shared logic
- **WHEN** user clicks an internal link in an assistant message
- **THEN** system uses the same file-opening mechanism as user message mention chips
- **AND** system handles both files and folders correctly
