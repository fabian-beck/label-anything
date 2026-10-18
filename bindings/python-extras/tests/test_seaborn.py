"""label_points for axes-level seaborn plots."""

from __future__ import annotations

import pytest

np = pytest.importorskip("numpy")
pd = pytest.importorskip("pandas")
sns = pytest.importorskip("seaborn")
import matplotlib  # noqa: E402

matplotlib.use("Agg")

import label_anything as la  # noqa: E402
from label_anything_extras.seaborn import label_points  # noqa: E402


def frame(n: int = 50) -> "pd.DataFrame":
    rng = np.random.default_rng(6)
    return pd.DataFrame(
        {
            "gdp": rng.lognormal(9, 1, n),
            "life": rng.normal(70, 6, n),
            "pop": rng.integers(1, 1000, n),
            "country": [f"Country {i}" for i in range(n)],
        }
    )


def test_columns_by_name() -> None:
    df = frame()
    ax = sns.scatterplot(data=df, x="gdp", y="life")
    ax.set_xscale("log")
    out = label_points(ax, data=df, x="gdp", y="life", label="country", attrs=["pop"], priority=la.Priority.attr("pop", "log1p"), max_labels=10)
    res = out.result
    assert res.stats["hard_violations"] == 0
    assert len(res.placed) == 10 and len(out.texts) == 10
    assert res.problem["items"][3]["attrs"] == {"pop": int(df["pop"][3])}
    # the highest populations are labeled first
    top = set(df["pop"].nlargest(3).index.astype(str))
    assert top <= {p.id for p in res.placed}


def test_priority_by_column_name() -> None:
    df = frame()
    ax = sns.scatterplot(data=df, x="gdp", y="life")
    out = label_points(ax, data=df, x="gdp", y="life", label="country", priority="pop", max_labels=10)
    # the column becomes an attribute without attrs=["pop"]
    assert out.result.problem["items"][3]["attrs"] == {"pop": int(df["pop"][3])}
    top = set(df["pop"].nlargest(3).index.astype(str))
    assert top <= {p.id for p in out.result.placed}
    both = label_points(ax, data=df, x="gdp", y="life", label="country", attrs=["life"], priority="pop", draw=False)
    assert both.result.problem["items"][0]["attrs"].keys() == {"life", "pop"}


def test_dates_on_the_x_axis() -> None:
    df = pd.DataFrame({"day": pd.date_range("2024-01-01", periods=20, freq="D"), "v": np.arange(20.0), "n": [f"d{i}" for i in range(20)]})
    ax = sns.scatterplot(data=df, x="day", y="v")
    out = label_points(ax, data=df, x="day", y="v", label="n")
    assert len(out.result.placed) > 10


def test_vectors_and_current_axes() -> None:
    df = frame(20)
    sns.regplot(data=df, x="gdp", y="life")
    out = label_points(data=None, x=df["gdp"].to_numpy(), y=df["life"].to_numpy(), label=df["country"])
    assert out.result.stats["placed"] > 0


def test_missing_column() -> None:
    df = frame(5)
    ax = sns.scatterplot(data=df, x="gdp", y="life")
    with pytest.raises(KeyError, match="nope"):
        label_points(ax, data=df, x="gdp", y="life", label="nope")


def test_shim_module() -> None:
    import label_anything.seaborn as shim

    assert shim.label_points is label_points
