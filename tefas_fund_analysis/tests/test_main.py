from types import SimpleNamespace

import tefas_analysis.main as main_module


def test_cli_report_language_overrides_config(monkeypatch, tmp_path):
    captured = {}

    class FakePipeline:
        def __init__(self, config):
            captured["config"] = config

        def run(self, as_of=None, collect=True, notify=None):
            return SimpleNamespace(
                analyses=[],
                collected_price_count=0,
                report=SimpleNamespace(markdown_path="report.md", csv_path="report.csv"),
            )

    monkeypatch.setattr(main_module, "DailyTefasPipeline", FakePipeline)
    monkeypatch.delenv("TEFAS_CONFIG_FILE", raising=False)
    monkeypatch.setenv("TEFAS_OPERATIONAL_LOG_PATH", str(tmp_path / "runs.jsonl"))

    exit_code = main_module.main(
        [
            "--env-file",
            str(tmp_path / "missing.env"),
            "--report-language",
            "en",
            "--no-notify",
        ]
    )

    assert exit_code == 0
    assert captured["config"].report_language == "en"


def test_dry_run_does_not_call_pipeline(monkeypatch, tmp_path, capsys):
    class ExplodingPipeline:
        def __init__(self, config):
            raise AssertionError("pipeline should not be initialized for dry-run")

    monkeypatch.setattr(main_module, "DailyTefasPipeline", ExplodingPipeline)
    monkeypatch.delenv("TEFAS_CONFIG_FILE", raising=False)

    exit_code = main_module.main(
        [
            "--env-file",
            str(tmp_path / "missing.env"),
            "--all-funds",
            "--max-funds",
            "25",
            "--report-language",
            "tr",
            "--dry-run",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "TEFAS Dry Run" in output
    assert "- Mode: all_funds" in output
    assert "- Max funds: 25" in output


def test_health_check_cli_passes_with_valid_config(monkeypatch, tmp_path, capsys):
    monkeypatch.delenv("TEFAS_CONFIG_FILE", raising=False)
    monkeypatch.setenv("TEFAS_DATABASE_URL", f"sqlite:///{tmp_path / 'data' / 'tefas.sqlite3'}")
    monkeypatch.setenv("TEFAS_REPORT_OUTPUT_DIR", str(tmp_path / "reports"))
    monkeypatch.setenv("TEFAS_OPERATIONAL_LOG_PATH", str(tmp_path / "logs" / "runs.jsonl"))

    exit_code = main_module.main(
        [
            "--env-file",
            str(tmp_path / "missing.env"),
            "--health-check",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "TEFAS Health Check" in output
    assert "- Result: OK" in output


def test_tefas_endpoint_diagnostic_uses_configured_collector(monkeypatch, tmp_path, capsys):
    captured = {}

    class FakeCollector:
        def __init__(self, config):
            captured["config"] = config

        def test_history_endpoint(self, fund_code, start_date, end_date):
            captured["fund_code"] = fund_code
            captured["start_date"] = start_date
            captured["end_date"] = end_date
            return {
                "url": captured["config"].base_url,
                "method": "POST",
                "fund_code": fund_code,
                "start_date": start_date.isoformat(),
                "end_date": end_date.isoformat(),
                "http_status": 200,
                "content_type": "application/json",
                "response_preview": "[]",
                "json_parsed": True,
                "records_found": False,
                "record_count": 0,
            }

    monkeypatch.setattr(main_module, "TefasCollector", FakeCollector)
    monkeypatch.delenv("TEFAS_CONFIG_FILE", raising=False)

    exit_code = main_module.main(
        [
            "--env-file",
            str(tmp_path / "missing.env"),
            "--test-tefas-endpoint",
            "--test-fund-code",
            "aft",
            "--as-of",
            "2026-01-15",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert captured["config"].base_url == "https://fundturkey.com.tr/api/DB/BindHistoryInfo"
    assert captured["fund_code"] == "aft"
    assert "TEFAS Endpoint Diagnostic" in output
    assert "- URL: https://fundturkey.com.tr/api/DB/BindHistoryInfo" in output
    assert "- Method: POST" in output
