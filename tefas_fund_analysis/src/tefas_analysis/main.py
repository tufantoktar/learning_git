from __future__ import annotations

import argparse
import logging
from datetime import date
from pathlib import Path
from typing import Optional, Sequence

from apscheduler.schedulers.blocking import BlockingScheduler

from tefas_analysis.config import AppConfig
from tefas_analysis.pipeline import DailyTefasPipeline


def _parse_date(raw: Optional[str]) -> Optional[date]:
    if raw is None:
        return None
    return date.fromisoformat(raw)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the daily TEFAS fund analysis pipeline.")
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="Path to JSON config file. Defaults to TEFAS_CONFIG_FILE or built-in defaults.",
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        default=None,
        help="Path to .env file. Defaults to .env in the working directory.",
    )
    parser.add_argument(
        "--as-of",
        type=str,
        default=None,
        help="Report date in YYYY-MM-DD format. Defaults to today.",
    )
    parser.add_argument(
        "--skip-collect",
        action="store_true",
        help="Use stored prices and skip TEFAS collection.",
    )
    parser.add_argument(
        "--all-funds",
        action="store_true",
        help="Analyze all funds returned by TEFAS for this run.",
    )
    parser.add_argument(
        "--max-funds",
        type=int,
        default=None,
        help="Limit all-funds analysis to the first N discovered fund codes for this run.",
    )
    parser.add_argument(
        "--disable-category-scoring",
        action="store_true",
        help="Classify fund categories but use the generic Phase 1 scoring formula.",
    )
    parser.add_argument(
        "--disable-money-flow",
        action="store_true",
        help="Skip TEFAS money flow approximation for this run.",
    )
    parser.add_argument(
        "--disable-analytical-tags",
        action="store_true",
        help="Skip deterministic analytical tag generation for this run.",
    )
    parser.add_argument(
        "--report-language",
        choices=["tr", "en"],
        default=None,
        help="Report display language for this run.",
    )
    parser.add_argument(
        "--notify",
        action="store_true",
        help="Force Telegram notification if credentials are configured.",
    )
    parser.add_argument(
        "--no-notify",
        action="store_true",
        help="Disable notification for this run.",
    )
    parser.add_argument(
        "--schedule",
        action="store_true",
        help="Run continuously using scheduler settings.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )

    config = AppConfig.from_file(config_path=args.config, env_file=args.env_file)
    config_updates = {}
    if args.all_funds:
        config_updates["analyze_all_funds"] = True
        config_updates["fund_codes"] = []
    if args.max_funds is not None:
        if args.max_funds < 1:
            parser.error("--max-funds must be greater than zero")
        config_updates["max_funds"] = args.max_funds
    if args.disable_category_scoring:
        config_updates["enable_category_scoring"] = False
    if args.disable_money_flow:
        config_updates["enable_money_flow_analysis"] = False
    if args.disable_analytical_tags:
        config_updates["enable_analytical_tags"] = False
    if args.report_language is not None:
        config_updates["report_language"] = args.report_language
    if config_updates:
        config = config.model_copy(update=config_updates)

    pipeline = DailyTefasPipeline(config)
    report_date = _parse_date(args.as_of)
    notify = True if args.notify else False if args.no_notify else None

    if args.schedule or config.scheduler.enabled:
        hour, minute = [int(part) for part in config.scheduler.run_time.split(":")]
        scheduler = BlockingScheduler(timezone=config.scheduler.timezone)
        scheduler.add_job(
            lambda: pipeline.run(
                as_of=date.today(),
                collect=not args.skip_collect,
                notify=notify,
            ),
            trigger="cron",
            hour=hour,
            minute=minute,
            id="daily_tefas_pipeline",
            replace_existing=True,
        )
        logging.info(
            "Starting TEFAS scheduler at %s %s",
            config.scheduler.run_time,
            config.scheduler.timezone,
        )
        scheduler.start()
        return 0

    result = pipeline.run(
        as_of=report_date,
        collect=not args.skip_collect,
        notify=notify,
    )
    logging.info("Analyzed %s funds", len(result.analyses))
    logging.info("Collected or updated %s price rows", result.collected_price_count)
    logging.info("Markdown report: %s", result.report.markdown_path)
    logging.info("CSV report: %s", result.report.csv_path)
    return 0
