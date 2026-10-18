# Literature search notes (2026-10-18)

The working notes behind [Literature and improvement notes](../literature.md): one file
per topic, one section per source. They are kept as the provenance record of that page and
are not published on the documentation site (`exclude_docs` in `mkdocs.yml`).

| File | Topic |
|---|---|
| `00-brief.md` | the brief every search started from: the engine, its known weaknesses, the provenance rules |
| `a-optimization.md` | combinatorial optimization for point-feature label placement: independent sets, exact and Lagrangean methods, metaheuristics, learning-based work, benchmark instances |
| `b-dynamic-labeling.md` | dynamic, interactive and temporally coherent labeling: zoom consistency, moving points, web map engines |
| `c-leaders.md` | external labeling with leaders: boundary, contour and excentric labeling, readability studies, line-end labels |
| `d-quality-and-speed.md` | cartographic quality criteria, perception studies, fast placement and free-space tests |
| `e-provenance-of-building-blocks.md` | the original sources of the algorithms already in the code, with code locations and deviations |

## How they were made

An AI coding assistant (Claude Code) ran five searches in parallel on 2026-10-18, one per
topic, each from `00-brief.md`, and read the repository (read-only) to relate the sources
to the code. The coordinating session wrote the page from these notes and checked the
claims about the code against the source.

Limits that apply to every entry:

* **No full texts.** The environment could not open publisher, DOI, DBLP or arXiv pages
  (DNS failures); only a web search tool worked, plus GitHub. "What I read" is therefore
  at most an abstract or a record as quoted in search results; GitHub code and wiki pages
  were read in full.
* **Verification levels.** `VERIFIED-SEARCH`: the bibliographic data (authors, venue,
  volume, pages, DOI) appeared in search results citing a publisher, DBLP, repository or
  indexing record, which was not opened. `PARTIAL`: some fields are confirmed only by a
  citing paper or are missing (the entry says which). `UNVERIFIED`: from memory, not
  checked; such entries are marked and must be checked before they are cited.
* **Search budget.** The searches shared a budget of 200 web searches; it ran out before
  every check was done. Each file ends with its open items.
* Statements marked *interpretation* (or "my reading", "from memory") are the assistant's,
  not the source's.

Before citing a source from these notes in a paper, an ADR or `CITATION.cff`, open it and
check the citation and the claim.
