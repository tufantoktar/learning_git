from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta
from typing import List, Optional

from tefas_analysis.analysis import (
    CategoryEngine,
    MoneyFlowEngine,
    PerformanceEngine,
    RecommendationEngine,
    RiskEngine,
    TagEngine,
)
from tefas_analysis.collectors import TefasCollector
from tefas_analysis.config import AppConfig
from tefas_analysis.database import SQLiteRepository
from tefas_analysis.notifications import TelegramNotifier
from tefas_analysis.reports import DailyReportGenerator
from tefas_analysis.schemas import FundAnalysisResult, ReportArtifact


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DailyPipelineResult:
    report: ReportArtifact
    analyses: List[FundAnalysisResult]
    collected_price_count: int


class DailyTefasPipeline:
    """Coordinates collection, analysis, scoring, reporting, persistence, and notification."""

    def __init__(
        self,
        config: AppConfig,
        repository: Optional[SQLiteRepository] = None,
        collector: Optional[TefasCollector] = None,
        notifier: Optional[TelegramNotifier] = None,
    ) -> None:
        self.config = config
        self.repository = repository or SQLiteRepository(config.database_url)
        self.collector = collector or TefasCollector(config.collector)
        self.category_engine = CategoryEngine()
        self.money_flow_engine = MoneyFlowEngine()
        self.tag_engine = TagEngine(config.analytical_tags)
        self.performance_engine = PerformanceEngine(config.analysis)
        self.risk_engine = RiskEngine(config.analysis)
        self.recommendation_engine = RecommendationEngine(config.recommendation)
        self.report_generator = DailyReportGenerator(config.report_output_dir)
        self.notifier = notifier or TelegramNotifier(config.notifications)

    def run(
        self,
        as_of: Optional[date] = None,
        collect: bool = True,
        notify: Optional[bool] = None,
    ) -> DailyPipelineResult:
        self.repository.create_schema()
        report_date = as_of or date.today()
        start_date = report_date - timedelta(days=self.config.collector.lookback_days)
        collected_count = 0
        analysis_fund_codes = list(self.config.fund_codes)

        if collect:
            if self.config.analyze_all_funds:
                logger.info("Collecting TEFAS prices for all funds")
                collection_result = self.collector.fetch_all_funds_history(
                    start_date,
                    report_date,
                    max_funds=self.config.max_funds,
                )
                if not collection_result.records:
                    raise RuntimeError(
                        "TEFAS all-funds scan returned zero fund records; "
                        "check TEFAS response format, date range, or collector configuration."
                    )
                if self.config.save_raw_payload:
                    self.repository.save_raw_response(collection_result)
                collected_count += self.repository.upsert_prices(collection_result.records)
                analysis_fund_codes = sorted({record.fund_code for record in collection_result.records})
                logger.info(
                    "Stored %s prices for %s discovered funds",
                    len(collection_result.records),
                    len(analysis_fund_codes),
                )
            else:
                logger.info("Collecting TEFAS prices for %s", ", ".join(self.config.fund_codes))
                collection_results = self.collector.fetch_multiple(
                    self.config.fund_codes,
                    start_date,
                    report_date,
                )
                for collection_result in collection_results:
                    if self.config.save_raw_payload:
                        self.repository.save_raw_response(collection_result)
                    collected_count += self.repository.upsert_prices(collection_result.records)
                    logger.info(
                        "Stored %s prices for %s",
                        len(collection_result.records),
                        collection_result.fund_code,
                    )

        if self.config.analyze_all_funds and not analysis_fund_codes:
            analysis_fund_codes = self.repository.list_fund_codes(limit=self.config.max_funds)

        analyses: List[FundAnalysisResult] = []
        for fund_code in analysis_fund_codes:
            history = self.repository.get_price_history(fund_code)
            if history.empty:
                logger.warning("No stored price history for %s; skipping analysis", fund_code)
                continue

            fund_title = self._latest_fund_title(history)
            category = self.category_engine.classify(fund_title=fund_title)
            performance = self.performance_engine.calculate(fund_code, history, as_of=report_date)
            risk = self.risk_engine.calculate(fund_code, history, as_of=report_date)
            money_flow = None
            if self.config.enable_money_flow_analysis:
                money_flow = self.money_flow_engine.calculate(fund_code, history, as_of=report_date)
            analytical_tags = []
            if self.config.enable_analytical_tags:
                analytical_tags = self.tag_engine.calculate(
                    performance=performance,
                    risk=risk,
                    money_flow=money_flow,
                    category=category,
                    latest_fund_size=self._latest_optional_number(history, "fund_size", report_date),
                    latest_investor_count=self._latest_optional_number(history, "investor_count", report_date),
                )
            recommendation = self.recommendation_engine.score(
                performance,
                risk,
                category=category,
                enable_category_scoring=self.config.enable_category_scoring,
                money_flow=money_flow,
            )
            result = FundAnalysisResult(
                fund_code=fund_code,
                fund_title=fund_title,
                category=category.value,
                as_of=performance.as_of,
                latest_price=performance.latest_price,
                performance=performance,
                risk=risk,
                recommendation=recommendation,
                money_flow=money_flow,
                analytical_tags=analytical_tags,
            )
            self.repository.upsert_analysis_result(result)
            analyses.append(result)

        report = self.report_generator.generate(analyses, report_date)
        self.repository.save_report(report)

        should_notify = self.config.notifications.telegram_enabled if notify is None else notify
        if should_notify:
            self.notifier.send_message(self._notification_text(report, analyses))

        return DailyPipelineResult(
            report=report,
            analyses=analyses,
            collected_price_count=collected_count,
        )

    @staticmethod
    def _notification_text(
        report: ReportArtifact,
        analyses: List[FundAnalysisResult],
    ) -> str:
        top_lines = []
        for result in sorted(
            analyses,
            key=lambda item: (-item.recommendation.final_score, item.fund_code),
        )[:5]:
            top_lines.append(
                f"{result.fund_code}: {result.recommendation.signal.value} "
                f"({result.recommendation.final_score:.2f})"
            )
        top_text = "\n".join(top_lines) if top_lines else "No funds analyzed."
        return (
            f"TEFAS Daily Fund Analysis - {report.report_date.isoformat()}\n"
            "Analytical research only; not financial advice.\n\n"
            f"{top_text}\n\n"
            f"Markdown: {report.markdown_path}\n"
            f"CSV: {report.csv_path}"
        )

    @staticmethod
    def _latest_fund_title(history) -> Optional[str]:
        if "fund_title" not in history.columns:
            return None
        titles = history["fund_title"].dropna()
        titles = titles[titles.astype(str).str.strip() != ""]
        if titles.empty:
            return None
        return str(titles.iloc[-1]).strip()

    @staticmethod
    def _latest_optional_number(history, column: str, as_of: date) -> Optional[float]:
        if column not in history.columns or "date" not in history.columns:
            return None
        frame = history.copy()
        frame["date"] = frame["date"].apply(lambda value: value.date() if hasattr(value, "date") else value)
        frame = frame[frame["date"] <= as_of]
        values = frame[column].dropna()
        if values.empty:
            return None
        return float(values.iloc[-1])
