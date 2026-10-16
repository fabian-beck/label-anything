"""Implementation-independent evaluator for Label Anything results.

    from bench.eval import evaluate, evaluate_files, evaluate_sequence
    metrics = evaluate(problem_dict, result_dict, truth_dict_or_None)

CLI: ``python -m bench.eval problem.json result.json [--truth truth.json]``
(see ``python -m bench.eval --help``).
"""
from .metrics import TOL, evaluate, evaluate_files, summary  # noqa: F401
from .stability import evaluate_sequence  # noqa: F401
