"""Offline unit tests for the canonical (month-anchored) deep-cache window.

Verifies ``app.config.canonical_max_lookback_days`` for several fixed "today"
values WITHOUT touching synthetic data source/sign-in (config import is offline and ``today`` is
injected). Run from the backend dir:

    ./venv/bin/python tests/test_canonical_window.py

It also works under pytest (``pytest tests/test_canonical_window.py``) if that
is installed, but needs no third-party deps to run as a plain script.
"""
import sys
from datetime import date, timedelta
from pathlib import Path

# Make `app` importable when run as a plain script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import canonical_max_lookback_days, get_settings  # noqa: E402


def _expected_start(today: date, months: int) -> date:
    """Independent reference for the month-anchored start: the first day of the
    month ``months`` before ``today``'s month, with year borrow."""
    year, month = today.year, today.month - months
    while month <= 0:
        month += 12
        year -= 1
    return date(year, month, 1)


def _check(today: date, expect_start: date, expect_days: int) -> None:
    got = canonical_max_lookback_days(today)
    start = today - timedelta(days=got)
    assert start == expect_start, f"{today}: start {start} != {expect_start}"
    assert start.day == 1, f"{today}: start {start} is not month-anchored"
    assert got == expect_days, f"{today}: days {got} != {expect_days}"
    print(f"  OK {today} -> {got}d, start {start}")


def test_documented_cases():
    """The exact cases from the spec (assume the default 6 complete months)."""
    months = get_settings().canonical_complete_months
    assert months == 6, (
        f"these fixtures assume canonical_complete_months=6 (got {months}); "
        "restore the default or update the expectations"
    )
    # As of 2026-06-18: current month June, 6 complete months back -> Dec 2025.
    _check(date(2026, 6, 18), date(2025, 12, 1), 199)
    # 1st-of-month: the start STEPS forward a month vs. the day before it.
    _check(date(2026, 6, 30), date(2025, 12, 1), 211)
    _check(date(2026, 7, 1), date(2026, 1, 1), 181)
    # Year rollover: March 2026 -> 6 months back is September 2025.
    _check(date(2026, 3, 10), date(2025, 9, 1), 190)
    # Leap February handled (Feb 2028 has 29 days).
    _check(date(2028, 3, 1), date(2027, 9, 1), 182)


def test_matches_reference_over_a_year():
    """The helper equals an independent month-walk for every day of 2026."""
    months = get_settings().canonical_complete_months
    ceiling = get_settings().region_max_lookback_days
    d = date(2026, 1, 1)
    while d <= date(2026, 12, 31):
        start = _expected_start(d, months)
        expected = min((d - start).days, ceiling)
        got = canonical_max_lookback_days(d)
        assert got == expected, f"{d}: {got} != {expected}"
        d += timedelta(days=1)
    print("  OK reference match for all 365 days of 2026")


def test_ceiling_clamp():
    """The window is always clamped to region_max_lookback_days (defensive)."""
    ceiling = get_settings().region_max_lookback_days
    for d in [date(2026, 1, 31), date(2026, 7, 31), date(2027, 1, 31)]:
        assert canonical_max_lookback_days(d) <= ceiling
    print(f"  OK window always <= region_max_lookback_days ({ceiling})")


if __name__ == "__main__":
    failures = 0
    for fn in (
        test_documented_cases,
        test_matches_reference_over_a_year,
        test_ceiling_clamp,
    ):
        print(f"{fn.__name__}:")
        try:
            fn()
        except AssertionError as exc:
            failures += 1
            print(f"  FAIL {exc}")
    if failures:
        print(f"\n{failures} test(s) FAILED")
        sys.exit(1)
    print("\nAll canonical-window tests passed.")
