from datetime import date

import pytest

from tefas_analysis.collectors.tefas_collector import (
    DISABLED_HISTORY_ENDPOINT_MESSAGE,
    TefasCollector,
)
from tefas_analysis.config import CollectorConfig


class MockResponse:
    def __init__(
        self,
        payload,
        status_code=200,
        headers=None,
        text=None,
    ):
        self.payload = payload
        self.status_code = status_code
        self.headers = headers or {"Content-Type": "application/json"}
        self.text = text if text is not None else str(payload)

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class MockSession:
    def __init__(self, payload):
        self.payload = payload
        self.requests = []

    def post(self, url, **kwargs):
        self.requests.append({"url": url, **kwargs})
        return MockResponse(self.payload)


def test_all_funds_collector_normalizes_multiple_fund_codes():
    payload = [
        {
            "FONKODU": "aaa",
            "FONUNVAN": "AAA Fund",
            "TARIH": "01.01.2026",
            "FIYAT": "1,25",
        },
        {
            "FONKODU": "bbb",
            "FON ADI": "BBB Fund",
            "TARIH": "01.01.2026",
            "FIYAT": "2,50",
        },
    ]
    session = MockSession(payload)
    collector = TefasCollector(CollectorConfig(request_delay_seconds=0), session=session)

    result = collector.fetch_all_funds_history(
        start_date=date(2026, 1, 1),
        end_date=date(2026, 1, 1),
    )

    assert [record.fund_code for record in result.records] == ["AAA", "BBB"]
    assert [record.fund_title for record in result.records] == ["AAA Fund", "BBB Fund"]
    assert [record.price for record in result.records] == [1.25, 2.5]
    assert "fonkod" not in session.requests[0]["data"]


def test_collector_sends_fundturkey_headers():
    session = MockSession([])
    collector = TefasCollector(CollectorConfig(request_delay_seconds=0), session=session)

    collector.fetch_fund_history(
        fund_code="AFT",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 1, 1),
    )

    headers = session.requests[0]["headers"]
    assert headers["Origin"] == "https://fundturkey.com.tr"
    assert headers["Referer"] == "https://fundturkey.com.tr/TarihselVeriler.aspx"
    assert headers["X-Requested-With"] == "XMLHttpRequest"
    assert headers["User-Agent"].startswith("Mozilla/5.0")


def test_collector_raises_clear_error_for_disabled_endpoint_response():
    session = MockSession("ERR-006 Method not found or disabled")
    collector = TefasCollector(CollectorConfig(request_delay_seconds=0), session=session)

    with pytest.raises(RuntimeError, match="configured history endpoint appears disabled"):
        collector.fetch_fund_history(
            fund_code="AFT",
            start_date=date(2026, 1, 1),
            end_date=date(2026, 1, 1),
        )

    assert str(DISABLED_HISTORY_ENDPOINT_MESSAGE).startswith("The configured history endpoint")


def test_endpoint_diagnostic_reports_parse_and_record_status():
    payload = [
        {
            "FONKODU": "AFT",
            "FONUNVAN": "AFT Fund",
            "TARIH": "01.01.2026",
            "FIYAT": "1,25",
        }
    ]
    session = MockSession(payload)
    collector = TefasCollector(CollectorConfig(request_delay_seconds=0), session=session)

    diagnostic = collector.test_history_endpoint(
        fund_code="aft",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 1, 1),
    )

    assert diagnostic["url"] == "https://fundturkey.com.tr/api/DB/BindHistoryInfo"
    assert diagnostic["method"] == "POST"
    assert diagnostic["fund_code"] == "AFT"
    assert diagnostic["http_status"] == 200
    assert diagnostic["json_parsed"] is True
    assert diagnostic["records_found"] is True
    assert diagnostic["record_count"] == 1
