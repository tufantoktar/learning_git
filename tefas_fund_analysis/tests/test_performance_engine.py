from datetime import date, timedelta

import pandas as pd
import pytest

from tefas_analysis.analysis.performance_engine import PerformanceEngine


def make_prices(values):
    start = date(2026, 1, 1)
    return pd.DataFrame(
        {
            "date": [start + timedelta(days=index) for index in range(len(values))],
            "price": values,
        }
    )


def test_performance_engine_calculates_returns_and_moving_averages():
    prices = make_prices([100 + index for index in range(70)])
    metrics = PerformanceEngine().calculate("abc", prices)

    assert metrics.fund_code == "ABC"
    assert metrics.latest_price == 169
    assert metrics.daily_return == pytest.approx((169 / 168) - 1)
    assert metrics.weekly_return == pytest.approx((169 / 164) - 1)
    assert metrics.monthly_return == pytest.approx((169 / 148) - 1)
    assert metrics.three_month_return == pytest.approx((169 / 106) - 1)
    assert metrics.moving_average_7 == pytest.approx(sum(range(163, 170)) / 7)
    assert metrics.moving_average_30 == pytest.approx(sum(range(140, 170)) / 30)
    assert metrics.momentum_score > 50


def test_performance_engine_returns_none_when_window_is_missing():
    prices = make_prices([100, 101, 102])
    metrics = PerformanceEngine().calculate("XYZ", prices)

    assert metrics.daily_return == pytest.approx((102 / 101) - 1)
    assert metrics.weekly_return is None
    assert metrics.monthly_return is None
    assert metrics.three_month_return is None
