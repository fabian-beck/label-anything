# Decision records

Decisions are recorded as named records, one per topic, grouped in area folders and kept
current.

## Context
The log began as numbered ADRs that were never changed once written. In its first week it
grew to 51 records on parallel branches, which picked the same number at least six times;
once, two records landed as 0049. Half of the records amended earlier ones, so the current
state of a topic was spread over chains of them. Some were changelog entries or
measurement dumps rather than decisions, and nothing grouped them by subject.

## Decision
- **Names, not numbers.** A record is `docs/adr/<area>/<name>.md` and is cited as
  "ADR <area>/<name>". Branches need no coordination, and a citation says what it is
  about.
- **Areas**: `architecture` (packages, formats, validation), `text`, `obstacles`
  (backgrounds and how labels are tested against them), `placement` (where labels and
  leaders go and what that costs), `priority`, `solver`, `motion` (stability between
  solves) and `project` (how the project itself works).
- **One record per topic, kept current.** When a decision changes, its record is rewritten
  to the new state with the reasons; git keeps the earlier text. An idea that was tried
  and rejected goes under *Alternatives* of its topic.
- **Format**: a short title; one sentence that states the decision; *Context*, the problem
  as facts; *Decision*; *Consequences*, good and bad; optionally *Alternatives*, each with
  why it lost. About a page. Numbers are as measured when the decision was made, and only
  those that justify it.
- **When**: deciding an open point of the brief or deviating from it; changing results,
  formats, options, defaults or public APIs; a design change for performance; accepting a
  benchmark regression in the release gate (`bench/gates-allow.json` names the record);
  lasting decisions about the project. Bug fixes and refactorings need none, and a
  performance change that changes no design needs only a profile note in its pull request.
- The documentation build lists the records by area and fails on a citation that names no
  record.

## Consequences
A reader finds the current decision on a topic in one place, with its reasons, and history
in git. Renaming or moving a record breaks its citations, which the build reports. Commit
messages from before this change cite the numbered records, which git history keeps.

## Alternatives
- **Numbered records that never change**, as in adr-tools: they collide on parallel
  branches and spread a topic over chains of amendments.
- **Numbers assigned late**, such as the pull request's, as Rust RFCs do: unique, but one
  pull request often decides several things, and a record is cited in code before its pull
  request exists.
- **Names with a date prefix**, as log4brains allows: ordered by date, which readers of a
  topic do not need.
