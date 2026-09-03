---
name: learning-loop
description: Use when someone wants to learn, review, practice, or test a subject systematically; build a long-term study path; curate learning resources; use active recall or the Feynman technique; or continue a learning journal across sessions. Prefer a document-specific study skill for one-off explanation of a course PDF or slide deck.
---

# Learning Loop

Turn AI-assisted study into a feedback loop: diagnose, choose a path, practice, retrieve, repair gaps, compress, and revisit. Optimize for what the learner can explain and do, not how much content was produced.

## Start or resume

1. Look for `learning-journal/` in the current project. If it is absent, look for an established, clearly equivalent learning archive such as `study/`; continue using that archive rather than creating a parallel journal. If a matching topic exists, read the available roadmap, progress/checkpoint, and latest session note before responding; restore the active mode and pending interaction rather than restarting or repeating a question.
2. If the user names one mode, enter it directly and ask only for information required by that mode.
3. Otherwise, establish all six diagnostic fields before prescribing a route: topic, current level, concrete goal, time budget/deadline, existing materials, and practice conditions. Acknowledge known fields and ask concise questions only for missing ones. Do not present a personalized roadmap before the diagnosis is complete.
4. Recommend either the full loop or the smallest useful mode, explain why in one sentence, and begin interactively.

## Modes

The available modes are `ladder`, `20-hour-plan`, `quiz`, `cheat-sheet`, `resources`, and `feynman`. For exact interaction and output contracts, read [references/modes.md](references/modes.md) when entering a mode.

Use the full loop for a new field or long-term goal:

`resources → ladder → 20-hour-plan → practice → quiz → feynman repair → cheat-sheet → review`

This sequence is a route, not a single huge response. Produce only the current useful artifact, then interact or wait for the learner.

`practice` and `review` are ordinary stages, not additional modes. Practice begins from a plan milestone, produces an observable artifact or performance attempt, and records evidence against an acceptance criterion. Review begins after a milestone or scheduled interval, compares evidence with the roadmap, updates strengths/gaps/next action, and selects the next mode; passive reading alone is not completion evidence.

## Learning journal

Default to maintaining `learning-journal/<topic>/` in the current writable project. If the project already has a clearly established learning archive, preserve its structure and update it instead. Before the first write, state the intended path; proceed without adding a confirmation round unless the learner opts out. Read [references/journal.md](references/journal.md) before creating or updating the archive.

If no writable project is available, continue in chat and say that persistence was skipped. Never overwrite unrecognized user-authored text or erase history.

### Website-facing course archive

When the learner explicitly asks for a local learning-progress website archive, website-readable course files, or the standard `course.md` / `notes.md` / `reviews.md` / `resources.md` / `schedule.md` layout, read [references/course-website-archive.md](references/course-website-archive.md) before inspecting or writing files.

This is an opt-in archive format, not the default journal layout. It may create or update the standard files only when the learner has requested the archive and supplied, or can safely confirm, the course directory and required course metadata. Once an archive exists, synchronize its `course.md` and relevant session record with every local learning save; update other standard files only when new real evidence changes them.

### Course index synchronization

When the active topic archive contains `course.md`, treat it as the website-facing index of the same learner state. Every local learning-archive save must read and synchronize `course.md` in the same write batch as profile, roadmap, progress, mistake, or session updates.

- Preserve the file's existing schema, required headings, verified completion states, personal mistakes, and historical records.
- Update its `updated` date and merge any new real session evidence, current next action, or supported mistake correction that belongs in the existing structure.
- Change a task from `[ ]` to `[x]` only when explanation, retrieval, runnable practice, or test evidence proves the task's stated acceptance criterion. A save operation or passive reading is not completion evidence.
- Do not create `course.md` unless the learner or project has supplied its required schema. If it exists but cannot be safely synchronized, report the local save as incomplete instead of silently leaving the website index stale.

## Resource integrity

For recommendations described as current, best, latest, or high-leverage, browse and verify the live canonical page. Prefer official courses, textbooks, papers, maintained repositories, and credible expert material. Cite the page supporting each resource and distinguish verified facts from judgment. If browsing is unavailable, state that limitation and do not invent links, editions, dates, or availability.

## Domain preset

When the topic is autonomous-driving localization, mapping, SLAM, or closely related state estimation, read [references/localization-mapping.md](references/localization-mapping.md). It supplies diagnostic dimensions and project ideas, not a mandatory curriculum.

## Session close

At a natural stopping point, automatically update the local learning archive if enabled. Create or append a dated session summary that is plain-language and records what was learned, retrieval evidence/corrections, what remains incomplete, and the next action. If `course.md` exists, synchronize it in that same save. Then give a short recap in the learner's language:

1. key knowledge learned;
2. likely pitfalls or remaining gaps;
3. one to three next learning directions.

## Local dashboard integration

When the learner wants to visualize a standard learning archive, keep the Markdown files as the source of truth and let the local Learning Loop dashboard read them. The dashboard is read-only: do not add website-specific files or claim that opening the website proves a task is complete.

If this skill is installed from the Learning Loop project, the repository root contains the dashboard and a sanitized example. Start the example with `npm run dashboard` from the repository root. For a learner's own archive, pass a dashboard config with course roots pointing to the relevant `learning-journal/<topic>/` directories, or use `npm run dashboard -- --config <path>`.

## Common mistakes

- Giving a generic roadmap after hearing only the topic and claimed level.
- Dumping all quiz questions instead of waiting after one question.
- Revealing an answer before the learner attempts active recall.
- Ending a Feynman loop after correction without asking for a cleaner re-explanation.
- Re-teaching everything instead of only the demonstrated gaps.
- Treating a 20-hour plan as a promise of mastery rather than a high-leverage first pass.
- Recommending plausible-looking resources without live verification.
- Recreating or overwriting a journal instead of merging with its recorded state.
