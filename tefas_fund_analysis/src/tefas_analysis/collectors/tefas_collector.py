from __future__ import annotations

import logging
import time
from datetime import date
from typing import Any, Dict, Iterable, List, Optional

import requests

from tefas_analysis.config import CollectorConfig
from tefas_analysis.schemas import CollectionResult, FundPriceRecord
from tefas_analysis.utils import parse_number, parse_tefas_date


logger = logging.getLogger(__name__)


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
        codes = [fund_code.strip().upper() for fund_code in fund_codes]
        results: List[CollectionResult] = []
        for index, fund_code in enumerate(codes):
            results.append(self.fetch_fund_history(fund_code, start_date, end_date))
            if index < len(codes) - 1 and self.config.request_delay_seconds > 0:
                time.sleep(self.config.request_delay_seconds)
        return results

    def fetch_fund_history(
        self,
        fund_code: str,
        start_date: date,
        end_date: date,
    ) -> CollectionResult:
        normalized_code = fund_code.strip().upper()
        payload = {
            "fontip": self.config.fund_type,
            "fonkod": normalized_code,
            "bastarih": start_date.strftime("%d.%m.%Y"),
            "bittarih": end_date.strftime("%d.%m.%Y"),
        }
        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": self.config.user_agent,
            "X-Requested-With": "XMLHttpRequest",
        }

        last_error: Optional[Exception] = None
        raw_payload: Any = []
        for attempt in range(1, self.config.max_retries + 1):
            try:
                response = self.session.post(
                    self.config.base_url,
                    data=payload,
                    headers=headers,
                    timeout=self.config.timeout_seconds,
                )
                response.raise_for_status()
                raw_payload = response.json()
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
            except (requests.RequestException, ValueError) as exc:
                last_error = exc
                logger.warning(
                    "TEFAS fetch failed for %s on attempt %s/%s: %s",
                    normalized_code,
                    attempt,
                    self.config.max_retries,
                    exc,
                )
                if attempt < self.config.max_retries:
                    time.sleep(min(2 * attempt, 10))

        raise RuntimeError(f"TEFAS fetch failed for {normalized_code}") from last_error

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
                    or row.get("FonKodu")
                    or requested_fund_code
                ).strip().upper()

                records.append(
                    FundPriceRecord(
                        fund_code=fund_code,
                        date=row_date,
                        price=price,
                        fund_title=self._first_text(
                            row,
                            ["FONUNVAN", "FonUnvan", "FONUNVANI", "UNVAN"],
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
