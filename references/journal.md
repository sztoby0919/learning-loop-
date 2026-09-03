# Learning journal contract

The journal is durable learner state, not a transcript dump.

## Location and topic name

Use `learning-journal/<topic>/` under the current project. Prefer the learner's concise topic name. Remove filesystem-reserved characters and trailing dots/spaces; reject an empty result, Windows device names such as `CON`, `NUL`, `PRN`, `AUX`, `COM1`–`COM9`, and `LPT1`–`LPT9`, and shorten impractically long names. Resolve the project root, journal root, and candidate destination to canonical absolute paths before writing. The candidate must remain beneath the journal root, and no existing parent may be a symlink or junction that escapes the project. If validation fails, ask for a safe topic directory name or remain chat-only. If two topics would collide, ask for a disambiguating name. Do not write outside the current project unless the learner explicitly selects another location.

## Files

### `profile.md`

Keep the six diagnostic fields plus language preference and last-updated date:

- topic;
- current level and evidence;
- concrete goal/success criteria;
- time budget and deadline;
- existing materials;
- practice conditions/tools.

Update changed fields while preserving relevant earlier context under a dated history note.

### `roadmap.md`

Store the current five-level ladder, high-leverage plan, milestones, and final project acceptance checklist. Mark replaced plans as superseded with a date; do not silently delete them.

### `progress.md`

Maintain a concise current-state table: unit/milestone, status, evidence, confidence, last attempt, next action. Also keep a `Current interaction state` block with active mode, numbered item or milestone, whether the system is waiting for an answer/follow-up/re-explanation, the last question or task, and—in Feynman mode—the unresolved gaps and iteration count. Clear or replace this block when the interaction advances. Below it keep current strengths, gaps, and the next recommended mode. Treat learner performance as evidence, not a permanent label.

### Other artifacts

- `resources.md`: verified resources, access date, use order, and completion notes.
- `cheat-sheet.md`: latest compact review sheet; move materially different older versions into a dated history section.
- `sessions/YYYY-MM-DD[-n].md`: append-only session summary containing goal, work performed, retrieval evidence, corrections, artifacts changed, and next action.

## Safe update procedure

1. Validate the canonical destination and read existing files before editing.
2. Detect unfamiliar headings or free-form text and preserve them verbatim.
3. Make the smallest localized update; append dated evidence rather than rewriting history.
4. Never lower or raise mastery based only on passive reading. Record evidence from explanation, retrieval, or practice.
5. When a write fails, retain the prepared content in chat and explain what was not saved.

## Minimal first session

Create only files needed by the current work. A diagnosis may create `profile.md`, `progress.md`, and one session note; do not generate empty placeholders for every possible artifact.
