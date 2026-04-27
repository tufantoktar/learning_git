from __future__ import annotations

import importlib.util
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from tefas_analysis.config import AppConfig


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class HealthCheckItem:
    name: str
    status: str
    message: str = ""

    @property
    def ok(self) -> bool:
        return self.status in {"OK", "SKIPPED"}


@dataclass(frozen=True)
class HealthCheckResult:
    items: list[HealthCheckItem]

    @property
    def ok(self) -> bool:
        return all(item.ok for item in self.items)


class OperationalRunLogger:
    """Append-only JSONL operational run metadata writer."""

    def __init__(self, log_path: str) -> None:
        self.log_path = Path(log_path)

    def append(self, entry: dict[str, Any]) -> None:
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
        except Exception as exc:  # pragma: no cover - defensive logging fallback.
            logger.warning("Could not write operational run log: %s", exc)


def run_health_check(config: AppConfig) -> HealthCheckResult:
    items = [
        HealthCheckItem("Config", "OK"),
        _check_database_path(config.database_url),
        _check_report_output_dir(config.report_output_dir),
        _check_collector_config(config),
        _check_dashboard_dependencies(),
        _check_report_language(config),
        _check_scheduler(config),
    ]
    return HealthCheckResult(items=items)


def format_health_check(result: HealthCheckResult) -> str:
    lines = ["TEFAS Health Check"]
    for item in result.items:
        detail = f" - {item.message}" if item.message else ""
        lines.append(f"- {item.name}: {item.status}{detail}")
    lines.append(f"- Result: {'OK' if result.ok else 'FAILED'}")
    return "\n".join(lines)


def format_config_load_failure(error: Exception) -> str:
    result = HealthCheckResult(
        items=[
            HealthCheckItem("Config", "FAILED", str(error)),
            HealthCheckItem("Database path", "SKIPPED", "config did not load"),
            HealthCheckItem("Report output directory", "SKIPPED", "config did not load"),
            HealthCheckItem("Collector config", "SKIPPED", "config did not load"),
            HealthCheckItem("Dashboard optional dependencies", "SKIPPED", "config did not load"),
            HealthCheckItem("Report language", "SKIPPED", "config did not load"),
            HealthCheckItem("Scheduler", "SKIPPED", "config did not load"),
        ]
    )
    return format_health_check(result)


def format_dry_run(config: AppConfig) -> str:
    mode = "all_funds" if config.analyze_all_funds else "selected"
    fund_codes = ", ".join(config.fund_codes) if config.fund_codes else "n/a"
    return "\n".join(
        [
            "TEFAS Dry Run",
            f"- Mode: {mode}",
            f"- Fund codes: {fund_codes}",
            f"- Max funds: {config.max_funds if config.max_funds is not None else 'none'}",
            f"- Report language: {config.report_language}",
            f"- Category scoring: {_enabled(config.enable_category_scoring)}",
            f"- Money flow analysis: {_enabled(config.enable_money_flow_analysis)}",
            f"- Analytical tags: {_enabled(config.enable_analytical_tags)}",
            f"- Database URL: {config.database_url}",
            f"- Report output directory: {config.report_output_dir}",
            f"- Operational log path: {config.operational_log_path}",
            "- Network calls: no",
            "- Database writes: no",
            "- Report generation: no",
        ]
    )


def started_entry(config: AppConfig, started_at: datetime) -> dict[str, Any]:
    return {
        "started_at": _iso_utc(started_at),
        "mode": "all_funds" if config.analyze_all_funds else "selected",
        "report_language": config.report_language,
    }


def success_entry(
    config: AppConfig,
    started_at: datetime,
    finished_at: datetime,
    fund_count_analyzed: int,
    collected_price_count: int,
    report_markdown_path: Optional[str],
    report_csv_path: Optional[str],
) -> dict[str, Any]:
    return {
        **started_entry(config, started_at),
        "finished_at": _iso_utc(finished_at),
        "status": "success",
        "fund_count_analyzed": fund_count_analyzed,
        "collected_price_count": collected_price_count,
        "report_markdown_path": report_markdown_path,
        "report_csv_path": report_csv_path,
        "duration_seconds": _duration_seconds(started_at, finished_at),
    }


def failure_entry(
    config: AppConfig,
    started_at: datetime,
    finished_at: datetime,
    error_message: str,
) -> dict[str, Any]:
    return {
        **started_entry(config, started_at),
        "finished_at": _iso_utc(finished_at),
        "status": "failed",
        "fund_count_analyzed": 0,
        "collected_price_count": 0,
        "report_markdown_path": None,
        "report_csv_path": None,
        "duration_seconds": _duration_seconds(started_at, finished_at),
        "error_message": error_message,
    }


def _check_database_path(database_url: str) -> HealthCheckItem:
    path = _sqlite_path(database_url)
    if path is None:
        return HealthCheckItem("Database path", "FAILED", "database_url must use sqlite:///")
    if path == Path(":memory:"):
        return HealthCheckItem("Database path", "OK", "in-memory SQLite")
    return _check_directory(path.parent, "Database path")


def _check_report_output_dir(report_output_dir: str) -> HealthCheckItem:
    return _check_directory(Path(report_output_dir), "Report output directory")


def _check_directory(path: Path, name: str) -> HealthCheckItem:
    try:
        path.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        return HealthCheckItem(name, "FAILED", str(exc))
    if not path.exists() or not path.is_dir():
        return HealthCheckItem(name, "FAILED", f"not a directory: {path}")
    return HealthCheckItem(name, "OK", str(path))


def _check_collector_config(config: AppConfig) -> HealthCheckItem:
    required_window = max(
        [
            config.analysis.weekly_window,
            config.analysis.monthly_window,
            config.analysis.three_month_window,
            *config.analysis.moving_average_windows,
        ]
    )
    errors: list[str] = []
    if config.collector.timeout_seconds <= 0:
        errors.append("timeout_seconds must be > 0")
    if config.collector.max_retries <= 0:
        errors.append("max_retries must be > 0")
    if config.collector.lookback_days < required_window:
        errors.append(
            f"lookback_days must be >= required analysis window ({required_window})"
        )
    if errors:
        return HealthCheckItem("Collector config", "FAILED", "; ".join(errors))
    return HealthCheckItem("Collector config", "OK")


def _check_dashboard_dependencies() -> HealthCheckItem:
    available = {
        "streamlit": importlib.util.find_spec("streamlit") is not None,
        "plotly": importlib.util.find_spec("plotly") is not None,
    }
    if all(available.values()):
        return HealthCheckItem("Dashboard optional dependencies", "OK")
    if not any(available.values()):
        return HealthCheckItem(
            "Dashboard optional dependencies",
            "SKIPPED",
            "dashboard extra is not installed",
        )
    missing = [name for name, exists in available.items() if not exists]
    return HealthCheckItem(
        "Dashboard optional dependencies",
        "FAILED",
        f"partial dashboard install; missing: {', '.join(missing)}",
    )


def _check_report_language(config: AppConfig) -> HealthCheckItem:
    if config.report_language not in {"tr", "en"}:
        return HealthCheckItem("Report language", "FAILED", "must be tr or en")
    return HealthCheckItem("Report language", "OK", config.report_language)


def _check_scheduler(config: AppConfig) -> HealthCheckItem:
    parts = config.scheduler.run_time.split(":")
    if len(parts) != 2:
        return HealthCheckItem("Scheduler", "FAILED", "run_time must use HH:MM format")
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        return HealthCheckItem("Scheduler", "FAILED", "run_time must use HH:MM format")
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return HealthCheckItem("Scheduler", "FAILED", "run_time must use HH:MM format")
    return HealthCheckItem("Scheduler", "OK", config.scheduler.run_time)


def _sqlite_path(database_url: str) -> Optional[Path]:
    if not database_url.startswith("sqlite:///"):
        return None
    raw_path = database_url.replace("sqlite:///", "", 1)
    if raw_path == ":memory:":
        return Path(":memory:")
    return Path(raw_path)


def _enabled(value: bool) -> str:
    return "enabled" if value else "disabled"


def _iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _duration_seconds(started_at: datetime, finished_at: datetime) -> float:
    return round((finished_at - started_at).total_seconds(), 3)
