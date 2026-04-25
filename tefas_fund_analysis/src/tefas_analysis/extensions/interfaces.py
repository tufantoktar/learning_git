from __future__ import annotations

from typing import Mapping, Protocol, Sequence

from tefas_analysis.schemas import FundAnalysisResult


class GlobalMarketDataProvider(Protocol):
    """Future extension point for benchmark, FX, rates, and global index data."""

    def get_context(self) -> Mapping[str, float]:
        raise NotImplementedError


class NewsSentimentProvider(Protocol):
    """Future extension point for fund, issuer, and macro news sentiment."""

    def score(self, fund_codes: Sequence[str]) -> Mapping[str, float]:
        raise NotImplementedError


class SocialSentimentProvider(Protocol):
    """Future extension point for X/Twitter or other social data."""

    def score(self, fund_codes: Sequence[str]) -> Mapping[str, float]:
        raise NotImplementedError


class CommentaryProvider(Protocol):
    """Future extension point for AI-generated commentary."""

    def create_commentary(self, result: FundAnalysisResult) -> str:
        raise NotImplementedError
