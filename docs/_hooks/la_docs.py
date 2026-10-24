"""MkDocs hooks of the documentation site (registered in mkdocs.yml).

* The navigation section titled "Architecture decisions" lists every ``docs/adr/NNNN-*.md``
  (new ADRs appear without editing mkdocs.yml).
* ``<!-- la:adr-index -->`` on a page becomes the ADR index: a table per area (number,
  title, status and amendments).
* The ADRs' numbers and metadata are checked (ADR 0051): a reused number, a title without
  its file's number, a status, area or date outside the lists, or an amendment or
  supersession without its back-link is a warning, which fails ``mkdocs build --strict``.
* "ADR NNNN" in a page's text becomes a link to that ADR (not in code or existing links).
* Links written as ``gh:path/in/the/repo`` point to that file on GitHub, at the tag being
  built (``LA_DOCS_TAG``, set by the Pages workflow, or ``GITHUB_REF_NAME`` on a ``v*``
  tag) or at ``main``.
* The JSON Schemas and presets of ``spec/`` are published with the site, under
  ``schema/`` and ``presets/``.
"""

from __future__ import annotations

import os
import posixpath
import re
from dataclasses import dataclass
from pathlib import Path

from mkdocs.plugins import get_plugin_logger
from mkdocs.structure.files import File, Files

ROOT = Path(__file__).resolve().parents[2]
ADR_DIR = ROOT / "docs" / "adr"
REPO = "https://github.com/fabian-beck/label-anything"
ADR_SECTION = "Architecture decisions"

# ADR 0051: the statuses, and the areas in the order of the index.
STATUSES = ("proposed", "accepted", "rejected", "deprecated", "superseded")
AREAS = (
    "Project",
    "Packages and formats",
    "Obstacles and backgrounds",
    "Text",
    "Candidates, leaders and costs",
    "Priority",
    "Solver",
    "Warm starts and transitions",
    "Benchmark",
    "Documentation site",
)
BACK_LINK = {
    "Amends": "Amended by",
    "Amended by": "Amends",
    "Supersedes": "Superseded by",
    "Superseded by": "Supersedes",
}

log = get_plugin_logger(__name__)


def _ref() -> str:
    tag = os.environ.get("LA_DOCS_TAG", "")
    if tag.startswith("v"):
        return tag
    ref = os.environ.get("GITHUB_REF_NAME", "")
    return ref if os.environ.get("GITHUB_REF_TYPE") == "tag" and ref.startswith("v") else "main"


@dataclass
class Adr:
    name: str  # file name; its first four digits are the number
    heading: str  # the title line without "# "
    fields: dict[str, str]  # "* Field: value" lines before the first section

    @property
    def number(self) -> str:
        return self.name[:4]

    @property
    def title(self) -> str:
        return self.heading.partition(" — ")[2]

    def refs(self, field: str) -> list[str]:
        return re.findall(r"ADR (\d{4})", self.fields.get(field, ""))


FIELD = re.compile(r"^\* ([A-Z][a-z]*(?: [a-z]+)?): (.*(?:\n  .*)*)", re.M)
_adr_cache: list[Adr] = []


def _adrs() -> list[Adr]:
    """Every ADR, in number order (read once per build, in on_config)."""
    if not _adr_cache:
        for p in sorted(ADR_DIR.glob("[0-9][0-9][0-9][0-9]-*.md")):
            text = p.read_text(encoding="utf-8")
            heading = next((line[2:].strip() for line in text.splitlines() if line.startswith("# ")), p.stem)
            head = text.partition("\n## ")[0]
            fields = {k: " ".join(v.split()) for k, v in FIELD.findall(head)}
            _adr_cache.append(Adr(p.name, heading, fields))
    return _adr_cache


def _check(adrs: list[Adr]) -> list[str]:
    """What breaks the rules of ADR 0051, one message per problem."""
    problems = []
    by_number: dict[str, Adr] = {}
    for a in adrs:
        where = f"docs/adr/{a.name}"
        if a.number in by_number:
            problems.append(f"{where}: number {a.number} is taken by {by_number[a.number].name}")
        by_number.setdefault(a.number, a)
        if not a.heading.startswith(f"{a.number} — ") or not a.title:
            problems.append(f"{where}: the title must read '# {a.number} — …'")
        status = a.fields.get("Status", "")
        if status not in STATUSES:
            problems.append(f"{where}: Status must be one of {', '.join(STATUSES)}, not {status!r}")
        if a.fields.get("Area") not in AREAS:
            problems.append(f"{where}: Area must be one of {', '.join(AREAS)}")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", a.fields.get("Date", "")):
            problems.append(f"{where}: Date must be YYYY-MM-DD")
        if (status == "superseded") != bool(a.refs("Superseded by")):
            problems.append(f"{where}: an ADR is superseded exactly when it names a 'Superseded by'")
    for a in adrs:
        for field, back in BACK_LINK.items():
            for n in a.refs(field):
                other = by_number.get(n)
                if other is None:
                    problems.append(f"docs/adr/{a.name}: {field} names ADR {n}, which does not exist")
                elif a.number not in other.refs(back):
                    problems.append(f"docs/adr/{other.name}: '{back}' must name ADR {a.number} ({field} of {a.name})")
    return problems


def on_config(config):
    _adr_cache.clear()
    for problem in _check(_adrs()):
        log.warning(problem)

    def fill(entries: list) -> None:
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            for title, value in entry.items():
                if not isinstance(value, list):
                    continue
                if title == ADR_SECTION:
                    listed = {v if isinstance(v, str) else next(iter(v.values())) for v in value}
                    for a in _adrs():
                        if f"adr/{a.name}" not in listed:
                            value.append({a.heading: f"adr/{a.name}"})
                else:
                    fill(value)

    fill(config.nav or [])
    return config


def on_files(files: Files, config) -> Files:
    published = [(f"schema/{p.name}", p) for p in sorted((ROOT / "spec" / "schema").glob("*.json"))]
    published += [(f"presets/{p.name}", p) for p in sorted((ROOT / "spec" / "presets").glob("*.json"))]
    for uri, src in published:
        files.append(File.generated(config, uri, abs_src_path=str(src)))
    return files


def _adr_index() -> str:
    adrs = _adrs()
    names = {a.number: a.name for a in reversed(adrs)}

    def links(numbers: list[str]) -> str:
        return ", ".join(f"[{n}](../adr/{names[n]})" if n in names else n for n in numbers)

    out = []
    for area in AREAS:
        rows = [a for a in adrs if a.fields.get("Area") == area]
        if not rows:
            continue
        out += [f"## {area}", "", "| ADR | Decision | Status |", "|---|---|---|"]
        for a in rows:
            status = a.fields.get("Status", "")
            if a.refs("Superseded by"):
                status = "superseded by " + links(a.refs("Superseded by"))
            if a.refs("Amended by"):
                status += "; amended by " + links(a.refs("Amended by"))
            title = a.title.replace("|", r"\|")
            out.append(f"| {a.number} | [{title}](../adr/{a.name}) | {status} |")
        out.append("")
    return "\n".join(out)


GH_LINK = re.compile(r"\]\(gh:([^)\s]*)\)")
# Code blocks, code spans and links, in which "ADR NNNN" stays as it is.
PROTECTED = re.compile(r"^[ \t]*(```|~~~).*?^[ \t]*\1[^\n]*$|`[^`]+`|\[[^\]]*\]\([^)]*\)", re.M | re.S)
ADR_MENTION = re.compile(r"\bADR (\d{4})\b")


def _link_adrs(markdown: str, src_uri: str) -> str:
    names = {a.number: a.name for a in reversed(_adrs())}
    here = posixpath.dirname(src_uri) or "."

    def link(m: re.Match) -> str:
        name = names.get(m.group(1))
        return f"[{m.group(0)}]({posixpath.relpath(f'adr/{name}', here)})" if name else m.group(0)

    out, pos = [], 0
    for m in PROTECTED.finditer(markdown):
        out += [ADR_MENTION.sub(link, markdown[pos : m.start()]), m.group(0)]
        pos = m.end()
    out.append(ADR_MENTION.sub(link, markdown[pos:]))
    return "".join(out)


def on_page_markdown(markdown: str, page, config, files) -> str:
    if "<!-- la:adr-index -->" in markdown:
        markdown = markdown.replace("<!-- la:adr-index -->", _adr_index())
    markdown = _link_adrs(markdown, page.file.src_uri)
    ref = _ref()
    return GH_LINK.sub(lambda m: f"]({REPO}/blob/{ref}/{m.group(1)})", markdown)
