from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Iterator, List, Optional

import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from tefas_analysis.schemas import (
    CollectionResult,
    FundAnalysisResult,
    FundPriceRecord,
    ReportArtifact,
)
from tefas_analysis.database.models import (
    Base,
    DailyReport,
    FundMetric,
    FundPrice,
    FundScore,
    RawTefasResponse,
)


class SQLiteRepository:
    """SQLite persistence boundary for raw data, prices, metrics, scores, and reports."""

    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self._ensure_sqlite_parent(database_url)
        self.engine = create_engine(database_url, future=True)
        self.SessionLocal = sessionmaker(bind=self.engine, autoflush=False, future=True)

    def create_schema(self) -> None:
        Base.metadata.create_all(self.engine)

    @contextmanager
    def session(self) -> Iterator[Session]:
        db = self.SessionLocal()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def save_raw_response(self, result: CollectionResult) -> None:
        with self.session() as db:
            db.add(
                RawTefasResponse(
                    fund_code=result.fund_code,
                    source=result.source,
                    request_start_date=result.start_date,
                    request_end_date=result.end_date,
                    payload=result.raw_payload,
                )
            )

    def upsert_prices(self, records: List[FundPriceRecord]) -> int:
        count = 0
        with self.session() as db:
            for record in records:
                row = (
                    db.query(FundPrice)
                    .filter(FundPrice.fund_code == record.fund_code)
                    .filter(FundPrice.date == record.date)
                    .one_or_none()
                )
                if row is None:
                    row = FundPrice(fund_code=record.fund_code, date=record.date)
                    db.add(row)
                row.price = record.price
                row.fund_title = record.fund_title
                row.shares = record.shares
                row.fund_size = record.fund_size
                row.investor_count = record.investor_count
                row.raw = record.raw
                count += 1
        return count

    def get_price_history(self, fund_code: str) -> pd.DataFrame:
        with self.session() as db:
            rows = (
                db.query(FundPrice)
                .filter(FundPrice.fund_code == fund_code.upper())
                .order_by(FundPrice.date.asc())
                .all()
            )
            return pd.DataFrame(
                [
                    {
                        "fund_code": row.fund_code,
                        "date": row.date,
                        "price": row.price,
                        "fund_title": row.fund_title,
                        "shares": row.shares,
                        "fund_size": row.fund_size,
                        "investor_count": row.investor_count,
                    }
                    for row in rows
                ]
            )

    def list_fund_codes(self, limit: Optional[int] = None) -> List[str]:
        with self.session() as db:
            query = db.query(FundPrice.fund_code).distinct().order_by(FundPrice.fund_code.asc())
            if limit is not None:
                query = query.limit(limit)
            return [row[0] for row in query.all()]

    def upsert_analysis_result(self, result: FundAnalysisResult) -> None:
        with self.session() as db:
            metric = (
                db.query(FundMetric)
                .filter(FundMetric.fund_code == result.fund_code)
                .filter(FundMetric.date == result.as_of)
                .one_or_none()
            )
            if metric is None:
                metric = FundMetric(fund_code=result.fund_code, date=result.as_of)
                db.add(metric)

            performance = result.performance
            risk = result.risk
            metric.category = result.category
            metric.latest_price = performance.latest_price
            metric.daily_return = performance.daily_return
            metric.weekly_return = performance.weekly_return
            metric.monthly_return = performance.monthly_return
            metric.three_month_return = performance.three_month_return
            metric.moving_average_7 = performance.moving_average_7
            metric.moving_average_30 = performance.moving_average_30
            metric.moving_average_90 = performance.moving_average_90
            metric.momentum_score = performance.momentum_score
            metric.volatility_30 = risk.volatility_30
            metric.volatility_90 = risk.volatility_90
            metric.max_drawdown_90 = risk.max_drawdown_90
            metric.risk_score = risk.risk_score
            money_flow = result.money_flow
            metric.fund_size_latest = money_flow.fund_size_latest if money_flow else None
            metric.investor_count_latest = money_flow.investor_count_latest if money_flow else None
            metric.fund_size_change_1d = money_flow.fund_size_change_1d if money_flow else None
            metric.fund_size_change_1w = money_flow.fund_size_change_1w if money_flow else None
            metric.fund_size_change_1m = money_flow.fund_size_change_1m if money_flow else None
            metric.investor_count_change_1w = money_flow.investor_count_change_1w if money_flow else None
            metric.investor_count_change_1m = money_flow.investor_count_change_1m if money_flow else None
            metric.estimated_net_flow_1d = money_flow.estimated_net_flow_1d if money_flow else None
            metric.estimated_net_flow_1w = money_flow.estimated_net_flow_1w if money_flow else None
            metric.estimated_net_flow_1m = money_flow.estimated_net_flow_1m if money_flow else None
            metric.money_flow_score = money_flow.money_flow_score if money_flow else None
            metric.money_flow_label = money_flow.money_flow_label.value if money_flow else None

            recommendation = result.recommendation
            score = (
                db.query(FundScore)
                .filter(FundScore.fund_code == result.fund_code)
                .filter(FundScore.date == result.as_of)
                .one_or_none()
            )
            if score is None:
                score = FundScore(fund_code=result.fund_code, date=result.as_of)
                db.add(score)
            score.category = result.category
            score.final_score = recommendation.final_score
            score.signal = recommendation.signal.value
            score.explanation = recommendation.explanation
            score.components = recommendation.components

    def save_report(self, artifact: ReportArtifact) -> None:
        with self.session() as db:
            report = (
                db.query(DailyReport)
                .filter(DailyReport.report_date == artifact.report_date)
                .one_or_none()
            )
            if report is None:
                report = DailyReport(report_date=artifact.report_date)
                db.add(report)
            report.markdown_path = artifact.markdown_path
            report.csv_path = artifact.csv_path
            report.summary = artifact.summary

    @staticmethod
    def summarize_results(results: List[FundAnalysisResult]) -> Dict[str, int]:
        summary: Dict[str, int] = {"funds_analyzed": len(results)}
        for result in results:
            signal = result.recommendation.signal.value
            summary[signal] = summary.get(signal, 0) + 1
        return summary

    @staticmethod
    def _ensure_sqlite_parent(database_url: str) -> None:
        if not database_url.startswith("sqlite:///"):
            return
        raw_path = database_url.replace("sqlite:///", "", 1)
        if raw_path == ":memory:":
            return
        Path(raw_path).parent.mkdir(parents=True, exist_ok=True)
