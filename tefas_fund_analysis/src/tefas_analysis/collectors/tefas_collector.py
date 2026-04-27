from __future__ import annotations

import logging
import time
from datetime import date
from typing import Any, Dict, Iterable, List, Optional, Sequence

import requests

from tefas_analysis.config import CollectorConfig
from tefas_analysis.schemas import CollectionResult, FundPriceRecord
from tefas_analysis.utils import parse_number, parse_tefas_date


logger = logging.getLogger(__name__)

DISABLED_HISTORY_ENDPOINT_MESSAGE = (
    "The configured history endpoint appears disabled. Check TEFAS_BASE_URL. "
    "Current recommended endpoint is https://fundturkey.com.tr/api/DB/BindHistoryInfo"
)
DISABLED_HISTORY_ENDPOINT_MARKER = "ERR-006 Method not found or disabled"


class TefasCollector:
    """Collects historical TEFAS fund prices from the TEFAS web endpoint."""

    def __init__(
        self,
        config: CollectorConfig,
        session: Optional[requests.Session] = None,
    ) -> None:
        self.config = config
        self.session = session or requests.Session()

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
        if max_funds is not None:
            allowed_codes = self._first_n_codes(records, max_funds)
            records = [record for record in records if record.fund_code in allowed_codes]
        return CollectionResult(
            fund_code="ALL",
            start_date=start_date,
            end_date=end_date,
            source=self.config.base_url,
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
        return CollectionResult(
            fund_code=normalized_code,
            start_date=start_date,
            end_date=end_date,
            source=self.config.base_url,
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
                response = self.session.post(
                    self.config.base_url,
                    data=payload,
                    headers=headers,
                    timeout=self.config.timeout_seconds,
                )
                self._raise_if_disabled_endpoint(getattr(response, "text", ""))
                response.raise_for_status()
                raw_payload = response.json()
                self._raise_if_disabled_endpoint(raw_payload)
                return raw_payload
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

    def test_history_endpoint(
        self,
        fund_code: str,
        start_date: date,
        end_date: date,
    ) -> Dict[str, Any]:
        """Run a single diagnostic POST against the configured history endpoint."""
        normalized_code = fund_code.strip().upper()
        payload = self._history_payload(normalized_code, start_date, end_date)
        response = self.session.post(
            self.config.base_url,
            data=payload,
            headers=self._history_headers(),
            timeout=self.config.timeout_seconds,
        )
        preview = self._response_preview(response)
        json_parsed = False
        records_found = False
        record_count = 0
        parse_error = None
        try:
            raw_payload = response.json()
            json_parsed = True
            records = self._normalize_records(
                normalized_code,
                raw_payload,
                start_date,
                end_date,
            )
            record_count = len(records)
            records_found = record_count > 0
        except ValueError as exc:
            parse_error = str(exc)

        return {
            "url": self.config.base_url,
            "method": "POST",
            "fund_code": normalized_code,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "http_status": getattr(response, "status_code", "n/a"),
            "content_type": getattr(response, "headers", {}).get("Content-Type", "n/a"),
            "response_preview": preview,
            "json_parsed": json_parsed,
            "records_found": records_found,
            "record_count": record_count,
            "parse_error": parse_error,
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
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": self.config.user_agent,
            "Origin": self.config.origin,
            "Referer": self.config.referer,
            "X-Requested-With": "XMLHttpRequest",
        }

    @classmethod
    def _raise_if_disabled_endpoint(cls, value: Any) -> None:
        if cls._contains_disabled_endpoint_marker(value):
            raise RuntimeError(DISABLED_HISTORY_ENDPOINT_MESSAGE)

    @classmethod
    def _contains_disabled_endpoint_marker(cls, value: Any) -> bool:
        if isinstance(value, str):
            return DISABLED_HISTORY_ENDPOINT_MARKER in value
        if isinstance(value, dict):
            return any(cls._contains_disabled_endpoint_marker(item) for item in value.values())
        if isinstance(value, list):
            return any(cls._contains_disabled_endpoint_marker(item) for item in value)
        return False

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
