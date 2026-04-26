from datetime import date

import pytest

from tefas_analysis.analysis.category_engine import FundCategory
from tefas_analysis.analysis.recommendation_engine import RecommendationEngine
from tefas_analysis.schemas import (
    MoneyFlowLabel,
    MoneyFlowMetrics,
    PerformanceMetrics,
    RiskMetrics,
    SignalClass,
)


def performance(
    momentum=80.0,
    monthly_return=0.08,
    three_month_return=0.18,
):
    return PerformanceMetrics(
        fund_code="AFT",
        as_of=date(2026, 4, 25),
        latest_price=10.0,
        daily_return=0.004,
        weekly_return=0.02,
        monthly_return=monthly_return,
        three_month_return=three_month_return,
        moving_average_7=9.8,
        moving_average_30=9.4,
        moving_average_90=8.7,
        momentum_score=momentum,
    )


def risk(risk_score=25.0, max_drawdown=-0.05):
    return RiskMetrics(
        fund_code="AFT",
        as_of=date(2026, 4, 25),
        volatility_30=0.18,
        volatility_90=0.2,
        max_drawdown_90=max_drawdown,
        risk_score=risk_score,
    )


def money_flow(label, score=50.0):
    return MoneyFlowMetrics(
        fund_code="AFT",
        as_of=date(2026, 4, 25),
        fund_size_latest=1000.0,
        investor_count_latest=100.0,
        fund_size_change_1d=None,
        fund_size_change_1w=None,
        fund_size_change_1m=None,
        investor_count_change_1w=None,
        investor_count_change_1m=None,
        estimated_net_flow_1d=None,
        estimated_net_flow_1w=None,
        estimated_net_flow_1m=None,
        money_flow_score=score,
        money_flow_label=label,
    )


def test_strong_watch_classification():
    recommendation = RecommendationEngine().score(performance(), risk())

    assert recommendation.signal == SignalClass.STRONG_WATCH
    assert recommendation.final_score >= 75
    assert recommendation.components["risk_score"] == 25.0


def test_risky_classification_for_high_risk_and_weak_momentum():
    recommendation = RecommendationEngine().score(
        performance(momentum=35.0, monthly_return=-0.08, three_month_return=-0.14),
        risk(risk_score=86.0, max_drawdown=-0.25),
    )

    assert recommendation.signal == SignalClass.RISKY


def test_profit_taking_watch_for_overextended_gain_with_moderate_risk():
    recommendation = RecommendationEngine().score(
        performance(momentum=82.0, monthly_return=0.16, three_month_return=0.34),
        risk(risk_score=50.0, max_drawdown=-0.08),
    )

    assert recommendation.signal == SignalClass.PROFIT_TAKING_WATCH


def test_recommendation_engine_uses_generic_scoring_when_category_scoring_disabled():
    engine = RecommendationEngine()
    generic = engine.score(performance(), risk())
    disabled = engine.score(
        performance(),
        risk(),
        category=FundCategory.MONEY_MARKET,
        enable_category_scoring=False,
    )

    assert disabled.final_score == pytest.approx(generic.final_score)
    assert disabled.components["return_score"] == pytest.approx(generic.components["return_score"])
    assert disabled.components["stability_score"] == pytest.approx(generic.components["stability_score"])
    assert disabled.components["category_scoring_enabled"] == 0.0


def test_category_scoring_differs_for_money_market_and_equity_inputs():
    engine = RecommendationEngine()

    money_market = engine.score(
        performance(momentum=65.0, monthly_return=0.02, three_month_return=0.05),
        risk(risk_score=35.0, max_drawdown=-0.04),
        category=FundCategory.MONEY_MARKET,
    )
    equity = engine.score(
        performance(momentum=65.0, monthly_return=0.02, three_month_return=0.05),
        risk(risk_score=35.0, max_drawdown=-0.04),
        category=FundCategory.EQUITY,
    )

    assert money_market.final_score != pytest.approx(equity.final_score)
    assert money_market.components["effective_risk_score"] != pytest.approx(
        equity.components["effective_risk_score"]
    )


def test_strong_inflow_slightly_increases_final_score():
    engine = RecommendationEngine()
    base = engine.score(performance(), risk())
    with_flow = engine.score(
        performance(),
        risk(),
        money_flow=money_flow(MoneyFlowLabel.STRONG_INFLOW, 90.0),
    )

    assert with_flow.final_score == pytest.approx(base.final_score + 4.0)
    assert with_flow.components["money_flow_label"] == MoneyFlowLabel.STRONG_INFLOW.value


def test_strong_outflow_slightly_decreases_final_score():
    engine = RecommendationEngine()
    base = engine.score(performance(), risk())
    with_flow = engine.score(
        performance(),
        risk(),
        money_flow=money_flow(MoneyFlowLabel.STRONG_OUTFLOW, 10.0),
    )

    assert with_flow.final_score == pytest.approx(base.final_score - 4.0)
    assert with_flow.components["money_flow_score"] == 10.0


def test_unknown_flow_does_not_change_final_score():
    engine = RecommendationEngine()
    base = engine.score(performance(), risk())
    with_flow = engine.score(
        performance(),
        risk(),
        money_flow=money_flow(MoneyFlowLabel.UNKNOWN_FLOW, 50.0),
    )

    assert with_flow.final_score == pytest.approx(base.final_score)
    assert with_flow.components["money_flow_score_adjustment"] == 0.0
