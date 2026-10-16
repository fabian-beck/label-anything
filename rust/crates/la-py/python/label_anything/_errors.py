"""Exceptions raised by Label Anything."""

from __future__ import annotations

from typing import Any, List, Optional, Sequence, Tuple

from ._types import Issue


def _issue(d: Any) -> Issue:
    return Issue(
        pointer=str(d.get("pointer", "")),
        code=str(d.get("code", "")),
        message=str(d.get("message", "")),
    )


class LabelAnythingError(Exception):
    """Base class of the exceptions raised by Label Anything."""


class ValidationError(LabelAnythingError, ValueError):
    """The problem is invalid.

    ``errors`` (and ``warnings``) are lists of ``{pointer, code, message}`` dicts; the
    pointers are RFC 6901 JSON Pointers into the problem, e.g. ``/items/3/anchor/y``.
    """

    errors: List[Issue]
    warnings: List[Issue]

    def __init__(
        self,
        message: str,
        errors: Optional[Sequence[Any]] = None,
        warnings: Optional[Sequence[Any]] = None,
    ) -> None:
        super().__init__(message)
        self.errors = [_issue(e) for e in errors or ()]
        self.warnings = [_issue(w) for w in warnings or ()]

    @classmethod
    def single(cls, pointer: str, code: str, message: str) -> ValidationError:
        """An error with one issue."""
        at = pointer or "/"
        return cls(
            f"invalid problem: {at}: {message} ({code})",
            [Issue(pointer=pointer, code=code, message=message)],
        )

    def __str__(self) -> str:
        head = str(self.args[0]) if self.args else "invalid problem"
        if len(self.errors) <= 1:
            return head
        lines = [head]
        for e in self.errors[:10]:
            lines.append(f"  {e['pointer'] or '/'}: {e['message']} ({e['code']})")
        if len(self.errors) > 10:
            lines.append(f"  ... {len(self.errors) - 10} more")
        return "\n".join(lines)

    def __reduce__(self) -> Tuple[Any, ...]:
        return (type(self), (self.args[0] if self.args else "", self.errors, self.warnings))


class Cancelled(LabelAnythingError):
    """The solve was stopped through its ``cancelled`` token or callable."""
