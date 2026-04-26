from __future__ import annotations

import csv
from datetime import date
from pathlib import Path
from typing import Dict, List

from tefas_analysis.schemas import FundAnalysisResult, MoneyFlowLabel, ReportArtifact, SignalClass
from tefas_analysis.utils import pct, score


class DailyReportGenerator:
    """Writes Markdown and CSV daily TEFAS analysis reports."""

    def __init__(self, output_dir: str) -> None:
        self.output_dir = Path(output_dir)

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

        markdown_path = self.output_dir / f"tefas_daily_report_{report_date.isoformat()}.md"
        csv_path = self.output_dir / f"tefas_daily_report_{report_date.isoformat()}.csv"

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
            f"# TEFAS Daily Fund Analysis - {report_date.isoformat()}",
            "",
            "This report is for analytical research only and is not financial advice.",
            "",
            "## Summary",
            "",
            f"- Funds analyzed: {summary['funds_analyzed']}",
            f"- Strong Watch: {summary.get(SignalClass.STRONG_WATCH.value, 0)}",
            f"- Watch: {summary.get(SignalClass.WATCH.value, 0)}",
            f"- Neutral: {summary.get(SignalClass.NEUTRAL.value, 0)}",
            f"- Risky: {summary.get(SignalClass.RISKY.value, 0)}",
            f"- Profit Taking Watch: {summary.get(SignalClass.PROFIT_TAKING_WATCH.value, 0)}",
            "",
            "## Category Summary",
            "",
        ]
        for category, count in self._category_summary(results).items():
            lines.append(f"- {category}: {count}")

        lines.extend([
            "",
            "## Money Flow Summary",
            "",
        ])
        for label, count in self._money_flow_summary(results).items():
            lines.append(f"- {label}: {count}")

        lines.extend([
            "",
            "## Top Funds By Score",
            "",
            "| Rank | Fund Code | Fund Title | Category | Signal | Score | Momentum | Risk | 1M Return | 3M Return |",
            "| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
        ])

        for rank, result in enumerate(results[:10], start=1):
            perf = result.performance
            risk = result.risk
            rec = result.recommendation
            lines.append(
                "| {rank} | {fund} | {title} | {category} | {signal} | {final} | {momentum} | {risk_score} | {monthly} | {three_month} |".format(
                    rank=rank,
                    fund=result.fund_code,
                    title=self._fund_title(result),
                    category=self._category(result),
                    signal=rec.signal.value,
                    final=score(rec.final_score),
                    momentum=score(perf.momentum_score),
                    risk_score=score(risk.risk_score),
                    monthly=pct(perf.monthly_return),
                    three_month=pct(perf.three_month_return),
                )
            )

        risky_results = [
            item
            for item in results
            if item.recommendation.signal == SignalClass.RISKY
        ]
        lines.extend(
            [
                "",
                "## Risky Funds",
                "",
                "| Fund Code | Fund Title | Category | Signal | Score | Risk | Volatility 30D | Max Drawdown 90D |",
                "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
            ]
        )
        if risky_results:
            for result in risky_results:
                lines.append(
                    "| {fund} | {title} | {category} | {signal} | {final} | {risk_score} | {volatility} | {drawdown} |".format(
                        fund=result.fund_code,
                        title=self._fund_title(result),
                        category=self._category(result),
                        signal=result.recommendation.signal.value,
                        final=score(result.recommendation.final_score),
                        risk_score=score(result.risk.risk_score),
                        volatility=pct(result.risk.volatility_30),
                        drawdown=pct(result.risk.max_drawdown_90),
                    )
                )
        else:
            lines.append("| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |")

        lines.extend(
            [
                "",
                "## Strong Inflow Funds",
                "",
                "| Fund Code | Fund Title | Category | Signal | Final Score | Money Flow Label | Money Flow Score | Estimated Net Flow 1W | Estimated Net Flow 1M | Investor Count Change 1M |",
                "| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |",
            ]
        )
        self._append_money_flow_rows(lines, results, MoneyFlowLabel.STRONG_INFLOW)

        lines.extend(
            [
                "",
                "## Strong Outflow Funds",
                "",
                "| Fund Code | Fund Title | Category | Signal | Final Score | Money Flow Label | Money Flow Score | Estimated Net Flow 1W | Estimated Net Flow 1M | Investor Count Change 1M |",
                "| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |",
            ]
        )
        self._append_money_flow_rows(lines, results, MoneyFlowLabel.STRONG_OUTFLOW)

        lines.extend(
            [
                "",
                "## Full Score Table",
                "",
                "| Fund Code | Fund Title | Category | Signal | Score | Money Flow Label | Money Flow Score | Daily | Weekly | Monthly | 3M | Momentum | Risk |",
                "| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
        for result in results:
            perf = result.performance
            lines.append(
                "| {fund} | {title} | {category} | {signal} | {final} | {flow_label} | {flow_score} | {daily} | {weekly} | {monthly} | {three_month} | {momentum} | {risk_score} |".format(
                    fund=result.fund_code,
                    title=self._fund_title(result),
                    category=self._category(result),
                    signal=result.recommendation.signal.value,
                    final=score(result.recommendation.final_score),
                    flow_label=self._money_flow_label(result),
                    flow_score=score(self._money_flow_score(result)),
                    daily=pct(perf.daily_return),
                    weekly=pct(perf.weekly_return),
                    monthly=pct(perf.monthly_return),
                    three_month=pct(perf.three_month_return),
                    momentum=score(perf.momentum_score),
                    risk_score=score(result.risk.risk_score),
                )
            )

        lines.extend(["", "## Fund Notes", ""])
        for result in results:
            lines.append(f"- {self._fund_label(result)}: {result.recommendation.explanation}")

        return "\n".join(lines) + "\n"

    @staticmethod
    def _write_csv(
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
                        "category": DailyReportGenerator._category(result),
                        "signal": rec.signal.value,
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
                        "money_flow_label": DailyReportGenerator._money_flow_label(result),
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

    @staticmethod
    def _category_summary(results: List[FundAnalysisResult]) -> Dict[str, int]:
        summary: Dict[str, int] = {}
        for result in results:
            category = DailyReportGenerator._category(result)
            summary[category] = summary.get(category, 0) + 1
        return dict(sorted(summary.items()))

    @staticmethod
    def _money_flow_summary(results: List[FundAnalysisResult]) -> Dict[str, int]:
        summary: Dict[str, int] = {label.value: 0 for label in MoneyFlowLabel}
        for result in results:
            label = DailyReportGenerator._money_flow_label(result)
            summary[label] = summary.get(label, 0) + 1
        return summary

    @classmethod
    def _append_money_flow_rows(
        cls,
        lines: List[str],
        results: List[FundAnalysisResult],
        target_label: MoneyFlowLabel,
    ) -> None:
        filtered = [
            result
            for result in results
            if result.money_flow is not None and result.money_flow.money_flow_label == target_label
        ]
        if not filtered:
            lines.append("| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |")
            return

        for result in filtered:
            money_flow = result.money_flow
            lines.append(
                "| {fund} | {title} | {category} | {signal} | {final} | {flow_label} | {flow_score} | {flow_1w} | {flow_1m} | {investor_1m} |".format(
                    fund=result.fund_code,
                    title=cls._fund_title(result),
                    category=cls._category(result),
                    signal=result.recommendation.signal.value,
                    final=score(result.recommendation.final_score),
                    flow_label=cls._money_flow_label(result),
                    flow_score=score(cls._money_flow_score(result)),
                    flow_1w=cls._amount(money_flow.estimated_net_flow_1w if money_flow else None),
                    flow_1m=cls._amount(money_flow.estimated_net_flow_1m if money_flow else None),
                    investor_1m=score(money_flow.investor_count_change_1m if money_flow else None),
                )
            )

    @staticmethod
    def _fund_title(result: FundAnalysisResult) -> str:
        return result.fund_title or "n/a"

    @staticmethod
    def _category(result: FundAnalysisResult) -> str:
        return result.category or "UNKNOWN"

    @staticmethod
    def _money_flow_label(result: FundAnalysisResult) -> str:
        if result.money_flow is None:
            return MoneyFlowLabel.UNKNOWN_FLOW.value
        return result.money_flow.money_flow_label.value

    @staticmethod
    def _money_flow_score(result: FundAnalysisResult) -> float | None:
        if result.money_flow is None:
            return None
        return result.money_flow.money_flow_score

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
