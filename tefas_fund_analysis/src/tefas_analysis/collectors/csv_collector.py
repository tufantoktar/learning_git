from __future__ import annotations

import csv
import logging
import re
import unicodedata
from datetime import date
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from tefas_analysis.config import CollectorConfig
from tefas_analysis.schemas import CollectionResult, FundPriceRecord
from tefas_analysis.utils import parse_tefas_date


logger = logging.getLogger(__name__)

MISSING_CSV_FILE_MESSAGE = "CSV collector source selected but file was not found: {path}"
MISSING_REQUIRED_COLUMNS_MESSAGE = (
    "CSV file must include date, fund_code, and price columns or Turkish equivalents."
)
NO_VALID_RECORDS_MESSAGE = "CSV file was read but no valid fund price records were parsed."

LOGICAL_COLUMN_ALIASES: Dict[str, tuple[str, ...]] = {
    "date": (
        "date",
        "price_date",
        "Tarih",
        "tarih",
        "TARİH",
        "TARIH",
        "Fiyat Tarihi",
        "Veri Tarihi",
    ),
    "fund_code": (
        "fund_code",
        "code",
        "Fon Kodu",
        "FonKodu",
        "FONKODU",
        "FON KODU",
        "Kod",
        "Fon",
    ),
    "fund_title": (
        "fund_title",
        "title",
        "name",
        "Fon Adı",
        "Fon Unvanı",
        "Fonun Ünvanı",
        "FONUNVAN",
        "FONUNVANI",
        "Unvan",
    ),
    "price": (
        "price",
        "nav",
        "unit_price",
        "Fiyat",
        "Fon Fiyatı",
        "Birim Fiyat",
        "FIYAT",
        "BIRIMFIYAT",
    ),
    "shares": (
        "shares",
        "share_count",
        "Tedavüldeki Pay Sayısı",
        "Pay Sayısı",
        "Pay",
        "TEDPAYSAYISI",
        "PAYADEDI",
    ),
    "fund_size": (
        "fund_size",
        "total_value",
        "portfolio_size",
        "Fon Toplam Değer",
        "Fon Toplam Değeri",
        "Fon Büyüklüğü",
        "Portföy Büyüklüğü",
        "FONBUYUKLUK",
        "PORTFOYBUYUKLUK",
        "FON_TOPLAM_DEGER",
    ),
    "investor_count": (
        "investor_count",
        "investors",
        "Yatırımcı Sayısı",
        "Kişi Sayısı",
        "KISISAYISI",
        "YATIRIMCISAYISI",
    ),
    "category": (
        "category",
        "fund_type",
        "Kategori",
        "Fon Türü",
        "Fon Tipi",
    ),
}


class CsvCollector:
    """Collects TEFAS-style historical fund prices from a local CSV file."""

    def __init__(self, config: CollectorConfig) -> None:
        self.config = config
        self.csv_path = Path(config.csv_path)
        self._records: Optional[List[FundPriceRecord]] = None

    def fetch_multiple(
        self,
        fund_codes: Iterable[str],
        start_date: date,
        end_date: date,
    ) -> List[CollectionResult]:
        records = self._load_records()
        requested_codes = [code.strip().upper() for code in fund_codes if code.strip()]
        results: List[CollectionResult] = []
        for fund_code in requested_codes:
            filtered = [
                record
                for record in records
                if record.fund_code == fund_code and start_date <= record.date <= end_date
            ]
            results.append(
                CollectionResult(
                    fund_code=fund_code,
                    start_date=start_date,
                    end_date=end_date,
                    source=str(self.csv_path),
                    raw_payload={"source": "csv", "csv_path": str(self.csv_path)},
                    records=filtered,
                )
            )
        return results

    def fetch_all_funds_history(
        self,
        start_date: date,
        end_date: date,
        max_funds: Optional[int] = None,
    ) -> CollectionResult:
        filtered = [
            record
            for record in self._load_records()
            if start_date <= record.date <= end_date
        ]
        codes = sorted({record.fund_code for record in filtered})
        if max_funds is not None:
            allowed_codes = set(codes[:max_funds])
            filtered = [record for record in filtered if record.fund_code in allowed_codes]

        return CollectionResult(
            fund_code="ALL",
            start_date=start_date,
            end_date=end_date,
            source=str(self.csv_path),
            raw_payload={"source": "csv", "csv_path": str(self.csv_path)},
            records=filtered,
        )

    @classmethod
    def validate_csv_file(cls, csv_path: str) -> None:
        path = Path(csv_path)
        cls._ensure_file_exists(path)
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            sample = handle.read(4096)
            handle.seek(0)
            dialect = cls._detect_dialect(sample)
            reader = csv.DictReader(handle, dialect=dialect)
            cls._map_columns(reader.fieldnames or [])

    def _load_records(self) -> List[FundPriceRecord]:
        if self._records is None:
            self._records = self._read_records()
        return self._records

    def _read_records(self) -> List[FundPriceRecord]:
        self._ensure_file_exists(self.csv_path)
        with self.csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            sample = handle.read(8192)
            handle.seek(0)
            dialect = self._detect_dialect(sample)
            reader = csv.DictReader(handle, dialect=dialect)
            column_map = self._map_columns(reader.fieldnames or [])
            records = self._parse_rows(reader, column_map)

        if not records:
            raise ValueError(NO_VALID_RECORDS_MESSAGE)
        return sorted(records, key=lambda item: (item.fund_code, item.date))

    def _parse_rows(
        self,
        reader: csv.DictReader,
        column_map: Dict[str, str],
    ) -> List[FundPriceRecord]:
        records: List[FundPriceRecord] = []
        invalid_dates = 0
        invalid_rows = 0

        for row in reader:
            fund_code = self._row_text(row, column_map["fund_code"]).upper()
            price = self._parse_csv_number(
                self._row_value(row, column_map["price"]),
                prefer_decimal=True,
            )
            if not fund_code or price is None or price <= 0:
                invalid_rows += 1
                continue

            try:
                row_date = self._parse_csv_date(self._row_value(row, column_map["date"]))
            except (TypeError, ValueError):
                invalid_dates += 1
                continue

            record = FundPriceRecord(
                fund_code=fund_code,
                date=row_date,
                price=price,
                fund_title=self._optional_text(row, column_map, "fund_title"),
                shares=self._optional_number(row, column_map, "shares"),
                fund_size=self._optional_number(row, column_map, "fund_size"),
                investor_count=self._optional_number(row, column_map, "investor_count"),
                raw=self._raw_payload(row, column_map),
            )
            records.append(record)

        if invalid_dates:
            logger.warning("Skipped %s CSV rows with invalid dates.", invalid_dates)
        if invalid_rows:
            logger.warning("Skipped %s CSV rows with missing required values.", invalid_rows)
        return records

    @classmethod
    def _map_columns(cls, fieldnames: List[str]) -> Dict[str, str]:
        normalized_to_field = {
            cls._normalize_column_name(fieldname): fieldname
            for fieldname in fieldnames
            if fieldname is not None
        }
        mapped: Dict[str, str] = {}
        for logical_name, aliases in LOGICAL_COLUMN_ALIASES.items():
            for alias in aliases:
                fieldname = normalized_to_field.get(cls._normalize_column_name(alias))
                if fieldname is not None:
                    mapped[logical_name] = fieldname
                    break

        if not {"date", "fund_code", "price"}.issubset(mapped):
            raise ValueError(MISSING_REQUIRED_COLUMNS_MESSAGE)
        return mapped

    @staticmethod
    def _ensure_file_exists(path: Path) -> None:
        if not path.exists():
            raise FileNotFoundError(MISSING_CSV_FILE_MESSAGE.format(path=path))
        if not path.is_file():
            raise FileNotFoundError(MISSING_CSV_FILE_MESSAGE.format(path=path))

    @staticmethod
    def _detect_dialect(sample: str) -> csv.Dialect:
        try:
            return csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            delimiter = max(",;\t", key=sample.count)
            class FallbackDialect(csv.excel):
                pass

            FallbackDialect.delimiter = delimiter if sample.count(delimiter) else ","
            return FallbackDialect

    @staticmethod
    def _normalize_column_name(value: str) -> str:
        translations = str.maketrans(
            {
                "ı": "i",
                "İ": "i",
                "ş": "s",
                "Ş": "s",
                "ğ": "g",
                "Ğ": "g",
                "ü": "u",
                "Ü": "u",
                "ö": "o",
                "Ö": "o",
                "ç": "c",
                "Ç": "c",
            }
        )
        cleaned = value.strip().translate(translations).casefold()
        cleaned = unicodedata.normalize("NFKD", cleaned)
        cleaned = "".join(char for char in cleaned if not unicodedata.combining(char))
        return re.sub(r"[^a-z0-9]+", "", cleaned)

    @classmethod
    def _parse_csv_number(
        cls,
        value: Any,
        prefer_decimal: bool = False,
    ) -> Optional[float]:
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return float(value)

        cleaned = str(value).strip().replace("\u00a0", "").replace(" ", "")
        if cleaned == "":
            return None
        cleaned = cleaned.replace("₺", "").replace("%", "")

        if "," in cleaned and "." in cleaned:
            if cleaned.rfind(",") > cleaned.rfind("."):
                cleaned = cleaned.replace(".", "").replace(",", ".")
            else:
                cleaned = cleaned.replace(",", "")
        elif "," in cleaned:
            if cleaned.count(",") > 1:
                cleaned = cleaned.replace(",", "")
            else:
                cleaned = cleaned.replace(",", ".")
        elif "." in cleaned and not prefer_decimal and cls._looks_like_thousands(cleaned, "."):
            cleaned = cleaned.replace(".", "")

        try:
            return float(cleaned)
        except ValueError:
            return None

    @staticmethod
    def _parse_csv_date(value: Any) -> date:
        if isinstance(value, str):
            cleaned = value.strip()
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", cleaned):
                return date.fromisoformat(cleaned)
        return parse_tefas_date(value)

    @staticmethod
    def _looks_like_thousands(value: str, separator: str) -> bool:
        groups = value.split(separator)
        if len(groups) < 2:
            return False
        return all(group.isdigit() for group in groups) and all(
            len(group) == 3 for group in groups[1:]
        )

    @staticmethod
    def _row_value(row: Dict[str, Any], fieldname: str) -> Any:
        return row.get(fieldname)

    @classmethod
    def _row_text(cls, row: Dict[str, Any], fieldname: str) -> str:
        value = cls._row_value(row, fieldname)
        if value is None:
            return ""
        return str(value).strip()

    @classmethod
    def _optional_text(
        cls,
        row: Dict[str, Any],
        column_map: Dict[str, str],
        logical_name: str,
    ) -> Optional[str]:
        fieldname = column_map.get(logical_name)
        if fieldname is None:
            return None
        text = cls._row_text(row, fieldname)
        return text or None

    @classmethod
    def _optional_number(
        cls,
        row: Dict[str, Any],
        column_map: Dict[str, str],
        logical_name: str,
    ) -> Optional[float]:
        fieldname = column_map.get(logical_name)
        if fieldname is None:
            return None
        return cls._parse_csv_number(cls._row_value(row, fieldname))

    @classmethod
    def _raw_payload(
        cls,
        row: Dict[str, Any],
        column_map: Dict[str, str],
    ) -> Dict[str, Any]:
        raw = dict(row)
        category = cls._optional_text(row, column_map, "category")
        if category:
            raw["category"] = category
        return raw
