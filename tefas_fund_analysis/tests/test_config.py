from tefas_analysis.config import AppConfig


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
