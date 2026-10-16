"""Type stub of the extension module ``label_anything._native`` (rust/crates/la-py/src)."""

from typing import Any, Callable, Dict, Optional

__version__: str

class CancelToken:
    """A thread-safe cancellation flag, polled by the solver without the GIL."""

    def __init__(self) -> None: ...
    def cancel(self) -> None: ...
    def reset(self) -> None: ...
    @property
    def cancelled(self) -> bool: ...
    def is_set(self) -> bool: ...

def place_json(
    problem: str,
    *,
    rgba: Any = None,
    width: int = 0,
    height: int = 0,
    measure: Optional[Callable[..., Any]] = None,
    cost: Optional[Callable[..., Any]] = None,
    progress: Optional[Callable[[str, float], Any]] = None,
    cancelled: Any = None,
) -> str: ...
def validate_json(problem: str) -> str: ...
def render_svg(
    problem: str,
    result: str,
    *,
    rgba: Any = None,
    width: int = 0,
    height: int = 0,
) -> str: ...
def version() -> str: ...
def capabilities() -> Dict[str, Any]: ...
