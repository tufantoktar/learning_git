from datetime import date

import pytest
import requests

from tefas_analysis.collectors import (
    TefasCollector,
    TefasEndpointFaultError,
    TefasWafRejectedError,
)
from tefas_analysis.config import CollectorConfig


class MockResponse:
    def __init__(
        self,
        payload=None,
        status_code=200,
        headers=None,
        text=None,
        json_error=False,
    ):
        self.payload = payload
        self.status_code = status_code
        self.headers = headers or {"Content-Type": "application/json"}
        self.text = text if text is not None else str(payload)
        self.json_error = json_error

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}", response=self)

    def json(self):
        if self.json_error:
            raise ValueError("not json")
        return self.payload


class MockSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
        self.cookies = requests.cookies.RequestsCookieJar()
        self.cookie_count_at_post = 0

    def get(self, url, **kwargs):
        self.requests.append({"method": "GET", "url": url, **kwargs})
        self.cookies.set("warmup", "received", domain="www.tefas.gov.tr")
        return self.responses.pop(0)

    def post(self, url, **kwargs):
        self.cookie_count_at_post = len(self.cookies)
        self.requests.append({"method": "POST", "url": url, **kwargs})
        return self.responses.pop(0)


def sample_rows():
    return [
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


def warmup_responses(payload):
    return [MockResponse([]), MockResponse([]), MockResponse(payload)]


def test_all_funds_collector_normalizes_multiple_fund_codes():
    session = MockSession(warmup_responses(sample_rows()))
    collector = TefasCollector(CollectorConfig(request_delay_seconds=0), session=session)

    result = collector.fetch_all_funds_history(
        start_date=date(2026, 1, 1),
        end_date=date(2026, 1, 1),
    )

    assert [request["method"] for request in session.requests] == ["GET", "GET", "POST"]
    assert [record.fund_code for record in result.records] == ["AAA", "BBB"]
    assert [record.fund_title for record in result.records] == ["AAA Fund", "BBB Fund"]
    assert [record.price for record in result.records] == [1.25, 2.5]
    assert "fonkod" not in session.requests[-1]["data"]


def test_warmup_gets_are_called_before_post_and_cookies_are_reused():
    session = MockSession(warmup_responses(sample_rows()[:1]))
    collector = TefasCollector(CollectorConfig(request_delay_seconds=0), session=session)

    result = collector.fetch_fund_history(
        fund_code="AFT",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 1, 1),
    )

    assert [request["method"] for request in session.requests] == ["GET", "GET", "POST"]
    assert session.requests[0]["url"] == "https://www.tefas.gov.tr/"
    assert session.requests[1]["url"] == "https://www.tefas.gov.tr/TarihselVeriler.aspx"
    assert session.cookie_count_at_post == 1
    assert len(result.records) == 1


def test_collector_sends_origin_and_referer_from_host_config():
    session = MockSession(warmup_responses(sample_rows()[:1]))
    config = CollectorConfig(
        host_base_url="https://fundturkey.com.tr",
        history_page_path="/CustomHistory.aspx",
        request_delay_seconds=0,
    )
    collector = TefasCollector(config, session=session)

    collector.fetch_fund_history(
        fund_code="AFT",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 1, 1),
    )

    headers = session.requests[-1]["headers"]
    assert session.requests[-1]["url"] == "https://fundturkey.com.tr/api/DB/BindHistoryInfo"
    assert headers["Origin"] == "https://fundturkey.com.tr"
    assert headers["Referer"] == "https://fundturkey.com.tr/CustomHistory.aspx"
    assert headers["X-Requested-With"] == "XMLHttpRequest"
    assert headers["User-Agent"].startswith("Mozilla/5.0")


def test_json_fault_detection_raises_endpoint_fault_error():
    session = MockSession(
        [
            MockResponse(
                {
                    "fault": {
                        "faultCode": "ERR-006",
                        "faultString": "Method not found or disabled!",
                    }
                }
            )
        ]
    )
    collector = TefasCollector(
        CollectorConfig(warmup_enabled=False, request_delay_seconds=0),
        session=session,
    )

    with pytest.raises(TefasEndpointFaultError, match="ERR-006"):
        collector.fetch_fund_history(
            fund_code="AFT",
            start_date=date(2026, 1, 1),
            end_date=date(2026, 1, 1),
        )


def test_request_rejected_html_detection_raises_waf_error():
    session = MockSession(
        [
            MockResponse(
                text="<html><body>Request Rejected. support ID 123</body></html>",
                headers={"Content-Type": "text/html"},
                json_error=True,
            )
        ]
    )
    collector = TefasCollector(
        CollectorConfig(warmup_enabled=False, request_delay_seconds=0),
        session=session,
    )

    with pytest.raises(TefasWafRejectedError, match="WAF"):
        collector.fetch_fund_history(
            fund_code="AFT",
            start_date=date(2026, 1, 1),
            end_date=date(2026, 1, 1),
        )


def test_endpoint_diagnostic_reports_parse_and_record_status():
    session = MockSession(warmup_responses(sample_rows()[:1]))
    collector = TefasCollector(CollectorConfig(request_delay_seconds=0), session=session)

    diagnostic = collector.test_history_endpoint(
        fund_code="aft",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 1, 1),
    )

    assert diagnostic["history_url"] == "https://www.tefas.gov.tr/api/DB/BindHistoryInfo"
    assert diagnostic["referer"] == "https://www.tefas.gov.tr/TarihselVeriler.aspx"
    assert diagnostic["method"] == "POST"
    assert diagnostic["fund_code"] == "AFT"
    assert diagnostic["http_status"] == 200
    assert diagnostic["json_parsed"] is True
    assert diagnostic["records_found"] is True
    assert diagnostic["records_found_count"] == 1
    assert diagnostic["detected_condition"] == "OK"


def test_diagnostic_classifies_waf_rejected():
    session = MockSession(
        [
            MockResponse([]),
            MockResponse([]),
            MockResponse(
                text="<html><body>Access Denied. Please enable JavaScript.</body></html>",
                headers={"Content-Type": "text/html"},
                json_error=True,
            ),
        ]
    )
    collector = TefasCollector(CollectorConfig(request_delay_seconds=0), session=session)

    diagnostic = collector.diagnose_endpoint(
        fund_code="AFT",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 1, 1),
    )

    assert diagnostic.detected_condition == "WAF_REJECTED"
    assert diagnostic.json_parsed is False
    assert diagnostic.http_status == 200
