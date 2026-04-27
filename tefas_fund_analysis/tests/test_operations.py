import json
from datetime import timedelta

from tefas_analysis.config import AppConfig
from tefas_analysis.operations import (
    OperationalRunLogger,
    failure_entry,
    run_health_check,
    success_entry,
    utc_now,
)


def make_config(tmp_path, **overrides):
    data = {
        "database_url": f"sqlite:///{tmp_path / 'data' / 'tefas.sqlite3'}",
        "report_output_dir": str(tmp_path / "reports"),
        "operational_log_path": str(tmp_path / "logs" / "pipeline_runs.jsonl"),
    }
    data.update(overrides)
    return AppConfig.model_validate(data)


def test_health_check_passes_with_valid_config(tmp_path):
    config = make_config(tmp_path)

    result = run_health_check(config)

    assert result.ok is True
    assert (tmp_path / "data").is_dir()
    assert (tmp_path / "reports").is_dir()


def test_operational_run_log_writes_success_entry(tmp_path):
    config = make_config(tmp_path)
    started_at = utc_now()
    finished_at = started_at + timedelta(seconds=2)

    OperationalRunLogger(config.operational_log_path).append(
        success_entry(
            config=config,
            started_at=started_at,
            finished_at=finished_at,
            fund_count_analyzed=12,
            collected_price_count=120,
            report_markdown_path="reports/output/report.md",
            report_csv_path="reports/output/report.csv",
        )
    )

    rows = (tmp_path / "logs" / "pipeline_runs.jsonl").read_text(encoding="utf-8").splitlines()
    payload = json.loads(rows[0])
    assert payload["status"] == "success"
    assert payload["fund_count_analyzed"] == 12
    assert payload["collected_price_count"] == 120
    assert payload["duration_seconds"] == 2.0


def test_operational_run_log_writes_failure_entry(tmp_path):
    config = make_config(tmp_path, analyze_all_funds=True, fund_codes=[])
    started_at = utc_now()
    finished_at = started_at + timedelta(seconds=1)

    OperationalRunLogger(config.operational_log_path).append(
        failure_entry(
            config=config,
            started_at=started_at,
            finished_at=finished_at,
            error_message="collector failed",
        )
    )

    rows = (tmp_path / "logs" / "pipeline_runs.jsonl").read_text(encoding="utf-8").splitlines()
    payload = json.loads(rows[0])
    assert payload["status"] == "failed"
    assert payload["mode"] == "all_funds"
    assert payload["error_message"] == "collector failed"
    assert payload["fund_count_analyzed"] == 0
