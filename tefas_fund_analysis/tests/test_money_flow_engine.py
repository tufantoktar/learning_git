from datetime import date, timedelta

import pytest

from tefas_analysis.analysis.money_flow_engine import MoneyFlowEngine
from tefas_analysis.schemas import FundPriceRecord, MoneyFlowLabel


def make_records(
    latest_price=11.0,
    latest_fund_size=1300.0,
    latest_investor_count=130.0,
    fund_size=1000.0,
    investor_count=100.0,
):
    start = date(2026, 1, 1)
    records = [
        FundPriceRecord(
            fund_code="AAA",
            date=start + timedelta(days=index),
            price=10.0,
            fund_size=fund_size,
            investor_count=investor_count,
        )
        for index in range(21)
    ]
    records.append(
        FundPriceRecord(
            fund_code="AAA",
            date=start + timedelta(days=21),
            price=latest_price,
            fund_size=latest_fund_size,
            investor_count=latest_investor_count,
        )
    )
    return records


def test_positive_estimated_net_flow_when_fund_size_beats_price_effect():
    metrics = MoneyFlowEngine().calculate("AAA", make_records())

    assert metrics.estimated_net_flow_1d == pytest.approx(200.0)
    assert metrics.estimated_net_flow_1w == pytest.approx(200.0)
    assert metrics.estimated_net_flow_1m == pytest.approx(200.0)
    assert metrics.money_flow_label == MoneyFlowLabel.STRONG_INFLOW


def test_negative_estimated_net_flow_when_size_falls_despite_positive_price_effect():
    metrics = MoneyFlowEngine().calculate(
        "AAA",
        make_records(latest_price=11.0, latest_fund_size=900.0, latest_investor_count=80.0),
    )

    assert metrics.estimated_net_flow_1d == pytest.approx(-200.0)
    assert metrics.estimated_net_flow_1w == pytest.approx(-200.0)
    assert metrics.estimated_net_flow_1m == pytest.approx(-200.0)
    assert metrics.money_flow_label == MoneyFlowLabel.STRONG_OUTFLOW


def test_unknown_flow_and_neutral_score_when_fund_size_missing():
    records = [
        FundPriceRecord(
            fund_code="AAA",
            date=date(2026, 1, 1) + timedelta(days=index),
            price=10.0 + index,
        )
        for index in range(22)
    ]

    metrics = MoneyFlowEngine().calculate("AAA", records)

    assert metrics.money_flow_score == 50.0
    assert metrics.money_flow_label == MoneyFlowLabel.UNKNOWN_FLOW
    assert metrics.estimated_net_flow_1d is None
    assert metrics.estimated_net_flow_1w is None
    assert metrics.estimated_net_flow_1m is None


def test_investor_count_increase_improves_score_slightly():
    neutral = MoneyFlowEngine().calculate(
        "AAA",
        make_records(latest_price=11.0, latest_fund_size=1100.0, latest_investor_count=100.0),
    )
    investor_growth = MoneyFlowEngine().calculate(
        "AAA",
        make_records(latest_price=11.0, latest_fund_size=1100.0, latest_investor_count=110.0),
    )

    assert investor_growth.money_flow_score > neutral.money_flow_score
    assert investor_growth.money_flow_score == pytest.approx(57.5)


def test_labels_inflow_and_outflow_thresholds():
    engine = MoneyFlowEngine()

    assert (
        engine.calculate(
            "AAA",
            make_records(latest_fund_size=1140.0, latest_investor_count=100.0),
        ).money_flow_label
        == MoneyFlowLabel.INFLOW
    )
    assert (
        engine.calculate(
            "AAA",
            make_records(latest_fund_size=1060.0, latest_investor_count=100.0),
        ).money_flow_label
        == MoneyFlowLabel.OUTFLOW
    )
