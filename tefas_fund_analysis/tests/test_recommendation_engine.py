from datetime import date

from tefas_analysis.analysis.recommendation_engine import RecommendationEngine
from tefas_analysis.schemas import PerformanceMetrics, RiskMetrics, SignalClass


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
