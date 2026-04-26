from datetime import date

from tefas_analysis.analysis.category_engine import FundCategory
from tefas_analysis.analysis.tag_engine import TagEngine
from tefas_analysis.schemas import AnalyticalTag, PerformanceMetrics, RiskMetrics


def performance(
    daily_return=0.01,
    weekly_return=0.02,
    monthly_return=0.05,
    three_month_return=0.12,
    latest_price=11.0,
    moving_average_7=10.5,
    momentum_score=70.0,
):
    return PerformanceMetrics(
        fund_code="AAA",
        as_of=date(2026, 4, 26),
        latest_price=latest_price,
        daily_return=daily_return,
        weekly_return=weekly_return,
        monthly_return=monthly_return,
        three_month_return=three_month_return,
        moving_average_7=moving_average_7,
        moving_average_30=10.0,
        moving_average_90=9.5,
        momentum_score=momentum_score,
    )


def risk(risk_score=35.0, max_drawdown=-0.05, volatility_30=0.20):
    return RiskMetrics(
        fund_code="AAA",
        as_of=date(2026, 4, 26),
        volatility_30=volatility_30,
        volatility_90=0.22,
        max_drawdown_90=max_drawdown,
        risk_score=risk_score,
    )


def test_overheated_tag_for_strong_return_high_momentum_and_elevated_risk():
    tags = TagEngine().calculate(
        performance(monthly_return=0.13, momentum_score=82.0),
        risk(risk_score=50.0),
        category=FundCategory.EQUITY,
    )

    assert AnalyticalTag.OVERHEATED in tags


def test_cooling_momentum_tag_for_positive_trend_and_short_term_weakness():
    tags = TagEngine().calculate(
        performance(
            daily_return=-0.002,
            weekly_return=-0.01,
            monthly_return=0.02,
            three_month_return=0.10,
            latest_price=9.8,
            moving_average_7=10.0,
        ),
        risk(),
        category=FundCategory.EQUITY,
    )

    assert AnalyticalTag.COOLING_MOMENTUM in tags


def test_consistent_uptrend_tag_for_positive_returns_with_acceptable_risk():
    tags = TagEngine().calculate(
        performance(momentum_score=72.0),
        risk(risk_score=40.0, max_drawdown=-0.06),
        category=FundCategory.EQUITY,
    )

    assert AnalyticalTag.CONSISTENT_UPTREND in tags


def test_high_drawdown_uses_category_specific_thresholds():
    tags = TagEngine().calculate(
        performance(weekly_return=-0.01, monthly_return=-0.01, three_month_return=0.01),
        risk(risk_score=20.0, max_drawdown=-0.03),
        category=FundCategory.MONEY_MARKET,
    )

    assert AnalyticalTag.HIGH_DRAWDOWN in tags


def test_low_liquidity_generated_when_available_liquidity_is_below_threshold():
    tags = TagEngine().calculate(
        performance(),
        risk(),
        category=FundCategory.EQUITY,
        latest_fund_size=50_000_000.0,
        latest_investor_count=1_000.0,
    )

    assert AnalyticalTag.LOW_LIQUIDITY in tags


def test_low_liquidity_not_generated_when_both_liquidity_fields_are_missing():
    tags = TagEngine().calculate(
        performance(),
        risk(),
        category=FundCategory.EQUITY,
    )

    assert AnalyticalTag.LOW_LIQUIDITY not in tags


def test_recovery_watch_generated_for_improving_returns_after_drawdown():
    tags = TagEngine().calculate(
        performance(weekly_return=0.03, monthly_return=0.05, momentum_score=60.0),
        risk(risk_score=60.0, max_drawdown=-0.16),
        category=FundCategory.EQUITY,
    )

    assert AnalyticalTag.RECOVERY_WATCH in tags
    assert AnalyticalTag.HIGH_DRAWDOWN not in tags


def test_missing_optional_fields_do_not_crash_tag_engine():
    tags = TagEngine().calculate(
        performance(
            daily_return=None,
            weekly_return=None,
            monthly_return=None,
            three_month_return=None,
            moving_average_7=None,
            momentum_score=50.0,
        ),
        risk(risk_score=10.0, max_drawdown=0.0, volatility_30=None),
        category=None,
    )

    assert tags == []
