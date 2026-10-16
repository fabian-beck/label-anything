#!/usr/bin/env python3
"""Reference cross-check: validate every conformance problem with the JSON Schema itself.

Uses the `jsonschema` package (Draft 2020-12) as an independent validator and checks
that (a) every file in problems/ is schema-valid, and (b) every validate/ case's
expected `valid` flag agrees with the schema for schema-level errors (cases whose
expected errors are purely semantic — duplicate_id, unknown_ref, expr_*, unsupported,
required at /canvas — are only checked to be schema-valid, or schema-invalid for
`unsupported`). Run: python3 conformance/check_schema.py
"""
import json
import sys
from pathlib import Path

import jsonschema

ROOT = Path(__file__).resolve().parent
SCHEMA = json.loads((ROOT.parent / "spec/schema/problem.v1.json").read_text())
V = jsonschema.Draft202012Validator(SCHEMA)
SEMANTIC = {"duplicate_id", "unknown_ref", "expr_syntax", "expr_unknown_identifier", "expr_arity", "invalid_value"}


def schema_valid(p):
    return not any(True for _ in V.iter_errors(p))


def main():
    failures = 0
    for f in sorted((ROOT / "problems").glob("*.json")):
        errs = list(V.iter_errors(json.loads(f.read_text())))
        if errs:
            failures += 1
            print(f"FAIL {f.name}: {errs[0].json_path}: {errs[0].message[:120]}")
    for f in sorted((ROOT / "validate").glob("*.json")):
        case = json.loads(f.read_text())
        problems = [case["problem"]] if "problem" in case else [
            json.loads((f.parent / p).read_text()) for p in case.get("problem_files", [case.get("problem_file")])]
        exp = case["expect"]
        codes = {e["code"] for e in exp.get("errors", [])}
        for p in problems:
            sv = schema_valid(p)
            if exp["valid"]:
                ok = sv
            elif codes <= SEMANTIC or codes == {"required"} and all(e["pointer"] == "/canvas" for e in exp["errors"]):
                ok = sv  # purely semantic error: schema must accept it
            else:
                ok = not sv
            if not ok:
                failures += 1
                print(f"FAIL {f.name}: schema says valid={sv}, case expects valid={exp['valid']} ({sorted(codes)})")
    print("schema cross-check:", "OK" if not failures else f"{failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
