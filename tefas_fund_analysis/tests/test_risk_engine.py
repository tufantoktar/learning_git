from datetime import date, timedelta

import pandas as pd
import pytest

from tefas_analysis.analysis.risk_engine import RiskEngine


def make_prices(values):
    start = date(2026, 1, 1)
    return pd.DataFrame(
        {
            "date": [start + timedelta(days=index) for index in range(len(values))],
            "price": values,
        }
    )


def test_risk_engine_calculates_max_drawdown():
    metrics = RiskEngine().calculate("TCD", make_prices([100, 120, 90, 95]))

    assert metrics.max_drawdown_90 == pytest.approx(-0.25)
    assert metrics.risk_score > 0


def test_choppy_series_has_higher_risk_than_stable_series():
    stable = RiskEngine().calculate("AAA", make_prices([100 + index for index in range(40)]))
    choppy = RiskEngine().calculate(
        "BBB",
        make_prices([100, 130, 90, 125, 85, 135, 80, 140, 82, 138, 84, 136]),
    )

    assert choppy.risk_score > stable.risk_score
    assert choppy.volatility_30 is not None
