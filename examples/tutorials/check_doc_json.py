"""Check the JSON examples written directly in the docs (```json blocks in docs/**/*.md).

    python3 examples/tutorials/check_doc_json.py [--cli rust/target/release/label-anything]

Blocks that include a file (``--8<--``) are skipped: the included files are tested by
run.py. Every other block must be valid JSON and is validated against the JSON Schema
(Draft 2020-12, ``pip install jsonschema``):

* a result (``placements``) against ``result.v1.json``;
* a validation report (``valid``, ``errors``, ``warnings``) for its shape;
* a problem, or a fragment of one (top-level problem keys only), against
  ``problem.v1.json``: fragments are completed with a minimal item;
* anything else only has to parse.

With ``--cli``, problems and fragments are also validated by the engine
(``label-anything validate``), which checks what a schema cannot (expressions, ids,
classes) — warnings are allowed.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
BLOCK = re.compile(r"^(?P<indent>[ \t]*)```json[^\n]*\n(?P<body>.*?)^(?P=indent)```", re.M | re.S)
MINIMAL_ITEM = {"anchor": {"type": "point", "x": 10, "y": 10}, "label": {"type": "text", "text": "A"}}


def blocks() -> list[tuple[Path, int, str]]:
    out = []
    for md in sorted(DOCS.rglob("*.md")):
        text = md.read_text(encoding="utf-8")
        for m in BLOCK.finditer(text):
            body = m.group("body")
            if "--8<--" in body:
                continue
            indent = m.group("indent")
            body = "\n".join(line[len(indent):] if line.startswith(indent) else line for line in body.splitlines())
            out.append((md.relative_to(ROOT), text[: m.start()].count("\n") + 1, body))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--cli", help="label-anything executable for semantic validation")
    args = ap.parse_args()
    from jsonschema import Draft202012Validator

    problem_schema = Draft202012Validator(json.loads((ROOT / "spec/schema/problem.v1.json").read_text()))
    result_schema = Draft202012Validator(json.loads((ROOT / "spec/schema/result.v1.json").read_text()))
    problem_keys = set(json.loads((ROOT / "spec/schema/problem.v1.json").read_text())["properties"])
    failures = []
    count = 0
    for path, line, body in blocks():
        where = f"{path}:{line}"
        count += 1
        try:
            obj: Any = json.loads(body)
        except json.JSONDecodeError as e:
            failures.append(f"{where}: not JSON: {e}")
            continue
        if not isinstance(obj, dict):
            failures.append(f"{where}: not a JSON object")
            continue
        if "placements" in obj:
            errors = [f"{'/'.join(map(str, e.absolute_path))}: {e.message}" for e in result_schema.iter_errors(obj)]
            kind = "result"
        elif set(obj) == {"valid", "errors", "warnings"}:
            issues = obj["errors"] + obj["warnings"]
            errors = [f"issue {i}" for i in issues if set(i) != {"pointer", "code", "message"}]
            kind = "report"
        elif set(obj) <= problem_keys:
            problem = obj if "items" in obj else {**obj, "items": [MINIMAL_ITEM]}
            errors = [f"{'/'.join(map(str, e.absolute_path))}: {e.message}" for e in problem_schema.iter_errors(problem)]
            kind = "problem" if "items" in obj else "fragment"
            if not errors and args.cli:
                with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                    json.dump(problem, f)
                p = subprocess.run([args.cli, "validate", f.name], capture_output=True, text=True)
                Path(f.name).unlink()
                if p.returncode != 0:
                    errors.append(p.stderr.strip())
        else:
            errors, kind = [], "other JSON"     # e.g. bench/gates-allow.json: parsed only
        if errors:
            failures.append(f"{where} ({kind}): " + "; ".join(errors[:5]))
        else:
            print(f"ok {where} ({kind})")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"{count} JSON blocks in docs/ are valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
