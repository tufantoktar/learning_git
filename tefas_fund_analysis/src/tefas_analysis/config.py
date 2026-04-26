from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - dependency is declared for installed environments.
    def load_dotenv(*args: Any, **kwargs: Any) -> bool:
        return False


def _deep_update(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_update(merged[key], value)
        else:
            merged[key] = value
    return merged


def _env_bool(name: str) -> Optional[bool]:
    raw = os.getenv(name)
    if raw is None:
        return None
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_int(name: str) -> Optional[int]:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return None
    return int(raw)


class CollectorConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_url: str = "https://www.tefas.gov.tr/api/DB/BindHistoryInfo"
    fund_type: str = "YAT"
    lookback_days: int = Field(default=120, ge=7)
    timeout_seconds: int = Field(default=20, ge=1)
    max_retries: int = Field(default=3, ge=1)
    request_delay_seconds: float = Field(default=0.25, ge=0)
    user_agent: str = (
        "Mozilla/5.0 (compatible; TEFASFundAnalysis/0.1; "
        "+https://www.tefas.gov.tr)"
    )


class AnalysisConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    weekly_window: int = Field(default=5, ge=1)
    monthly_window: int = Field(default=21, ge=1)
    three_month_window: int = Field(default=63, ge=1)
    moving_average_windows: List[int] = Field(default_factory=lambda: [7, 30, 90])
    trading_days_per_year: int = Field(default=252, ge=1)
    risk_volatility_cap: float = Field(default=0.6, gt=0)
    risk_drawdown_cap: float = Field(default=0.3, gt=0)

    @field_validator("moving_average_windows")
    @classmethod
    def validate_windows(cls, value: List[int]) -> List[int]:
        windows = sorted(set(value))
        if not windows:
            raise ValueError("at least one moving average window is required")
        if any(window <= 0 for window in windows):
            raise ValueError("moving average windows must be positive")
        return windows


class RecommendationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    strong_watch_threshold: float = Field(default=75.0, ge=0, le=100)
    watch_threshold: float = Field(default=60.0, ge=0, le=100)
    risky_threshold: float = Field(default=75.0, ge=0, le=100)
    strong_watch_max_risk: float = Field(default=55.0, ge=0, le=100)
    watch_max_risk: float = Field(default=70.0, ge=0, le=100)
    profit_taking_monthly_return: float = 0.12
    profit_taking_three_month_return: float = 0.30
    profit_taking_min_risk: float = Field(default=45.0, ge=0, le=100)
    risky_drawdown_threshold: float = -0.20


class SchedulerConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    run_time: str = "18:30"
    timezone: str = "Europe/Istanbul"

    @field_validator("run_time")
    @classmethod
    def validate_run_time(cls, value: str) -> str:
        parts = value.split(":")
        if len(parts) != 2:
            raise ValueError("run_time must use HH:MM format")
        hour, minute = int(parts[0]), int(parts[1])
        if hour < 0 or hour > 23 or minute < 0 or minute > 59:
            raise ValueError("run_time must use HH:MM format")
        return f"{hour:02d}:{minute:02d}"


class NotificationConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    telegram_enabled: bool = False
    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None


class AppConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fund_codes: List[str] = Field(default_factory=lambda: ["AFT", "MAC", "TCD"])
    analyze_all_funds: bool = False
    max_funds: Optional[int] = Field(default=None, ge=1)
    save_raw_payload: bool = True
    enable_category_scoring: bool = True
    enable_money_flow_analysis: bool = True
    database_url: str = "sqlite:///data/tefas_analysis.sqlite3"
    report_output_dir: str = "reports/output"
    collector: CollectorConfig = Field(default_factory=CollectorConfig)
    analysis: AnalysisConfig = Field(default_factory=AnalysisConfig)
    recommendation: RecommendationConfig = Field(default_factory=RecommendationConfig)
    scheduler: SchedulerConfig = Field(default_factory=SchedulerConfig)
    notifications: NotificationConfig = Field(default_factory=NotificationConfig)

    @field_validator("fund_codes")
    @classmethod
    def normalize_fund_codes(cls, value: List[str]) -> List[str]:
        normalized: List[str] = []
        seen = set()
        for code in value:
            fund_code = code.strip().upper()
            if not fund_code or fund_code == "ALL":
                continue
            if fund_code not in seen:
                normalized.append(fund_code)
                seen.add(fund_code)
        return normalized

    @model_validator(mode="after")
    def validate_analysis_scope(self) -> "AppConfig":
        if not self.analyze_all_funds and not self.fund_codes:
            raise ValueError("at least one fund code is required unless analyze_all_funds is true")
        return self

    @classmethod
    def from_file(
        cls,
        config_path: Optional[Path] = None,
        env_file: Optional[Path] = None,
    ) -> "AppConfig":
        if env_file is None:
            env_file = Path.cwd() / ".env"
        load_dotenv(env_file, override=False)

        selected_config = config_path
        if selected_config is None and os.getenv("TEFAS_CONFIG_FILE"):
            selected_config = Path(os.environ["TEFAS_CONFIG_FILE"])

        data: Dict[str, Any] = {}
        if selected_config is not None:
            if not selected_config.exists():
                raise FileNotFoundError(f"config file not found: {selected_config}")
            data = json.loads(selected_config.read_text(encoding="utf-8"))

        env_override: Dict[str, Any] = {}

        analyze_all_funds = _env_bool("TEFAS_ANALYZE_ALL_FUNDS")
        if analyze_all_funds is not None:
            env_override["analyze_all_funds"] = analyze_all_funds
        if _env_int("TEFAS_MAX_FUNDS") is not None:
            env_override["max_funds"] = _env_int("TEFAS_MAX_FUNDS")
        save_raw_payload = _env_bool("TEFAS_SAVE_RAW_PAYLOAD")
        if save_raw_payload is not None:
            env_override["save_raw_payload"] = save_raw_payload
        enable_category_scoring = _env_bool("TEFAS_ENABLE_CATEGORY_SCORING")
        if enable_category_scoring is not None:
            env_override["enable_category_scoring"] = enable_category_scoring
        enable_money_flow_analysis = _env_bool("TEFAS_ENABLE_MONEY_FLOW_ANALYSIS")
        if enable_money_flow_analysis is not None:
            env_override["enable_money_flow_analysis"] = enable_money_flow_analysis

        if os.getenv("TEFAS_FUND_CODES"):
            raw_codes = [
                item.strip()
                for item in os.environ["TEFAS_FUND_CODES"].split(",")
                if item.strip()
            ]
            if any(item.upper() == "ALL" for item in raw_codes):
                env_override["analyze_all_funds"] = True
                env_override["fund_codes"] = []
            else:
                env_override["fund_codes"] = raw_codes
        if os.getenv("TEFAS_DATABASE_URL"):
            env_override["database_url"] = os.environ["TEFAS_DATABASE_URL"]
        if os.getenv("TEFAS_REPORT_OUTPUT_DIR"):
            env_override["report_output_dir"] = os.environ["TEFAS_REPORT_OUTPUT_DIR"]

        collector_override: Dict[str, Any] = {}
        if os.getenv("TEFAS_BASE_URL"):
            collector_override["base_url"] = os.environ["TEFAS_BASE_URL"]
        if _env_int("TEFAS_LOOKBACK_DAYS") is not None:
            collector_override["lookback_days"] = _env_int("TEFAS_LOOKBACK_DAYS")
        if _env_int("TEFAS_TIMEOUT_SECONDS") is not None:
            collector_override["timeout_seconds"] = _env_int("TEFAS_TIMEOUT_SECONDS")
        if _env_int("TEFAS_MAX_RETRIES") is not None:
            collector_override["max_retries"] = _env_int("TEFAS_MAX_RETRIES")
        if collector_override:
            env_override["collector"] = collector_override

        scheduler_override: Dict[str, Any] = {}
        schedule_enabled = _env_bool("TEFAS_SCHEDULE_ENABLED")
        if schedule_enabled is not None:
            scheduler_override["enabled"] = schedule_enabled
        if os.getenv("TEFAS_SCHEDULE_TIME"):
            scheduler_override["run_time"] = os.environ["TEFAS_SCHEDULE_TIME"]
        if os.getenv("TEFAS_SCHEDULE_TIMEZONE"):
            scheduler_override["timezone"] = os.environ["TEFAS_SCHEDULE_TIMEZONE"]
        if scheduler_override:
            env_override["scheduler"] = scheduler_override

        notification_override: Dict[str, Any] = {}
        telegram_enabled = _env_bool("TELEGRAM_ENABLED")
        if telegram_enabled is not None:
            notification_override["telegram_enabled"] = telegram_enabled
        if os.getenv("TELEGRAM_BOT_TOKEN"):
            notification_override["telegram_bot_token"] = os.environ["TELEGRAM_BOT_TOKEN"]
        if os.getenv("TELEGRAM_CHAT_ID"):
            notification_override["telegram_chat_id"] = os.environ["TELEGRAM_CHAT_ID"]
        if notification_override:
            env_override["notifications"] = notification_override

        return cls.model_validate(_deep_update(data, env_override))
