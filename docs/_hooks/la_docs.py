"""MkDocs hooks of the documentation site (registered in mkdocs.yml).

* The navigation section titled "Architecture decisions" lists every ``docs/adr/NNNN-*.md``
  (new ADRs appear without editing mkdocs.yml).
* ``<!-- la:adr-index -->`` on a page becomes a table of the ADRs (number, title, status).
* Links written as ``gh:path/in/the/repo`` point to that file on GitHub, at the tag being
  built (``GITHUB_REF_NAME`` on a ``v*`` tag) or at ``main``.
* The JSON Schemas and presets of ``spec/`` are published with the site, under
  ``schema/`` and ``presets/``.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from mkdocs.structure.files import File, Files

ROOT = Path(__file__).resolve().parents[2]
ADR_DIR = ROOT / "docs" / "adr"
REPO = "https://github.com/fabian-beck/label-anything"
ADR_SECTION = "Architecture decisions"


def _ref() -> str:
    ref = os.environ.get("GITHUB_REF_NAME", "")
    return ref if os.environ.get("GITHUB_REF_TYPE") == "tag" and ref.startswith("v") else "main"


def _adrs() -> list[tuple[str, str, str]]:
    """(file name, title, status) of every ADR, in number order."""
    out = []
    for p in sorted(ADR_DIR.glob("[0-9][0-9][0-9][0-9]-*.md")):
        text = p.read_text(encoding="utf-8")
        title = next((line[2:].strip() for line in text.splitlines() if line.startswith("# ")), p.stem)
        m = re.search(r"^\* Status: (.+)$", text, re.M)
        out.append((p.name, title, m.group(1).strip() if m else ""))
    return out


def on_config(config):
    def fill(entries: list) -> None:
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            for title, value in entry.items():
                if not isinstance(value, list):
                    continue
                if title == ADR_SECTION:
                    listed = {v if isinstance(v, str) else next(iter(v.values())) for v in value}
                    for name, adr_title, _ in _adrs():
                        if f"adr/{name}" not in listed:
                            value.append({adr_title: f"adr/{name}"})
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


def _adr_table() -> str:
    rows = ["| ADR | Decision | Status |", "|---|---|---|"]
    for name, title, status in _adrs():
        num, _, rest = title.partition(" — ")
        rows.append(f"| {num} | [{rest or title}](../adr/{name}) | {status} |")
    return "\n".join(rows)


GH_LINK = re.compile(r"\]\(gh:([^)\s]*)\)")


def on_page_markdown(markdown: str, page, config, files) -> str:
    if "<!-- la:adr-index -->" in markdown:
        markdown = markdown.replace("<!-- la:adr-index -->", _adr_table())
    ref = _ref()
    return GH_LINK.sub(lambda m: f"]({REPO}/blob/{ref}/{m.group(1)})", markdown)
