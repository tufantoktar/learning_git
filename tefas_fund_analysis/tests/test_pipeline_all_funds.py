from datetime import date, timedelta

import pytest

from tefas_analysis.config import AppConfig
from tefas_analysis.pipeline import DailyTefasPipeline
from tefas_analysis.schemas import CollectionResult, FundPriceRecord


class FakeAllFundsCollector:
    def __init__(self, records):
        self.records = records
        self.calls = []

    def fetch_all_funds_history(self, start_date, end_date, max_funds=None):
        self.calls.append(
            {
                "start_date": start_date,
                "end_date": end_date,
                "max_funds": max_funds,
            }
        )
        return CollectionResult(
            fund_code="ALL",
            start_date=start_date,
            end_date=end_date,
            source="mock://tefas",
            raw_payload={"data": []},
            records=self.records,
        )


def make_records(fund_code, fund_title, start_price):
    start = date(2026, 1, 1)
    return [
        FundPriceRecord(
            fund_code=fund_code,
            fund_title=fund_title,
            date=start + timedelta(days=index),
            price=start_price + index,
        )
        for index in range(80)
    ]


def make_config(tmp_path, **overrides):
    data = {
        "fund_codes": [],
        "analyze_all_funds": True,
        "database_url": f"sqlite:///{tmp_path / 'tefas.sqlite3'}",
        "report_output_dir": str(tmp_path / "reports"),
        "save_raw_payload": False,
    }
    data.update(overrides)
    return AppConfig.model_validate(data)


def test_pipeline_all_funds_mode_analyzes_discovered_fund_codes(tmp_path):
    collector = FakeAllFundsCollector(
        make_records("AAA", "AAA Hisse Senedi Fonu", 100.0)
        + make_records("BBB", "BBB Para Piyasası Fonu", 200.0)
    )
    config = make_config(tmp_path, max_funds=2)

    result = DailyTefasPipeline(config, collector=collector).run(
        as_of=date(2026, 3, 21),
        collect=True,
        notify=False,
    )

    assert collector.calls[0]["max_funds"] == 2
    assert [analysis.fund_code for analysis in result.analyses] == ["AAA", "BBB"]
    assert [analysis.fund_title for analysis in result.analyses] == [
        "AAA Hisse Senedi Fonu",
        "BBB Para Piyasası Fonu",
    ]
    assert [analysis.category for analysis in result.analyses] == ["EQUITY", "MONEY_MARKET"]
    assert result.collected_price_count == 160


def test_pipeline_raises_clear_error_on_empty_all_funds_response(tmp_path):
    config = make_config(tmp_path)

    with pytest.raises(RuntimeError, match="all-funds scan returned zero fund records"):
        DailyTefasPipeline(config, collector=FakeAllFundsCollector([])).run(
            as_of=date(2026, 3, 21),
            collect=True,
            notify=False,
        )
