---
name: learning-loop
description: Use when someone wants to learn, review, practice, or test a subject systematically; build a long-term study path; curate learning resources; use active recall or the Feynman technique; or continue a learning journal across sessions. Also use for AI-powered learning diagnosis and evidence-based mastery tracking. Prefer a document-specific study skill for one-off explanation of a course PDF or slide deck.
---

# Learning Loop

Turn AI-assisted study into a feedback loop: diagnose, choose a path, practice, retrieve, repair gaps, compress, and revisit. Optimize for what the learner can explain and do, not how much content was produced.

## Core Value: Evidence-Driven Diagnosis

The system's core value is **finding knowledge gaps through real assessment answers**, not self-reported mastery. Every mastery score must come from:
- Quiz answers with evidence
- Practice problem results
- Retrieval attempts
- Feynman-style re-explanations

**Never accept self-reported mastery without evidence.**

## AI Diagnosis Flow (when API is configured)

When `AI_API_KEY` is configured in the environment, the system supports AI-powered diagnosis:

1. **Generate Assessment**: Create 5 short-answer questions based on course content
2. **Submit Answers**: User answers each question, AI provides instant feedback
3. **Generate Diagnosis**: AI analyzes all answers, identifies weak points with evidence
4. **Proposed Changes**: AI suggests updates to course.md, reviews.md, mistakes.md
5. **Confirm & Apply**: User reviews diff, confirms or rejects changes
6. **Atomic Write**: Changes applied atomically with file hash checking

### API Configuration

Environment variables:
- `AI_BASE_URL`: Mobile cloud API base URL
- `AI_API_KEY`: API key (server-side only, never expose to frontend)
- `AI_MODEL`: Model name with "2500W免费" tag

Without API key, the system runs in **local-only mode** with mock provider for development.

## Zhanlu IDE Development Flow

This project is developed using Zhanlu IDE with the following workflow:

1. **Requirement Breakdown**: Use Zhanlu's AI to break down features into tasks
2. **Code Generation**: Generate code using Zhanlu's intelligent completion
3. **Auto Testing**: Run `npm test` to verify functionality
4. **Code Review**: Use Zhanlu's code review to find issues
5. **Bug Fix**: Use Zhanlu's AI to fix discovered bugs
6. **Regression**: Re-run tests after fixes

Save screenshots of key Zhanlu interactions for competition evidence.

## Modes

The available modes are `ladder`, `20-hour-plan`, `quiz`, `cheat-sheet`, `resources`, `feynman`, and `diagnose`. For exact interaction and output contracts, read [references/modes.md](references/modes.md) when entering a mode.

Use the full loop for a new field or long-term goal:

`resources → ladder → 20-hour-plan → practice → quiz → diagnose → feynman repair → cheat-sheet → review`

## Learning Journal

Default to maintaining `learning-journal/<topic>/` in the current writable project. If the project already has a clearly established learning archive, preserve its structure and update it instead. Before the first write, state the intended path; proceed without adding a confirmation round unless the learner opts out.

### Website-facing course archive

When the learner explicitly asks for a local learning-progress website archive, website-readable course files, or the standard `course.md` / `notes.md` / `reviews.md` / `resources.md` / `schedule.md` layout, read [references/course-website-archive.md](references/course-website-archive.md) before inspecting or writing files.

## Resource Integrity

For recommendations described as current, best, latest, or high-leverage, browse and verify the live canonical page. Prefer official courses, textbooks, papers, maintained repositories, and credible expert material.

## Domain preset

When the topic is autonomous-driving localization, mapping, SLAM, or closely related state estimation, read [references/localization-mapping.md](references/localization-mapping.md).

## Session close

At a natural stopping point, automatically update the local learning archive if enabled. Create or append a dated session summary that is plain-language and records what was learned, retrieval evidence/corrections, what remains incomplete, and the next action.

## Local dashboard integration

When the learner wants to visualize a standard learning archive, keep the Markdown files as the source of truth and let the local Learning Loop dashboard read them. The dashboard is read-only: do not add website-specific files or claim that opening the website proves a task is complete.

## Common mistakes

- Giving a generic roadmap after hearing only the topic and claimed level
- Dumping all quiz questions instead of waiting after one question
- Revealing an answer before the learner attempts active recall
- Ending a Feynman loop after correction without asking for a cleaner re-explanation
- Re-teaching everything instead of only the demonstrated gaps
- Treating a 20-hour plan as a promise of mastery rather than a high-leverage first pass
- Recommending plausible-looking resources without live verification
- Recreating or overwriting a journal instead of merging with its recorded state
- **Accepting self-reported mastery without evidence** (core principle)
- **Letting AI modify files without user confirmation** (safety principle)
- **Exposing API keys to frontend or logs** (security principle)

## Competition Evidence

For the 2026 Mobile Cloud Cup AI Coding Competition, this project demonstrates:
- AI-powered learning diagnosis with evidence tracking
- Skill/MCP integration for IDE reuse
- Local-first architecture with cloud AI augmentation
- Atomic file operations with conflict detection
