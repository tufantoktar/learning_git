from __future__ import annotations

import csv
from datetime import date
from pathlib import Path
from typing import Dict, List

from tefas_analysis.schemas import FundAnalysisResult, ReportArtifact, SignalClass
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
            "## Top Funds By Score",
            "",
            "| Rank | Fund | Signal | Score | Momentum | Risk | 1M Return | 3M Return |",
            "| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |",
        ]

        for rank, result in enumerate(results[:10], start=1):
            perf = result.performance
            risk = result.risk
            rec = result.recommendation
            lines.append(
                "| {rank} | {fund} | {signal} | {final} | {momentum} | {risk_score} | {monthly} | {three_month} |".format(
                    rank=rank,
                    fund=result.fund_code,
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
                "| Fund | Signal | Score | Risk | Volatility 30D | Max Drawdown 90D |",
                "| --- | --- | ---: | ---: | ---: | ---: |",
            ]
        )
        if risky_results:
            for result in risky_results:
                lines.append(
                    "| {fund} | {signal} | {final} | {risk_score} | {volatility} | {drawdown} |".format(
                        fund=result.fund_code,
                        signal=result.recommendation.signal.value,
                        final=score(result.recommendation.final_score),
                        risk_score=score(result.risk.risk_score),
                        volatility=pct(result.risk.volatility_30),
                        drawdown=pct(result.risk.max_drawdown_90),
                    )
                )
        else:
            lines.append("| n/a | n/a | n/a | n/a | n/a | n/a |")

        lines.extend(
            [
                "",
                "## Full Score Table",
                "",
                "| Fund | Signal | Score | Daily | Weekly | Monthly | 3M | Momentum | Risk |",
                "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
            ]
        )
        for result in results:
            perf = result.performance
            lines.append(
                "| {fund} | {signal} | {final} | {daily} | {weekly} | {monthly} | {three_month} | {momentum} | {risk_score} |".format(
                    fund=result.fund_code,
                    signal=result.recommendation.signal.value,
                    final=score(result.recommendation.final_score),
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
            lines.append(f"- {result.fund_code}: {result.recommendation.explanation}")

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
                    "explanation",
                ],
            )
            writer.writeheader()
            for result in results:
                perf = result.performance
                risk = result.risk
                rec = result.recommendation
                writer.writerow(
                    {
                        "report_date": report_date.isoformat(),
                        "fund_code": result.fund_code,
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
