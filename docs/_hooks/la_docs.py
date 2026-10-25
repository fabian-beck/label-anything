"""MkDocs hooks of the documentation site (registered in mkdocs.yml).

* Architecture decisions are ``docs/adr/<area>/<name>.md`` (ADR project/decision-records).
  The navigation section titled "Architecture decisions" lists them by area, and
  ``<!-- la:adr-index -->`` on a page becomes the list of them with their summaries.
* "ADR <area>/<name>" in a page's text links to that record. A record without its title,
  summary and sections, and a citation anywhere in the repository that names no record,
  is a warning, which fails ``mkdocs build --strict``.
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
import subprocess
from dataclasses import dataclass
from pathlib import Path

from mkdocs.plugins import get_plugin_logger
from mkdocs.structure.files import File, Files

ROOT = Path(__file__).resolve().parents[2]
ADR_DIR = ROOT / "docs" / "adr"
REPO = "https://github.com/fabian-beck/label-anything"
ADR_SECTION = "Architecture decisions"
# The areas of ADR project/decision-records, in the order of the navigation and the index.
AREAS = ("architecture", "text", "obstacles", "placement", "priority", "solver", "motion", "project")
SECTIONS = ("## Context", "## Decision", "## Consequences")
CITATION = re.compile(r"\bADR\s+([a-z]+/[a-z0-9-]+)")
# Code blocks, code spans and links, in which a citation stays as it is.
PROTECTED = re.compile(r"^[ \t]*(```|~~~).*?^[ \t]*\1[^\n]*$|`[^`]+`|\[[^\]]*\]\([^)]*\)", re.M | re.S)
# Files of the repository searched for citations.
SOURCES = {".md", ".rs", ".ts", ".mjs", ".js", ".py", ".json", ".toml", ".yml", ".html"}

log = get_plugin_logger(__name__)


@dataclass
class Adr:
    id: str  # "<area>/<name>"
    title: str
    summary: str

    @property
    def area(self) -> str:
        return self.id.partition("/")[0]


_adrs: list[Adr] = []


def _ref() -> str:
    tag = os.environ.get("LA_DOCS_TAG", "")
    if tag.startswith("v"):
        return tag
    ref = os.environ.get("GITHUB_REF_NAME", "")
    return ref if os.environ.get("GITHUB_REF_TYPE") == "tag" and ref.startswith("v") else "main"


def _load_adrs() -> None:
    """Read every record, by area and title, and warn about those out of form."""
    _adrs.clear()
    for p in sorted(ADR_DIR.rglob("*.md")):
        adr_id = p.relative_to(ADR_DIR).with_suffix("").as_posix()
        if adr_id.partition("/")[0] not in AREAS or adr_id.count("/") != 1:
            log.warning(f"docs/adr/{adr_id}.md: records are docs/adr/<area>/<name>.md, areas {', '.join(AREAS)}")
            continue
        text = p.read_text(encoding="utf-8")
        head = re.match(r"# (.+)\n\n((?:[^#\n].*\n)+)\n", text)
        found = [text.find(f"\n{s}\n") for s in SECTIONS]
        if not head or -1 in found or found != sorted(found):
            log.warning(f"docs/adr/{adr_id}.md: needs a '# title', a summary and the sections {', '.join(SECTIONS)}")
            continue
        _adrs.append(Adr(adr_id, head.group(1), " ".join(head.group(2).split())))
    _adrs.sort(key=lambda a: (AREAS.index(a.area), a.title))


def _check_citations() -> None:
    """Warn about every "ADR <area>/<name>" in the repository that names no record."""
    try:
        listed = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout.splitlines()
    except (OSError, subprocess.CalledProcessError):
        return  # not a git checkout
    known = {a.id for a in _adrs}
    for name in listed:
        p = ROOT / name
        if p.suffix not in SOURCES or not p.is_file() or p.stat().st_size > 1_000_000:
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        for m in CITATION.finditer(text):
            if m.group(1) not in known:
                line = text.count("\n", 0, m.start()) + 1
                log.warning(f"{name}:{line}: ADR {m.group(1)} does not exist")


def on_config(config):
    _load_adrs()
    _check_citations()

    def fill(entries: list) -> None:
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            for title, value in entry.items():
                if not isinstance(value, list):
                    continue
                if title == ADR_SECTION:
                    for area in AREAS:
                        pages = [{a.title: f"adr/{a.id}.md"} for a in _adrs if a.area == area]
                        if pages:
                            value.append({area.capitalize(): pages})
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


def _adr_index(src_uri: str) -> str:
    here = posixpath.dirname(src_uri) or "."
    out = []
    for area in AREAS:
        rows = [a for a in _adrs if a.area == area]
        if rows:
            out += [f"## {area.capitalize()}", ""]
            out += [f"* [{a.title}]({posixpath.relpath(f'adr/{a.id}.md', here)}) — {a.summary}" for a in rows]
            out.append("")
    return "\n".join(out)


def _link_adrs(markdown: str, src_uri: str) -> str:
    known = {a.id for a in _adrs}
    here = posixpath.dirname(src_uri) or "."

    def link(m: re.Match) -> str:
        if m.group(1) not in known:
            return m.group(0)
        return f"[{m.group(0)}]({posixpath.relpath(f'adr/{m.group(1)}.md', here)})"

    out, pos = [], 0
    for m in PROTECTED.finditer(markdown):
        out += [CITATION.sub(link, markdown[pos : m.start()]), m.group(0)]
        pos = m.end()
    out.append(CITATION.sub(link, markdown[pos:]))
    return "".join(out)


GH_LINK = re.compile(r"\]\(gh:([^)\s]*)\)")


def on_page_markdown(markdown: str, page, config, files) -> str:
    if "<!-- la:adr-index -->" in markdown:
        markdown = markdown.replace("<!-- la:adr-index -->", _adr_index(page.file.src_uri))
    markdown = _link_adrs(markdown, page.file.src_uri)
    ref = _ref()
    return GH_LINK.sub(lambda m: f"]({REPO}/blob/{ref}/{m.group(1)})", markdown)
