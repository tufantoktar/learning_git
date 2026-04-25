from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    Column,
    Date,
    DateTime,
    Float,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import declarative_base


Base = declarative_base()


class RawTefasResponse(Base):
    __tablename__ = "raw_tefas_responses"

    id = Column(Integer, primary_key=True)
    fund_code = Column(String(16), nullable=False, index=True)
    source = Column(String(500), nullable=False)
    request_start_date = Column(Date, nullable=False)
    request_end_date = Column(Date, nullable=False)
    payload = Column(JSON, nullable=False)
    fetched_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class FundPrice(Base):
    __tablename__ = "fund_prices"
    __table_args__ = (UniqueConstraint("fund_code", "date", name="uq_fund_price_date"),)

    id = Column(Integer, primary_key=True)
    fund_code = Column(String(16), nullable=False, index=True)
    date = Column(Date, nullable=False, index=True)
    price = Column(Float, nullable=False)
    fund_title = Column(String(500), nullable=True)
    shares = Column(Float, nullable=True)
    fund_size = Column(Float, nullable=True)
    investor_count = Column(Float, nullable=True)
    raw = Column(JSON, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class FundMetric(Base):
    __tablename__ = "fund_metrics"
    __table_args__ = (UniqueConstraint("fund_code", "date", name="uq_fund_metric_date"),)

    id = Column(Integer, primary_key=True)
    fund_code = Column(String(16), nullable=False, index=True)
    date = Column(Date, nullable=False, index=True)
    latest_price = Column(Float, nullable=False)
    daily_return = Column(Float, nullable=True)
    weekly_return = Column(Float, nullable=True)
    monthly_return = Column(Float, nullable=True)
    three_month_return = Column(Float, nullable=True)
    moving_average_7 = Column(Float, nullable=True)
    moving_average_30 = Column(Float, nullable=True)
    moving_average_90 = Column(Float, nullable=True)
    momentum_score = Column(Float, nullable=False)
    volatility_30 = Column(Float, nullable=True)
    volatility_90 = Column(Float, nullable=True)
    max_drawdown_90 = Column(Float, nullable=False)
    risk_score = Column(Float, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class FundScore(Base):
    __tablename__ = "fund_scores"
    __table_args__ = (UniqueConstraint("fund_code", "date", name="uq_fund_score_date"),)

    id = Column(Integer, primary_key=True)
    fund_code = Column(String(16), nullable=False, index=True)
    date = Column(Date, nullable=False, index=True)
    final_score = Column(Float, nullable=False)
    signal = Column(String(64), nullable=False)
    explanation = Column(Text, nullable=False)
    components = Column(JSON, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class DailyReport(Base):
    __tablename__ = "daily_reports"
    __table_args__ = (UniqueConstraint("report_date", name="uq_daily_report_date"),)

    id = Column(Integer, primary_key=True)
    report_date = Column(Date, nullable=False, index=True)
    markdown_path = Column(String(1000), nullable=False)
    csv_path = Column(String(1000), nullable=False)
    summary = Column(JSON, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
