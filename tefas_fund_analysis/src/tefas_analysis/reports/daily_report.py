from __future__ import annotations

import csv
from collections import defaultdict
from datetime import date
from pathlib import Path
from typing import Dict, List

from tefas_analysis.reports.localization import (
    display_analytical_tag,
    display_category,
    display_money_flow_label,
    display_signal,
    normalize_language,
    t,
)
from tefas_analysis.schemas import (
    AnalyticalTag,
    FundAnalysisResult,
    MoneyFlowLabel,
    ReportArtifact,
    SignalClass,
)
from tefas_analysis.utils import pct, score


class DailyReportGenerator:
    """Writes localized Markdown and CSV daily TEFAS analysis reports."""

    def __init__(self, output_dir: str, language: str = "tr") -> None:
        self.output_dir = Path(output_dir)
        self.language = normalize_language(language)

    def generate(
        self,
        results: List[FundAnalysisResult],
        report_date: date,
    ) -> ReportArtifact:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        sorted_results = sorted(
            results,
            key=lambda item: (-item.recommendation.final_score, item.fund_code),
        )
        summary = self._summary(sorted_results)
        markdown_content = self._markdown(sorted_results, report_date, summary)

        suffix = self.language
        markdown_path = self.output_dir / f"tefas_daily_report_{report_date.isoformat()}_{suffix}.md"
        csv_path = self.output_dir / f"tefas_daily_report_{report_date.isoformat()}_{suffix}.csv"

        markdown_path.write_text(markdown_content, encoding="utf-8")
        self._write_csv(sorted_results, csv_path, report_date)

        return ReportArtifact(
            report_date=report_date,
            markdown_path=str(markdown_path),
            csv_path=str(csv_path),
            markdown_content=markdown_content,
            summary=summary,
        )

    def _markdown(
        self,
        results: List[FundAnalysisResult],
        report_date: date,
        summary: Dict[str, int],
    ) -> str:
        lines: List[str] = [
            f"# {t('report_title', self.language)} - {report_date.isoformat()}",
            "",
            t("disclaimer", self.language),
            "",
            f"## {t('summary', self.language)}",
            "",
            f"- {t('funds_analyzed', self.language)}: {summary['funds_analyzed']}",
        ]
        for signal in SignalClass:
            lines.append(
                f"- {self._signal(signal)}: {summary.get(signal.value, 0)}"
            )

        lines.extend(["", f"## {t('category_summary', self.language)}", ""])
        for category, count in self._category_summary(results).items():
            lines.append(f"- {category}: {count}")

        lines.extend(["", f"## {t('money_flow_summary', self.language)}", ""])
        for label, count in self._money_flow_summary(results).items():
            lines.append(f"- {label}: {count}")

        lines.extend(["", f"## {t('analytical_tag_summary', self.language)}", ""])
        for tag, count in self._analytical_tag_summary(results).items():
            lines.append(f"- {tag}: {count}")

        lines.extend(
            [
                "",
                f"## {t('top_funds_by_score', self.language)}",
                "",
                self._table_header(
                    [
                        "rank",
                        "fund_code",
                        "fund_title",
                        "category",
                        "signal",
                        "score",
                        "momentum",
                        "risk",
                        "one_month_return",
                        "three_month_return",
                    ]
                ),
                self._table_align(["right", "left", "left", "left", "left", "right", "right", "right", "right", "right"]),
            ]
        )
        for rank, result in enumerate(results[:10], start=1):
            lines.append(
                self._table_row(
                    [
                        str(rank),
                        result.fund_code,
                        self._fund_title(result),
                        self._category(result),
                        self._signal(result.recommendation.signal),
                        score(result.recommendation.final_score),
                        score(result.performance.momentum_score),
                        score(result.risk.risk_score),
                        pct(result.performance.monthly_return),
                        pct(result.performance.three_month_return),
                    ]
                )
            )
        if not results:
            lines.append(self._empty_row(10))

        self._append_top_by_category(lines, results)
        self._append_money_flow_section(
            lines,
            results,
            MoneyFlowLabel.STRONG_INFLOW,
            "strong_inflow_funds",
        )
        self._append_money_flow_section(
            lines,
            results,
            MoneyFlowLabel.STRONG_OUTFLOW,
            "strong_outflow_funds",
        )

        for tag, heading_key in [
            (AnalyticalTag.OVERHEATED, "overheated_funds"),
            (AnalyticalTag.COOLING_MOMENTUM, "cooling_momentum_funds"),
            (AnalyticalTag.CONSISTENT_UPTREND, "consistent_uptrend_funds"),
            (AnalyticalTag.HIGH_DRAWDOWN, "high_drawdown_funds"),
            (AnalyticalTag.LOW_LIQUIDITY, "low_liquidity_funds"),
            (AnalyticalTag.RECOVERY_WATCH, "recovery_watch_funds"),
        ]:
            self._append_tag_section(lines, results, tag, heading_key)

        self._append_risky_section(lines, results)
        self._append_full_score_table(lines, results)

        lines.extend(["", f"## {t('fund_notes', self.language)}", ""])
        if results:
            for result in results:
                lines.append(f"- {self._fund_label(result)}: {result.recommendation.explanation}")
        else:
            lines.append("- n/a")

        return "\n".join(lines) + "\n"

    def _write_csv(
        self,
        results: List[FundAnalysisResult],
        csv_path: Path,
        report_date: date,
    ) -> None:
        with csv_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=[
                    "report_date",
                    "fund_code",
                    "fund_title",
                    "category",
                    "signal",
                    "final_score",
                    "momentum_score",
                    "risk_score",
                    "daily_return",
                    "weekly_return",
                    "monthly_return",
                    "three_month_return",
                    "volatility_30",
                    "max_drawdown_90",
                    "money_flow_score",
                    "money_flow_label",
                    "analytical_tags",
                    "fund_size_latest",
                    "investor_count_latest",
                    "fund_size_change_1d",
                    "fund_size_change_1w",
                    "fund_size_change_1m",
                    "investor_count_change_1w",
                    "investor_count_change_1m",
                    "estimated_net_flow_1d",
                    "estimated_net_flow_1w",
                    "estimated_net_flow_1m",
                    "explanation",
                ],
            )
            writer.writeheader()
            for result in results:
                perf = result.performance
                risk = result.risk
                rec = result.recommendation
                money_flow = result.money_flow
                writer.writerow(
                    {
                        "report_date": report_date.isoformat(),
                        "fund_code": result.fund_code,
                        "fund_title": result.fund_title or "",
                        "category": self._category(result),
                        "signal": self._signal(rec.signal),
                        "final_score": rec.final_score,
                        "momentum_score": perf.momentum_score,
                        "risk_score": risk.risk_score,
                        "daily_return": perf.daily_return,
                        "weekly_return": perf.weekly_return,
                        "monthly_return": perf.monthly_return,
                        "three_month_return": perf.three_month_return,
                        "volatility_30": risk.volatility_30,
                        "max_drawdown_90": risk.max_drawdown_90,
                        "money_flow_score": money_flow.money_flow_score if money_flow else "",
                        "money_flow_label": self._money_flow_label(result),
                        "analytical_tags": self._analytical_tags(result),
                        "fund_size_latest": money_flow.fund_size_latest if money_flow else "",
                        "investor_count_latest": money_flow.investor_count_latest if money_flow else "",
                        "fund_size_change_1d": money_flow.fund_size_change_1d if money_flow else "",
                        "fund_size_change_1w": money_flow.fund_size_change_1w if money_flow else "",
                        "fund_size_change_1m": money_flow.fund_size_change_1m if money_flow else "",
                        "investor_count_change_1w": money_flow.investor_count_change_1w if money_flow else "",
                        "investor_count_change_1m": money_flow.investor_count_change_1m if money_flow else "",
                        "estimated_net_flow_1d": money_flow.estimated_net_flow_1d if money_flow else "",
                        "estimated_net_flow_1w": money_flow.estimated_net_flow_1w if money_flow else "",
                        "estimated_net_flow_1m": money_flow.estimated_net_flow_1m if money_flow else "",
                        "explanation": rec.explanation,
                    }
                )

    @staticmethod
    def _summary(results: List[FundAnalysisResult]) -> Dict[str, int]:
        summary: Dict[str, int] = {"funds_analyzed": len(results)}
        for result in results:
            signal = result.recommendation.signal.value
            summary[signal] = summary.get(signal, 0) + 1
        return summary

    def _category_summary(self, results: List[FundAnalysisResult]) -> Dict[str, int]:
        summary: Dict[str, int] = {}
        for result in results:
            category = self._category(result)
            summary[category] = summary.get(category, 0) + 1
        return dict(sorted(summary.items()))

    def _money_flow_summary(self, results: List[FundAnalysisResult]) -> Dict[str, int]:
        summary: Dict[str, int] = {
            display_money_flow_label(label, self.language): 0 for label in MoneyFlowLabel
        }
        for result in results:
            label = self._money_flow_label(result)
            summary[label] = summary.get(label, 0) + 1
        return summary

    def _analytical_tag_summary(self, results: List[FundAnalysisResult]) -> Dict[str, int]:
        summary: Dict[str, int] = {
            display_analytical_tag(tag, self.language): 0 for tag in AnalyticalTag
        }
        for result in results:
            for tag in result.analytical_tags:
                label = display_analytical_tag(tag, self.language)
                summary[label] = summary.get(label, 0) + 1
        return summary

    def _append_top_by_category(
        self,
        lines: List[str],
        results: List[FundAnalysisResult],
    ) -> None:
        lines.extend(["", f"## {t('top_funds_by_category', self.language)}", ""])
        lines.extend(
            [
                self._table_header(
                    [
                        "rank",
                        "fund_code",
                        "fund_title",
                        "category",
                        "signal",
                        "score",
                        "one_month_return",
                        "three_month_return",
                    ]
                ),
                self._table_align(["right", "left", "left", "left", "left", "right", "right", "right"]),
            ]
        )
        grouped: dict[str, list[FundAnalysisResult]] = defaultdict(list)
        for result in results:
            grouped[self._category(result)].append(result)

        row_count = 0
        for category in sorted(grouped):
            category_results = sorted(
                grouped[category],
                key=lambda item: (-item.recommendation.final_score, item.fund_code),
            )
            for rank, result in enumerate(category_results[:3], start=1):
                row_count += 1
                lines.append(
                    self._table_row(
                        [
                            str(rank),
                            result.fund_code,
                            self._fund_title(result),
                            category,
                            self._signal(result.recommendation.signal),
                            score(result.recommendation.final_score),
                            pct(result.performance.monthly_return),
                            pct(result.performance.three_month_return),
                        ]
                    )
                )
        if row_count == 0:
            lines.append(self._empty_row(8))

    def _append_risky_section(
        self,
        lines: List[str],
        results: List[FundAnalysisResult],
    ) -> None:
        risky_results = [
            item
            for item in results
            if item.recommendation.signal == SignalClass.RISKY
        ]
        lines.extend(
            [
                "",
                f"## {t('risky_funds', self.language)}",
                "",
                self._table_header(
                    [
                        "fund_code",
                        "fund_title",
                        "category",
                        "signal",
                        "score",
                        "risk",
                        "volatility_30",
                        "max_drawdown_90",
                    ]
                ),
                self._table_align(["left", "left", "left", "left", "right", "right", "right", "right"]),
            ]
        )
        if not risky_results:
            lines.append(self._empty_row(8))
            return

        for result in risky_results:
            lines.append(
                self._table_row(
                    [
                        result.fund_code,
                        self._fund_title(result),
                        self._category(result),
                        self._signal(result.recommendation.signal),
                        score(result.recommendation.final_score),
                        score(result.risk.risk_score),
                        pct(result.risk.volatility_30),
                        pct(result.risk.max_drawdown_90),
                    ]
                )
            )

    def _append_money_flow_section(
        self,
        lines: List[str],
        results: List[FundAnalysisResult],
        target_label: MoneyFlowLabel,
        heading_key: str,
    ) -> None:
        lines.extend(
            [
                "",
                f"## {t(heading_key, self.language)}",
                "",
                self._table_header(
                    [
                        "fund_code",
                        "fund_title",
                        "category",
                        "signal",
                        "final_score",
                        "money_flow_label",
                        "money_flow_score",
                        "estimated_net_flow_1w",
                        "estimated_net_flow_1m",
                        "investor_count_change_1m",
                    ]
                ),
                self._table_align(["left", "left", "left", "left", "right", "left", "right", "right", "right", "right"]),
            ]
        )
        filtered = [
            result
            for result in results
            if result.money_flow is not None and result.money_flow.money_flow_label == target_label
        ]
        if not filtered:
            lines.append(self._empty_row(10))
            return

        for result in filtered:
            money_flow = result.money_flow
            lines.append(
                self._table_row(
                    [
                        result.fund_code,
                        self._fund_title(result),
                        self._category(result),
                        self._signal(result.recommendation.signal),
                        score(result.recommendation.final_score),
                        self._money_flow_label(result),
                        score(self._money_flow_score(result)),
                        self._amount(money_flow.estimated_net_flow_1w if money_flow else None),
                        self._amount(money_flow.estimated_net_flow_1m if money_flow else None),
                        score(money_flow.investor_count_change_1m if money_flow else None),
                    ]
                )
            )

    def _append_tag_section(
        self,
        lines: List[str],
        results: List[FundAnalysisResult],
        target_tag: AnalyticalTag,
        heading_key: str,
    ) -> None:
        lines.extend(
            [
                "",
                f"## {t(heading_key, self.language)}",
                "",
                self._table_header(
                    [
                        "fund_code",
                        "fund_title",
                        "category",
                        "signal",
                        "final_score",
                        "tags",
                        "one_month_return",
                        "three_month_return",
                        "risk_score",
                        "max_drawdown_90",
                        "money_flow_label",
                    ]
                ),
                self._table_align(["left", "left", "left", "left", "right", "left", "right", "right", "right", "right", "left"]),
            ]
        )
        filtered = [
            result
            for result in results
            if target_tag in result.analytical_tags
        ]
        if not filtered:
            lines.append(self._empty_row(11))
            return

        for result in filtered:
            lines.append(
                self._table_row(
                    [
                        result.fund_code,
                        self._fund_title(result),
                        self._category(result),
                        self._signal(result.recommendation.signal),
                        score(result.recommendation.final_score),
                        self._analytical_tags(result, separator=", "),
                        pct(result.performance.monthly_return),
                        pct(result.performance.three_month_return),
                        score(result.risk.risk_score),
                        pct(result.risk.max_drawdown_90),
                        self._money_flow_label(result),
                    ]
                )
            )

    def _append_full_score_table(
        self,
        lines: List[str],
        results: List[FundAnalysisResult],
    ) -> None:
        lines.extend(
            [
                "",
                f"## {t('full_score_table', self.language)}",
                "",
                self._table_header(
                    [
                        "fund_code",
                        "fund_title",
                        "category",
                        "signal",
                        "score",
                        "money_flow_label",
                        "money_flow_score",
                        "analytical_tags",
                        "daily",
                        "weekly",
                        "monthly",
                        "three_month_return",
                        "momentum",
                        "risk",
                    ]
                ),
                self._table_align(["left", "left", "left", "left", "right", "left", "right", "left", "right", "right", "right", "right", "right", "right"]),
            ]
        )
        if not results:
            lines.append(self._empty_row(14))
            return

        for result in results:
            perf = result.performance
            lines.append(
                self._table_row(
                    [
                        result.fund_code,
                        self._fund_title(result),
                        self._category(result),
                        self._signal(result.recommendation.signal),
                        score(result.recommendation.final_score),
                        self._money_flow_label(result),
                        score(self._money_flow_score(result)),
                        self._analytical_tags(result, separator=", "),
                        pct(perf.daily_return),
                        pct(perf.weekly_return),
                        pct(perf.monthly_return),
                        pct(perf.three_month_return),
                        score(perf.momentum_score),
                        score(result.risk.risk_score),
                    ]
                )
            )

    def _fund_title(self, result: FundAnalysisResult) -> str:
        return result.fund_title or "n/a"

    def _category(self, result: FundAnalysisResult) -> str:
        return display_category(result.category, self.language)

    def _signal(self, signal: SignalClass) -> str:
        return display_signal(signal, self.language)

    def _money_flow_label(self, result: FundAnalysisResult) -> str:
        if result.money_flow is None:
            return display_money_flow_label(MoneyFlowLabel.UNKNOWN_FLOW, self.language)
        return display_money_flow_label(result.money_flow.money_flow_label, self.language)

    @staticmethod
    def _money_flow_score(result: FundAnalysisResult) -> float | None:
        if result.money_flow is None:
            return None
        return result.money_flow.money_flow_score

    def _analytical_tags(
        self,
        result: FundAnalysisResult,
        separator: str = "|",
    ) -> str:
        if not result.analytical_tags:
            return ""
        return separator.join(
            display_analytical_tag(tag, self.language)
            for tag in result.analytical_tags
        )

    @staticmethod
    def _amount(value: float | None) -> str:
        if value is None:
            return "n/a"
        return f"{value:,.2f}"

    @staticmethod
    def _fund_label(result: FundAnalysisResult) -> str:
        if result.fund_title:
            return f"{result.fund_code} - {result.fund_title}"
        return result.fund_code

    def _table_header(self, keys: List[str]) -> str:
        return self._table_row([t(key, self.language) for key in keys])

    @staticmethod
    def _table_align(alignments: List[str]) -> str:
        cells = ["---:" if align == "right" else "---" for align in alignments]
        return "| " + " | ".join(cells) + " |"

    @staticmethod
    def _table_row(values: List[str]) -> str:
        escaped = [str(value).replace("|", "\\|") for value in values]
        return "| " + " | ".join(escaped) + " |"

    @staticmethod
    def _empty_row(cell_count: int) -> str:
        return "| " + " | ".join(["n/a"] * cell_count) + " |"
