from __future__ import annotations

import unicodedata
from enum import Enum
from typing import Mapping, Optional


class FundCategory(str, Enum):
    MONEY_MARKET = "MONEY_MARKET"
    EQUITY = "EQUITY"
    VARIABLE = "VARIABLE"
    DEBT = "DEBT"
    PRECIOUS_METALS = "PRECIOUS_METALS"
    FOREIGN_EQUITY = "FOREIGN_EQUITY"
    PARTICIPATION = "PARTICIPATION"
    FUND_BASKET = "FUND_BASKET"
    UNKNOWN = "UNKNOWN"


class CategoryEngine:
    """Deterministic TEFAS fund category classifier based on local metadata."""

    KEYWORDS: tuple[tuple[FundCategory, tuple[str, ...]], ...] = (
        (
            FundCategory.MONEY_MARKET,
            ("para piyasasi", "ppf", "kisa vadeli"),
        ),
        (
            FundCategory.FUND_BASKET,
            ("fon sepeti",),
        ),
        (
            FundCategory.PRECIOUS_METALS,
            ("altin", "gumus", "kiymetli maden"),
        ),
        (
            FundCategory.FOREIGN_EQUITY,
            ("yabanci", "teknoloji", "nasdaq", "amerika", "abd", "global", "s&p", "s&p 500"),
        ),
        (
            FundCategory.EQUITY,
            ("hisse senedi", "hisse", "bist", "endeks"),
        ),
        (
            FundCategory.DEBT,
            ("borclanma araclari", "tahvil", "bono", "kira sertifikasi", "eurobond"),
        ),
        (
            FundCategory.VARIABLE,
            ("degisken",),
        ),
        (
            FundCategory.PARTICIPATION,
            ("katilim",),
        ),
    )

    def classify(
        self,
        fund_title: Optional[str] = None,
        metadata: Optional[Mapping[str, object]] = None,
    ) -> FundCategory:
        text = self._classification_text(fund_title, metadata)
        if not text:
            return FundCategory.UNKNOWN

        normalized = self._normalize(text)
        for category, keywords in self.KEYWORDS:
            if any(keyword in normalized for keyword in keywords):
                return category
        return FundCategory.UNKNOWN

    @classmethod
    def _classification_text(
        cls,
        fund_title: Optional[str],
        metadata: Optional[Mapping[str, object]],
    ) -> str:
        parts = []
        if fund_title:
            parts.append(fund_title)
        if metadata:
            for value in metadata.values():
                if value is not None:
                    parts.append(str(value))
        return " ".join(parts).strip()

    @staticmethod
    def _normalize(value: str) -> str:
        translated = value.translate(
            str.maketrans(
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
        )
        decomposed = unicodedata.normalize("NFKD", translated.casefold())
        return "".join(char for char in decomposed if not unicodedata.combining(char))
