import pytest

from tefas_analysis.config import AppConfig


def test_default_report_language_is_turkish(monkeypatch, tmp_path):
    monkeypatch.delenv("TEFAS_CONFIG_FILE", raising=False)
    monkeypatch.delenv("TEFAS_REPORT_LANGUAGE", raising=False)

    config = AppConfig.from_file(env_file=tmp_path / "missing.env")

    assert config.report_language == "tr"


def test_default_collector_uses_fundturkey_endpoint():
    config = AppConfig.model_validate({})

    assert config.collector.base_url == "https://fundturkey.com.tr/api/DB/BindHistoryInfo"
    assert config.collector.allocation_url == "https://fundturkey.com.tr/api/DB/BindHistoryAllocation"
    assert config.collector.origin == "https://fundturkey.com.tr"
    assert config.collector.referer == "https://fundturkey.com.tr/TarihselVeriler.aspx"


def test_report_language_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("TEFAS_REPORT_LANGUAGE", "en")
    monkeypatch.delenv("TEFAS_CONFIG_FILE", raising=False)

    config = AppConfig.from_file(env_file=tmp_path / "missing.env")

    assert config.report_language == "en"


def test_invalid_report_language_fails_validation():
    with pytest.raises(Exception):
        AppConfig.model_validate({"report_language": "de"})


def test_operational_log_path_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("TEFAS_OPERATIONAL_LOG_PATH", str(tmp_path / "runs.jsonl"))
    monkeypatch.delenv("TEFAS_CONFIG_FILE", raising=False)

    config = AppConfig.from_file(env_file=tmp_path / "missing.env")

    assert config.operational_log_path == str(tmp_path / "runs.jsonl")


def test_collector_endpoint_env_overrides(monkeypatch, tmp_path):
    monkeypatch.setenv("TEFAS_BASE_URL", "https://example.test/history")
    monkeypatch.setenv("TEFAS_ALLOCATION_URL", "https://example.test/allocation")
    monkeypatch.setenv("TEFAS_ORIGIN", "https://example.test")
    monkeypatch.setenv("TEFAS_REFERER", "https://example.test/history-page")
    monkeypatch.delenv("TEFAS_CONFIG_FILE", raising=False)

    config = AppConfig.from_file(env_file=tmp_path / "missing.env")

    assert config.collector.base_url == "https://example.test/history"
    assert config.collector.allocation_url == "https://example.test/allocation"
    assert config.collector.origin == "https://example.test"
    assert config.collector.referer == "https://example.test/history-page"


def test_tefas_fund_codes_all_enables_analyze_all_funds(monkeypatch, tmp_path):
    monkeypatch.setenv("TEFAS_FUND_CODES", "ALL")
    monkeypatch.delenv("TEFAS_CONFIG_FILE", raising=False)
    monkeypatch.delenv("TEFAS_ANALYZE_ALL_FUNDS", raising=False)

    config = AppConfig.from_file(env_file=tmp_path / "missing.env")

    assert config.analyze_all_funds is True
    assert config.fund_codes == []


def test_money_flow_env_flag_can_disable_analysis(monkeypatch, tmp_path):
    monkeypatch.setenv("TEFAS_ENABLE_MONEY_FLOW_ANALYSIS", "false")
    monkeypatch.delenv("TEFAS_CONFIG_FILE", raising=False)

    config = AppConfig.from_file(env_file=tmp_path / "missing.env")

    assert config.enable_money_flow_analysis is False


def test_analytical_tags_env_flag_can_disable_tags(monkeypatch, tmp_path):
    monkeypatch.setenv("TEFAS_ENABLE_ANALYTICAL_TAGS", "false")
    monkeypatch.delenv("TEFAS_CONFIG_FILE", raising=False)

    config = AppConfig.from_file(env_file=tmp_path / "missing.env")

    assert config.enable_analytical_tags is False
