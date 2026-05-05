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


def test_health_check_validates_csv_path_and_columns(tmp_path):
    csv_path = tmp_path / "input" / "history.csv"
    csv_path.parent.mkdir()
    csv_path.write_text("date,fund_code,price\n2026-04-01,AFT,12.34\n", encoding="utf-8")
    config = make_config(
        tmp_path,
        collector={"source": "csv", "csv_path": str(csv_path)},
    )

    result = run_health_check(config)

    assert result.ok is True
    collector_item = next(item for item in result.items if item.name == "Collector config")
    assert collector_item.status == "OK"
    assert collector_item.message == str(csv_path)


def test_health_check_fails_for_csv_missing_required_columns(tmp_path):
    csv_path = tmp_path / "input" / "history.csv"
    csv_path.parent.mkdir()
    csv_path.write_text("date,title,price\n2026-04-01,AFT Fund,12.34\n", encoding="utf-8")
    config = make_config(
        tmp_path,
        collector={"source": "csv", "csv_path": str(csv_path)},
    )

    result = run_health_check(config)

    assert result.ok is False
    collector_item = next(item for item in result.items if item.name == "Collector config")
    assert collector_item.status == "FAILED"
    assert "date, fund_code, and price" in collector_item.message


def test_health_check_fails_for_missing_csv_path(tmp_path):
    csv_path = tmp_path / "input" / "missing.csv"
    config = make_config(
        tmp_path,
        collector={"source": "csv", "csv_path": str(csv_path)},
    )

    result = run_health_check(config)

    assert result.ok is False
    collector_item = next(item for item in result.items if item.name == "Collector config")
    assert collector_item.status == "FAILED"
    assert "CSV collector source selected but file was not found" in collector_item.message


def test_operational_run_log_writes_success_entry(tmp_path):
    csv_path = tmp_path / "input" / "history.csv"
    config = make_config(
        tmp_path,
        collector={"source": "csv", "csv_path": str(csv_path)},
    )
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
            report_excel_path="reports/output/report.xlsx",
        )
    )

    rows = (tmp_path / "logs" / "pipeline_runs.jsonl").read_text(encoding="utf-8").splitlines()
    payload = json.loads(rows[0])
    assert payload["status"] == "success"
    assert payload["collector_source"] == "csv"
    assert payload["csv_path"] == str(csv_path)
    assert payload["fund_count_analyzed"] == 12
    assert payload["collected_price_count"] == 120
    assert payload["report_excel_path"] == "reports/output/report.xlsx"
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
    assert payload["collector_source"] == "tefas_api"
    assert payload["error_message"] == "collector failed"
    assert payload["fund_count_analyzed"] == 0
