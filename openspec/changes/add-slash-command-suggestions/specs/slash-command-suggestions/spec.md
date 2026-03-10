## ADDED Requirements

### Requirement: Chat composer SHALL show slash suggestions from supported project directories
The system SHALL open a slash suggestion list when the user types `/` at the beginning of a composer token and SHALL populate that list from `.claude/skills` folder names, `.opencode/command` file names, and `.opencode/skills` folder names when those paths exist.

#### Scenario: Slash trigger opens suggestions
- **WHEN** the user types `/` in the chat composer at the beginning of the input or immediately after whitespace
- **THEN** the system shows a slash suggestion dropdown
- **AND** the dropdown contains matching entries collected from the supported directories

#### Scenario: Missing source directories do not fail the composer
- **WHEN** one or more supported slash source directories do not exist
- **THEN** the system omits entries from the missing directories
- **AND** the composer remains usable without displaying an error

### Requirement: Slash suggestions SHALL normalize and filter source entries
The system SHALL use folder names for `.claude/skills` and `.opencode/skills`, SHALL use filenames from `.opencode/command` with markdown extensions removed, and SHALL exclude hidden entries from all slash suggestion sources.

#### Scenario: Command markdown file is normalized
- **WHEN** `.opencode/command/opsx-ff.md` exists
- **THEN** the suggestion list includes `/opsx-ff`
- **AND** the suggestion list does not display `.md` in the inserted slash value

#### Scenario: Hidden entries are excluded
- **WHEN** a supported slash source contains a hidden file or folder whose name begins with `.`
- **THEN** the system does not display that entry in the slash suggestion dropdown

### Requirement: Slash suggestions SHALL support filtering and selection
The system SHALL filter slash suggestions by the active query text after `/`, SHALL allow keyboard navigation with ArrowUp and ArrowDown, and SHALL allow selection with Enter, Tab, or mouse click.

#### Scenario: Query narrows results
- **WHEN** the user types `/op`
- **THEN** the system limits visible slash suggestions to entries matching `op` in their displayed label or inserted value

#### Scenario: Keyboard selection inserts selected suggestion
- **WHEN** the slash suggestion dropdown is open and the user presses Enter or Tab on a highlighted item
- **THEN** the system inserts the highlighted slash suggestion into the composer

#### Scenario: Mouse selection inserts selected suggestion
- **WHEN** the slash suggestion dropdown is open and the user clicks a suggestion
- **THEN** the system inserts that slash suggestion into the composer

### Requirement: Slash suggestion insertion SHALL replace only the active slash token
The system SHALL replace the active `/query` token nearest to the caret with the selected slash suggestion text and SHALL preserve surrounding composer content.

#### Scenario: Slash insertion preserves surrounding text
- **WHEN** the composer contains `Please run /ops` and the user selects `/opsx-ff`
- **THEN** the system replaces only `/ops` with `/opsx-ff `
- **AND** the rest of the composer text remains unchanged

#### Scenario: Slash suggestion is not triggered mid-word
- **WHEN** the user types a `/` character in the middle of a word without a whitespace boundary
- **THEN** the system does not open the slash suggestion dropdown

### Requirement: Slash suggestions SHALL coexist safely with at-mention suggestions
The system SHALL show at most one suggestion dropdown at a time and SHALL preserve existing `@` file and skill mention behavior when slash suggestions are introduced.

#### Scenario: Most recent valid token controls dropdown
- **WHEN** the composer contains both an earlier `@` token and a later active `/` token near the caret
- **THEN** the system shows the slash suggestion dropdown for the active `/` token

#### Scenario: Existing at-mentions continue to work
- **WHEN** the user types `@` to mention a file or skill
- **THEN** the system shows the existing at-mention suggestions
- **AND** slash suggestion support does not change mention chip insertion behavior
