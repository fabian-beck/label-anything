# 0051 — ADR format, metadata and scope

* Status: accepted
* Date: 2026-10-24
* Area: Project
* Affects: every ADR's title and metadata, the ADR index (`docs/_hooks/la_docs.py`),
  `CONTRIBUTING.md`
* Amends: [ADR 0001](0001-record-architecture-decisions.md)

## Context
ADR 0001 asked for lightweight ADRs with Context, Decision and Consequences and said
little more. Fifty ADRs later, written within three days on parallel branches, the log
was hard to browse:

* **Status lines carried everything:** the status, spec sections, packages, the kind of
  change and later amendments, in up to 140 characters or over two lines. The index
  shows the first line only, so it cut six of them short.
* **Amendments were noted on one side or not at all.** ADR 0007 named its amendment by
  0042 but not the one by 0048; 0040 did not name 0045, 0042 not 0048, and 0019 named
  0029 but neither 0022 nor 0030, which changed its leader rules.
* **Titles ran up to 111 characters**, some naming three decisions, and the navigation
  lists them in full.
* **The sections varied.** Two ADRs had no Context, one no Consequences; rejected
  alternatives sat in the Context or in the Decision, under several different lead-ins.
* **Two ADRs had the number 0049.** Parallel branches had picked the same next number at
  least six times before, and each time one renumbered its ADR by hand; this time it
  slipped through a merge.
* **The log had outgrown 0001's list** (open points of the brief, deviations from it,
  performance changes, accepted metric regressions): it also records new behaviour and
  options, the JavaScript helpers, the benchmark's scenes, the documentation site and the
  name. Nothing grouped them, so finding the decisions about one part of the engine meant
  opening all of them.
* `docs/dev/porting.md` cited ADR 0001 for "Rust first, then the port", a rule of the
  contributing guide.

## Decision
**One template.** An ADR is `docs/adr/NNNN-slug.md`:

```markdown
# NNNN — The decision, as a short statement

* Status: proposed
* Date: YYYY-MM-DD
* Area: one of the areas below
* Affects: spec sections, packages, files; the kind of change where it is not obvious
* Amends: [ADR NNNN](NNNN-slug.md) (the part it changes)

## Context
The problem and the forces at play, as facts: what was observed or measured.

## Decision
What we do, stated directly.

## Alternatives considered
What else was tried or weighed, each with why it lost.

## Consequences
What follows, good and bad, measured where possible.
```

* **Title**: the decision, at most about 70 characters. The file name is the identifier
  and stays when a title is reworded.
* **Status**: `proposed`, `accepted`, `rejected`, `deprecated` or `superseded`, and
  nothing else in that line.
* **Area**, which groups the index: *Project* (process, names, positioning); *Packages and
  formats* (crates, packages, the problem format, validation); *Obstacles and
  backgrounds* (coverage grids, hard constraints, SVG and raster backgrounds); *Text*
  (fonts, measuring, line breaking); *Candidates, leaders and costs*; *Priority* (the key,
  omission, the priority repair, font classes); *Solver* (determinism, budgets, search,
  performance); *Warm starts and transitions* (stability between solves, motion in the
  helpers); *Benchmark*; *Documentation site*.
* **Affects** (optional): what the decision touches, and "performance; no behaviour
  change" or "not an engine change" where that is the case.
* **Amends / Amended by, Supersedes / Superseded by** (optional): links, in both ADRs. An
  ADR that changes part of an earlier decision amends it; one that replaces it supersedes
  it, and the earlier one's status becomes `superseded`.
* *Alternatives considered* is optional; measurements that compare alternatives belong
  there, not in the Context. One decision per ADR, on about two printed pages.

**Merged ADRs are not rewritten.** While its pull request is open an ADR may change
freely; once merged, a change of mind is a new ADR that amends or supersedes it. The
earlier ADR then receives only the back-link (and its new status when superseded); typos
and broken links are fixed in place.

**What needs an ADR** (replacing 0001's list):

* an open point of the brief we decide, or a deviation from the brief or the spec;
* a change of results, of the problem or result format, of an option or its default, or
  of a public API, in the engine or in the helpers;
* a performance change, with a profile note;
* a benchmark-metric regression of more than 2 % that the release gate accepts
  (`bench/gates-allow.json` names the ADR);
* a lasting decision about the project around the engine: names, the benchmark's scenes
  and methods, the documentation site.

Bug fixes that restore the specified behaviour, and refactorings, need none.

**Numbering.** An ADR takes the next free number when its pull request is merged; when
main has taken that number meanwhile, the branch renumbers its ADR: the file, the title
and every citation.

**The build checks it.** `docs/_hooks/la_docs.py` warns, which fails
`mkdocs build --strict`, when two ADRs share a number, a title does not start with its
file's number, the status, area or date is missing or not one of the above, a `superseded`
ADR names no successor, or an amendment or supersession lacks its back-link. It groups the
index by area and links the mentions of "ADR NNNN" on the site's pages to the ADRs.

**This cleanup changed the presentation only:**

* The home page's ADR, the second 0049, is now 0050. The priority repair keeps 0049,
  although it was merged later: the spec, both cores and their tests, the gallery and two
  pages cite it; the home page's ADR, one page and a README.
* The status lines became the fields above. Their spec sections and packages are now
  *Affects*. The 19 amendments between earlier ADRs now link both ways; the status lines
  had 14 of these 38 links.
* Ten titles were shortened or reworded (0015, 0016, 0018, 0019, 0032, 0034, 0035, 0041,
  0047, 0050). File names stay, except the renumbered one.
* Alternatives moved under their own heading, out of the Decision or, in 0049, the
  Context; their lead-ins became that heading. 0050's Decision got a heading for each of
  its two parts.
* 0010 and 0012 got a Context, and 0010 its Consequences, restating what their Decision
  already says.
* `docs/dev/porting.md` cites the contributing guide instead of ADR 0001.

No decision, measurement or rationale changed: the old and new texts, compared word by
word, differ only in those lead-ins, the headings and the three new sections.

## Alternatives considered
* *YAML front matter*, as in MADR: GitHub shows it as a table, but MkDocs drops it from
  the page, so the site would lose the status unless the hook rendered it again. The list
  reads the same on GitHub, on the site and in an editor.
* *Splitting the ADRs that bundle several decisions* (0019, 0033, 0034, 0047, 0050):
  new numbers for old decisions, which the code, the spec and the release gate cite by
  number. Their titles say that they bundle.
* *Moving the ADRs that are not about the engine out of the log* (the name, the gallery,
  the documentation site): they are decisions with reasons and measurements like the
  others, and the release gate cites benchmark ADRs (0024). Their area sets them apart.
* *Renaming the files to the new titles*: every ADR page of the published site would
  move, and links to them from outside would break, for no reader's gain.
* *Renumbering the priority repair's 0049*: see above.

## Consequences
The index lists the ADRs by area, each with its status and amendments, and the navigation
shows short titles. A reader of an older ADR sees which later ones changed it, and on the
site the ADRs' mentions of each other are links. The build catches a reused number at the
latest on main, and on a pull request whose CI runs against a main that has taken the
number. New ADRs take a little more care: an area, and a back-link in every ADR they
amend. The home page's ADR moves on the site, from `adr/0049-home-page-header-labeled-live/`
to its new number.
