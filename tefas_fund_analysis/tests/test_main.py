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
