from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class SignalClass(str, Enum):
    STRONG_WATCH = "Strong Watch"
    WATCH = "Watch"
    NEUTRAL = "Neutral"
    RISKY = "Risky"
    PROFIT_TAKING_WATCH = "Profit Taking Watch"


class MoneyFlowLabel(str, Enum):
    STRONG_INFLOW = "STRONG_INFLOW"
    INFLOW = "INFLOW"
    NEUTRAL_FLOW = "NEUTRAL_FLOW"
    OUTFLOW = "OUTFLOW"
    STRONG_OUTFLOW = "STRONG_OUTFLOW"
    UNKNOWN_FLOW = "UNKNOWN_FLOW"


class FundPriceRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fund_code: str
    date: date
    price: float = Field(gt=0)
    fund_title: Optional[str] = None
    shares: Optional[float] = None
    fund_size: Optional[float] = None
    investor_count: Optional[float] = None
    raw: Dict[str, Any] = Field(default_factory=dict)


class CollectionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fund_code: str
    start_date: date
    end_date: date
    source: str
    raw_payload: Any
    records: List[FundPriceRecord]


class PerformanceMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fund_code: str
    as_of: date
    latest_price: float
    daily_return: Optional[float]
    weekly_return: Optional[float]
    monthly_return: Optional[float]
    three_month_return: Optional[float]
    moving_average_7: Optional[float]
    moving_average_30: Optional[float]
    moving_average_90: Optional[float]
    momentum_score: float = Field(ge=0, le=100)


class RiskMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fund_code: str
    as_of: date
    volatility_30: Optional[float]
    volatility_90: Optional[float]
    max_drawdown_90: float
    risk_score: float = Field(ge=0, le=100)


class MoneyFlowMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fund_code: str
    as_of: date
    fund_size_latest: Optional[float]
    investor_count_latest: Optional[float]
    fund_size_change_1d: Optional[float]
    fund_size_change_1w: Optional[float]
    fund_size_change_1m: Optional[float]
    investor_count_change_1w: Optional[float]
    investor_count_change_1m: Optional[float]
    estimated_net_flow_1d: Optional[float]
    estimated_net_flow_1w: Optional[float]
    estimated_net_flow_1m: Optional[float]
    money_flow_score: float = Field(ge=0, le=100)
    money_flow_label: MoneyFlowLabel


class FundRecommendation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fund_code: str
    as_of: date
    final_score: float = Field(ge=0, le=100)
    signal: SignalClass
    explanation: str
    components: Dict[str, Any]


class FundAnalysisResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fund_code: str
    fund_title: Optional[str] = None
    category: str = "UNKNOWN"
    as_of: date
    latest_price: float
    performance: PerformanceMetrics
    risk: RiskMetrics
    recommendation: FundRecommendation
    money_flow: Optional[MoneyFlowMetrics] = None


class ReportArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    report_date: date
    markdown_path: str
    csv_path: str
    markdown_content: str
    summary: Dict[str, Any]
