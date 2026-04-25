import csv
from datetime import date

from tefas_analysis.reports.daily_report import DailyReportGenerator
from tefas_analysis.schemas import (
    FundAnalysisResult,
    FundRecommendation,
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
    return FundAnalysisResult(
        fund_code="AFT",
        fund_title="AFT Fund",
        as_of=as_of,
        latest_price=10.0,
        performance=performance,
        risk=risk,
        recommendation=recommendation,
    )


def test_report_csv_includes_fund_title(tmp_path):
    report = DailyReportGenerator(str(tmp_path)).generate([make_result()], date(2026, 4, 25))

    with open(report.csv_path, encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))

    assert rows[0]["fund_code"] == "AFT"
    assert rows[0]["fund_title"] == "AFT Fund"
    assert "AFT Fund" in report.markdown_content
