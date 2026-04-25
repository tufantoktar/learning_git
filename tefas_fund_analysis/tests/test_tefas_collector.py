from datetime import date

from tefas_analysis.collectors.tefas_collector import TefasCollector
from tefas_analysis.config import CollectorConfig


class MockResponse:
    def __init__(self, payload):
        self.payload = payload

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
