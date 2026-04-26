import csv
from datetime import date

from tefas_analysis.reports.daily_report import DailyReportGenerator
from tefas_analysis.schemas import (
    AnalyticalTag,
    FundAnalysisResult,
    FundRecommendation,
    MoneyFlowLabel,
    MoneyFlowMetrics,
    PerformanceMetrics,
    RiskMetrics,
    SignalClass,
)


def make_result():
    as_of = date(2026, 4, 25)
    performance = PerformanceMetrics(
        fund_code="AFT",
        as_of=as_of,
        latest_price=10.0,
        daily_return=0.01,
        weekly_return=0.02,
        monthly_return=0.03,
        three_month_return=0.04,
        moving_average_7=9.8,
        moving_average_30=9.5,
        moving_average_90=9.0,
        momentum_score=70.0,
    )
    risk = RiskMetrics(
        fund_code="AFT",
        as_of=as_of,
        volatility_30=0.2,
        volatility_90=0.25,
        max_drawdown_90=-0.05,
        risk_score=30.0,
    )
    recommendation = FundRecommendation(
        fund_code="AFT",
        as_of=as_of,
        final_score=72.0,
        signal=SignalClass.WATCH,
        explanation="Watch signal.",
        components={"momentum_score": 70.0},
    )
    money_flow = MoneyFlowMetrics(
        fund_code="AFT",
        as_of=as_of,
        fund_size_latest=1200.0,
        investor_count_latest=110.0,
        fund_size_change_1d=100.0,
        fund_size_change_1w=200.0,
        fund_size_change_1m=300.0,
        investor_count_change_1w=5.0,
        investor_count_change_1m=10.0,
        estimated_net_flow_1d=50.0,
        estimated_net_flow_1w=150.0,
        estimated_net_flow_1m=250.0,
        money_flow_score=82.0,
        money_flow_label=MoneyFlowLabel.STRONG_INFLOW,
    )
    return FundAnalysisResult(
        fund_code="AFT",
        fund_title="AFT Fund",
        category="EQUITY",
        as_of=as_of,
        latest_price=10.0,
        performance=performance,
        risk=risk,
        recommendation=recommendation,
        money_flow=money_flow,
        analytical_tags=[AnalyticalTag.CONSISTENT_UPTREND, AnalyticalTag.LOW_LIQUIDITY],
    )


def test_report_csv_includes_fund_title(tmp_path):
    report = DailyReportGenerator(str(tmp_path)).generate([make_result()], date(2026, 4, 25))

    with open(report.csv_path, encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))

    assert rows[0]["fund_code"] == "AFT"
    assert rows[0]["fund_title"] == "AFT Fund"
    assert rows[0]["category"] == "EQUITY"
    assert rows[0]["money_flow_label"] == "STRONG_INFLOW"
    assert rows[0]["money_flow_score"] == "82.0"
    assert rows[0]["analytical_tags"] == "CONSISTENT_UPTREND|LOW_LIQUIDITY"
    assert "estimated_net_flow_1m" in rows[0]
    assert "AFT Fund" in report.markdown_content
    assert "- EQUITY: 1" in report.markdown_content
    assert "## Money Flow Summary" in report.markdown_content
    assert "- STRONG_INFLOW: 1" in report.markdown_content
    assert "## Analytical Tag Summary" in report.markdown_content
    assert "- CONSISTENT_UPTREND: 1" in report.markdown_content
