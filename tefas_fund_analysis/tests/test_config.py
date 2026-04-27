import pytest

from tefas_analysis.config import AppConfig


def test_default_report_language_is_turkish(monkeypatch, tmp_path):
    monkeypatch.delenv("TEFAS_CONFIG_FILE", raising=False)
    monkeypatch.delenv("TEFAS_REPORT_LANGUAGE", raising=False)

    config = AppConfig.from_file(env_file=tmp_path / "missing.env")

    assert config.report_language == "tr"


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
