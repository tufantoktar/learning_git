from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Dict, Iterable, List, Optional, Sequence

import requests

from tefas_analysis.config import CollectorConfig
from tefas_analysis.schemas import CollectionResult, FundPriceRecord
from tefas_analysis.utils import parse_number, parse_tefas_date


logger = logging.getLogger(__name__)


class TefasCollectorError(RuntimeError):
    """Base class for TEFAS collector errors that callers can classify."""


class TefasWafRejectedError(TefasCollectorError):
    """Raised when TEFAS/FundTurkey returns a WAF or bot-detection response."""


class TefasEndpointFaultError(TefasCollectorError):
    """Raised when the endpoint returns a structured JSON fault payload."""


class TefasNoRecordsError(TefasCollectorError):
    """Raised when a successful endpoint response contains no historical records."""


@dataclass(frozen=True)
class EndpointDiagnosticResult:
    host_base_url: str
    history_url: str
    referer: str
    http_status: Optional[int]
    content_type: str
    response_preview: str
    json_parsed: bool
    records_found_count: int
    cookies_received_count: int
    detected_condition: str
    error_message: Optional[str] = None


class TefasCollector:
    """Collects historical TEFAS fund prices from the TEFAS web endpoint."""

    def __init__(
        self,
        config: CollectorConfig,
        session: Optional[requests.Session] = None,
    ) -> None:
        self.config = config
        self.session = session or requests.Session()
        self._warmup_complete = False

    def fetch_multiple(
        self,
        fund_codes: Iterable[str],
        start_date: date,
        end_date: date,
    ) -> List[CollectionResult]:
        codes = [fund_code.strip().upper() for fund_code in fund_codes if fund_code.strip()]
        results: List[CollectionResult] = []
        for index, fund_code in enumerate(codes):
            results.append(self.fetch_fund_history(fund_code, start_date, end_date))
            if index < len(codes) - 1 and self.config.request_delay_seconds > 0:
                time.sleep(self.config.request_delay_seconds)
        return results

    def fetch_all_funds_history(
        self,
        start_date: date,
        end_date: date,
        max_funds: Optional[int] = None,
    ) -> CollectionResult:
        """Fetch history for all funds returned by TEFAS for the configured fund type.

        TEFAS history endpoint returns all fund rows when `fonkod` is omitted. This mode is
        used for broad market scanning. `max_funds` is useful for local smoke tests.
        """
        raw_payload = self._request_history(None, start_date, end_date)
        records = self._normalize_records("ALL", raw_payload, start_date, end_date)
        if not records:
            raise TefasNoRecordsError(self._no_records_message("ALL"))
        if max_funds is not None:
            allowed_codes = self._first_n_codes(records, max_funds)
            records = [record for record in records if record.fund_code in allowed_codes]
        return CollectionResult(
            fund_code="ALL",
            start_date=start_date,
            end_date=end_date,
            source=self.config.history_url,
            raw_payload=raw_payload,
            records=records,
        )

    def fetch_fund_history(
        self,
        fund_code: str,
        start_date: date,
        end_date: date,
    ) -> CollectionResult:
        normalized_code = fund_code.strip().upper()
        raw_payload = self._request_history(normalized_code, start_date, end_date)
        records = self._normalize_records(
            normalized_code,
            raw_payload,
            start_date,
            end_date,
        )
        if not records:
            raise TefasNoRecordsError(self._no_records_message(normalized_code))
        return CollectionResult(
            fund_code=normalized_code,
            start_date=start_date,
            end_date=end_date,
            source=self.config.history_url,
            raw_payload=raw_payload,
            records=records,
        )

    def _request_history(
        self,
        fund_code: Optional[str],
        start_date: date,
        end_date: date,
    ) -> Any:
        payload = self._history_payload(fund_code, start_date, end_date)
        headers = self._history_headers()

        last_error: Optional[Exception] = None
        for attempt in range(1, self.config.max_retries + 1):
            try:
                self._warm_up()
                response = self.session.post(
                    self.config.history_url,
                    data=payload,
                    headers=headers,
                    timeout=self.config.timeout_seconds,
                )
                return self._parse_response_payload(response)
            except TefasCollectorError:
                raise
            except (requests.RequestException, ValueError) as exc:
                last_error = exc
                logger.warning(
                    "TEFAS fetch failed for %s on attempt %s/%s: %s",
                    fund_code or "ALL",
                    attempt,
                    self.config.max_retries,
                    exc,
                )
                if attempt < self.config.max_retries:
                    time.sleep(min(2 * attempt, 10))

        raise RuntimeError(f"TEFAS fetch failed for {fund_code or 'ALL'}") from last_error

    def diagnose_endpoint(
        self,
        fund_code: str = "AFT",
        start_date: Optional[date] = None,
        end_date: Optional[date] = None,
    ) -> EndpointDiagnosticResult:
        """Run a warmup + diagnostic POST against the configured history endpoint."""
        diagnostic_end_date = end_date or date.today()
        diagnostic_start_date = start_date or diagnostic_end_date - timedelta(days=30)
        normalized_code = fund_code.strip().upper()
        payload = self._history_payload(
            normalized_code,
            diagnostic_start_date,
            diagnostic_end_date,
        )

        try:
            self._warm_up()
            response = self.session.post(
                self.config.history_url,
                data=payload,
                headers=self._history_headers(),
                timeout=self.config.timeout_seconds,
            )
        except requests.RequestException as exc:
            return EndpointDiagnosticResult(
                host_base_url=self.config.host_base_url,
                history_url=self.config.history_url,
                referer=self.config.history_page_url,
                http_status=None,
                content_type="",
                response_preview="",
                json_parsed=False,
                records_found_count=0,
                cookies_received_count=self._cookie_count(),
                detected_condition="UNKNOWN_ERROR",
                error_message=str(exc),
            )

        content_type = getattr(response, "headers", {}).get("Content-Type", "")
        preview = self._response_preview(response)
        json_parsed = False
        record_count = 0
        condition = "UNKNOWN_ERROR"
        error_message: Optional[str] = None

        if self._is_waf_rejection_text(getattr(response, "text", "")):
            condition = "WAF_REJECTED"
            error_message = self._waf_message()
        else:
            try:
                raw_payload = response.json()
                json_parsed = True
            except ValueError:
                if "text/html" in content_type.lower():
                    condition = "WAF_REJECTED"
                    error_message = self._html_response_message()
                else:
                    condition = "UNKNOWN_ERROR"
                    error_message = "Response was not parseable JSON."
            else:
                fault = self._extract_fault(raw_payload)
                if fault is not None:
                    condition = "JSON_FAULT"
                    error_message = self._fault_message(fault)
                else:
                    try:
                        response.raise_for_status()
                    except requests.RequestException as exc:
                        condition = "UNKNOWN_ERROR"
                        error_message = str(exc)
                    else:
                        record_count = len(
                            self._normalize_records(
                                normalized_code,
                                raw_payload,
                                diagnostic_start_date,
                                diagnostic_end_date,
                            )
                        )
                        if record_count:
                            condition = "OK"
                        else:
                            condition = "NO_RECORDS"
                            error_message = self._no_records_message(normalized_code)

        return EndpointDiagnosticResult(
            host_base_url=self.config.host_base_url,
            history_url=self.config.history_url,
            referer=self.config.history_page_url,
            http_status=getattr(response, "status_code", None),
            content_type=content_type,
            response_preview=preview,
            json_parsed=json_parsed,
            records_found_count=record_count,
            cookies_received_count=self._cookie_count(),
            detected_condition=condition,
            error_message=error_message,
        )

    def test_history_endpoint(
        self,
        fund_code: str,
        start_date: date,
        end_date: date,
    ) -> Dict[str, Any]:
        """Backward-compatible dictionary diagnostic wrapper."""
        diagnostic = self.diagnose_endpoint(fund_code, start_date, end_date)
        normalized_code = fund_code.strip().upper()
        return {
            "host_base_url": diagnostic.host_base_url,
            "history_url": diagnostic.history_url,
            "url": diagnostic.history_url,
            "referer": diagnostic.referer,
            "method": "POST",
            "fund_code": normalized_code,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "http_status": diagnostic.http_status,
            "content_type": diagnostic.content_type,
            "response_preview": diagnostic.response_preview,
            "json_parsed": diagnostic.json_parsed,
            "records_found": diagnostic.records_found_count > 0,
            "record_count": diagnostic.records_found_count,
            "records_found_count": diagnostic.records_found_count,
            "cookies_received_count": diagnostic.cookies_received_count,
            "detected_condition": diagnostic.detected_condition,
            "parse_error": None if diagnostic.json_parsed else diagnostic.error_message,
            "error_message": diagnostic.error_message,
        }

    def _history_payload(
        self,
        fund_code: Optional[str],
        start_date: date,
        end_date: date,
    ) -> Dict[str, str]:
        payload = {
            "fontip": self.config.fund_type,
            "bastarih": start_date.strftime("%d.%m.%Y"),
            "bittarih": end_date.strftime("%d.%m.%Y"),
        }
        if fund_code:
            payload["fonkod"] = fund_code
        return payload

    def _history_headers(self) -> Dict[str, str]:
        return {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
            "Connection": "keep-alive",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": self.config.user_agent,
            "Origin": self.config.host_base_url,
            "Referer": self.config.history_page_url,
            "X-Requested-With": "XMLHttpRequest",
        }

    def _warmup_headers(self) -> Dict[str, str]:
        return {
            "Accept": (
                "text/html,application/xhtml+xml,application/xml;q=0.9,"
                "image/avif,image/webp,*/*;q=0.8"
            ),
            "Accept-Language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
            "Connection": "keep-alive",
            "User-Agent": self.config.user_agent,
        }

    def _warm_up(self) -> None:
        if self._warmup_complete or not self.config.warmup_enabled:
            return

        urls = [self.config.warmup_url]
        if self.config.history_page_url not in urls:
            urls.append(self.config.history_page_url)

        for url in urls:
            try:
                response = self.session.get(
                    url,
                    headers=self._warmup_headers(),
                    timeout=self.config.timeout_seconds,
                    allow_redirects=True,
                )
                if response.status_code != 200:
                    logger.warning(
                        "TEFAS warmup GET returned HTTP %s for %s",
                        response.status_code,
                        url,
                    )
            except requests.RequestException as exc:
                logger.warning("TEFAS warmup GET failed for %s: %s", url, exc)

        self._warmup_complete = True

    def _parse_response_payload(self, response: requests.Response) -> Any:
        if self._is_waf_rejection_text(getattr(response, "text", "")):
            raise TefasWafRejectedError(self._waf_message())

        try:
            raw_payload = response.json()
        except ValueError as exc:
            content_type = response.headers.get("Content-Type", "").lower()
            if "text/html" in content_type:
                raise TefasWafRejectedError(self._html_response_message()) from exc
            response.raise_for_status()
            raise ValueError("TEFAS response was not parseable JSON.") from exc

        fault = self._extract_fault(raw_payload)
        if fault is not None:
            raise TefasEndpointFaultError(self._fault_message(fault))

        response.raise_for_status()
        return raw_payload

    @staticmethod
    def _is_waf_rejection_text(text: str) -> bool:
        lowered = text.lower()
        return any(
            marker in lowered
            for marker in (
                "request rejected",
                "support id",
                "please enable javascript",
                "access denied",
            )
        )

    @staticmethod
    def _extract_fault(raw_payload: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(raw_payload, dict):
            return None
        fault = raw_payload.get("fault")
        if isinstance(fault, dict):
            return fault
        return None

    def _fault_message(self, fault: Dict[str, Any]) -> str:
        code = fault.get("faultCode", "UNKNOWN")
        text = fault.get("faultString", "Endpoint returned a fault payload.")
        return (
            f"TEFAS endpoint returned JSON fault {code}: {text}. "
            "The historical endpoint may be WAF-protected or temporarily disabled. "
            f"Run `python main.py --test-tefas-endpoint --test-fund-code AFT "
            f"--test-host {self.config.host_base_url}` to diagnose. "
            "Try a lower request rate by increasing request_delay_seconds, try from "
            "a local residential network, or use a CSV collector fallback if "
            "available. CSV fallback is not implemented in this repo yet; TODO add "
            "one or load manually exported TEFAS/FundTurkey data. This collector "
            "does not bypass CAPTCHA or human verification."
        )

    def _waf_message(self) -> str:
        return (
            "TEFAS/FundTurkey returned a WAF or bot-detection rejection. "
            "The historical endpoint may be WAF-protected even when it still exists. "
            f"Run `python main.py --test-tefas-endpoint --test-fund-code AFT "
            f"--test-host {self.config.host_base_url}` to diagnose. "
            "Try a lower request rate by increasing request_delay_seconds, test one "
            "selected fund before broad collection, try from a local residential "
            "network, or use a CSV collector fallback if available. For all-funds "
            "runs, use --max-funds for a smoke test. CSV fallback is not implemented "
            "in this repo yet; TODO add one or load manually exported TEFAS/FundTurkey "
            "data. This collector does not bypass CAPTCHA or human verification."
        )

    def _html_response_message(self) -> str:
        return (
            "TEFAS/FundTurkey returned text/html instead of JSON, which commonly "
            "indicates WAF or bot-detection handling for this endpoint. "
            f"Run `python main.py --test-tefas-endpoint --test-fund-code AFT "
            f"--test-host {self.config.host_base_url}` to inspect the response. "
            "Try a lower request rate by increasing request_delay_seconds, try from "
            "a local residential network, or use a CSV collector fallback if "
            "available. CSV fallback is not implemented in this repo yet; TODO add "
            "one or load manually exported TEFAS/FundTurkey data. This collector "
            "does not bypass CAPTCHA or human verification."
        )

    def _no_records_message(self, fund_code: str) -> str:
        target = "all funds" if not fund_code or fund_code in {"*", "ALL"} else fund_code
        return (
            f"TEFAS/FundTurkey returned HTTP 200 but no records for {target}. "
            "This can mean the historical endpoint is WAF-protected and returning "
            "an empty payload, or that the sample/date range has no data. "
            f"Run `python main.py --test-tefas-endpoint --test-fund-code AFT "
            f"--test-host {self.config.host_base_url}` to diagnose. "
            "Test one selected fund first, try a lower request rate by increasing "
            "request_delay_seconds, use --max-funds for all-funds smoke tests, or "
            "use a CSV collector fallback if available. CSV fallback is not "
            "implemented in this repo yet; TODO add one or load manually exported "
            "TEFAS/FundTurkey data."
        )

    def _cookie_count(self) -> int:
        try:
            return len(self.session.cookies)
        except TypeError:
            return 0

    @staticmethod
    def _response_preview(response: Any, max_chars: int = 500) -> str:
        text = getattr(response, "text", None)
        if text:
            return text[:max_chars]
        try:
            return str(response.json())[:max_chars]
        except ValueError:
            return ""

    def _normalize_records(
        self,
        requested_fund_code: str,
        raw_payload: Any,
        start_date: date,
        end_date: date,
    ) -> List[FundPriceRecord]:
        rows = self._extract_rows(raw_payload)
        records: List[FundPriceRecord] = []
        for row in rows:
            try:
                row_date = self._first_date(row, ["TARIH", "Tarih", "tarih", "DATE"])
                price = self._first_number(
                    row,
                    ["FIYAT", "Fiyat", "fiyat", "BIRIMFIYAT", "FONFIYAT"],
                )
                if row_date is None or price is None or price <= 0:
                    continue
                if row_date < start_date or row_date > end_date:
                    continue

                fund_code = str(
                    row.get("FONKODU")
                    or row.get("FONKOD")
                    or row.get("FON KODU")
                    or row.get("FonKodu")
                    or requested_fund_code
                ).strip().upper()
                if not fund_code or fund_code == "ALL":
                    continue

                records.append(
                    FundPriceRecord(
                        fund_code=fund_code,
                        date=row_date,
                        price=price,
                        fund_title=self._first_text(
                            row,
                            [
                                "FONUNVAN",
                                "FonUnvan",
                                "FONUNVANI",
                                "FONADI",
                                "FON ADI",
                                "UNVAN",
                            ],
                        ),
                        shares=self._first_number(
                            row,
                            ["TEDPAYSAYISI", "PAYADEDI"],
                        ),
                        fund_size=self._first_number(
                            row,
                            ["PORTFOYBUYUKLUK", "FONBUYUKLUK", "FON_TOPLAM_DEGER"],
                        ),
                        investor_count=self._first_number(
                            row,
                            ["KISISAYISI", "YATIRIMCISAYISI"],
                        ),
                        raw=dict(row),
                    )
                )
            except ValueError:
                logger.debug("Skipping unparseable TEFAS row for %s: %s", requested_fund_code, row)

        return sorted(records, key=lambda item: (item.fund_code, item.date))

    @staticmethod
    def _extract_rows(raw_payload: Any) -> List[Dict[str, Any]]:
        if isinstance(raw_payload, list):
            return [row for row in raw_payload if isinstance(row, dict)]
        if isinstance(raw_payload, dict):
            for key in ("data", "Data", "DATA", "items", "Items"):
                value = raw_payload.get(key)
                if isinstance(value, list):
                    return [row for row in value if isinstance(row, dict)]
        return []

    @staticmethod
    def _first_n_codes(records: Sequence[FundPriceRecord], max_funds: int) -> set[str]:
        codes: List[str] = []
        seen = set()
        for record in records:
            if record.fund_code not in seen:
                seen.add(record.fund_code)
                codes.append(record.fund_code)
            if len(codes) >= max_funds:
                break
        return set(codes)

    @staticmethod
    def _first_number(row: Dict[str, Any], keys: List[str]) -> Optional[float]:
        for key in keys:
            if key in row:
                value = parse_number(row[key])
                if value is not None:
                    return value
        return None

    @staticmethod
    def _first_date(row: Dict[str, Any], keys: List[str]) -> Optional[date]:
        for key in keys:
            if key in row and row[key] is not None:
                return parse_tefas_date(row[key])
        return None

    @staticmethod
    def _first_text(row: Dict[str, Any], keys: List[str]) -> Optional[str]:
        for key in keys:
            value = row.get(key)
            if value is not None and str(value).strip():
                return str(value).strip()
        return None
