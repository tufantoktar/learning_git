from datetime import date

import pytest

from tefas_analysis.collectors import CsvCollector, TefasCollector, create_collector
from tefas_analysis.collectors.csv_collector import (
    MISSING_CSV_FILE_MESSAGE,
    MISSING_REQUIRED_COLUMNS_MESSAGE,
    NO_VALID_RECORDS_MESSAGE,
)
from tefas_analysis.config import CollectorConfig


def make_collector(csv_path):
    return CsvCollector(CollectorConfig(source="csv", csv_path=str(csv_path)))


def test_create_collector_uses_configured_source(tmp_path):
    csv_config = CollectorConfig(source="csv", csv_path=str(tmp_path / "history.csv"))
    api_config = CollectorConfig(source="tefas_api")

    assert isinstance(create_collector(csv_config), CsvCollector)
    assert isinstance(create_collector(api_config), TefasCollector)


def test_english_csv_import(tmp_path):
    csv_path = tmp_path / "history.csv"
    csv_path.write_text(
        "\n".join(
            [
                "date,fund_code,fund_title,price,fund_size,investor_count,shares",
                "2026-04-01,aft,AFT Fund,12.34,1000000000,12345,50000000",
                "2026-04-02,aft,AFT Fund,12.45,1010000000,12400,50010000",
            ]
        ),
        encoding="utf-8",
    )

    result = make_collector(csv_path).fetch_multiple(
        ["AFT"],
        date(2026, 4, 1),
        date(2026, 4, 2),
    )[0]

    assert result.fund_code == "AFT"
    assert len(result.records) == 2
    assert result.records[0].fund_code == "AFT"
    assert result.records[0].fund_title == "AFT Fund"
    assert result.records[0].price == 12.34
    assert result.records[0].fund_size == 1_000_000_000.0
    assert result.records[0].investor_count == 12_345.0
    assert result.records[0].shares == 50_000_000.0


def test_turkish_csv_import_with_semicolon_and_decimal_comma(tmp_path):
    csv_path = tmp_path / "turkish.csv"
    csv_path.write_text(
        "\n".join(
            [
                (
                    "Tarih;Fon Kodu;Fon Adı;Fiyat;Fon Toplam Değer;"
                    "Yatırımcı Sayısı;Tedavüldeki Pay Sayısı"
                ),
                "01.04.2026;AFT;AFT Fonu;12,34;1.000.000.000,00;12.345;50.000.000",
            ]
        ),
        encoding="utf-8",
    )

    result = make_collector(csv_path).fetch_all_funds_history(
        date(2026, 4, 1),
        date(2026, 4, 1),
    )

    record = result.records[0]
    assert record.fund_code == "AFT"
    assert record.fund_title == "AFT Fonu"
    assert record.price == 12.34
    assert record.fund_size == 1_000_000_000.0
    assert record.investor_count == 12_345.0
    assert record.shares == 50_000_000.0


def test_selected_funds_filtering_returns_empty_result_for_missing_fund(tmp_path):
    csv_path = tmp_path / "history.csv"
    csv_path.write_text(
        "date,fund_code,price\n2026-04-01,AFT,12.34\n2026-04-01,MAC,8.10\n",
        encoding="utf-8",
    )

    results = make_collector(csv_path).fetch_multiple(
        ["AFT", "TCD"],
        date(2026, 4, 1),
        date(2026, 4, 1),
    )

    assert [result.fund_code for result in results] == ["AFT", "TCD"]
    assert [len(result.records) for result in results] == [1, 0]


def test_all_funds_import_and_max_funds_use_sorted_codes(tmp_path):
    csv_path = tmp_path / "history.csv"
    csv_path.write_text(
        "\n".join(
            [
                "date,fund_code,price",
                "2026-04-01,ZZZ,1.0",
                "2026-04-01,AFT,2.0",
                "2026-04-01,MAC,3.0",
            ]
        ),
        encoding="utf-8",
    )

    result = make_collector(csv_path).fetch_all_funds_history(
        date(2026, 4, 1),
        date(2026, 4, 1),
        max_funds=2,
    )

    assert result.fund_code == "ALL"
    assert [record.fund_code for record in result.records] == ["AFT", "MAC"]


def test_date_range_filtering(tmp_path):
    csv_path = tmp_path / "history.csv"
    csv_path.write_text(
        "\n".join(
            [
                "date,fund_code,price",
                "2026-03-31,AFT,10.0",
                "2026-04-01,AFT,12.0",
                "2026-04-02,AFT,13.0",
            ]
        ),
        encoding="utf-8",
    )

    result = make_collector(csv_path).fetch_multiple(
        ["AFT"],
        date(2026, 4, 1),
        date(2026, 4, 1),
    )[0]

    assert [record.date for record in result.records] == [date(2026, 4, 1)]
    assert [record.price for record in result.records] == [12.0]


def test_missing_csv_file_error(tmp_path):
    csv_path = tmp_path / "missing.csv"
    collector = make_collector(csv_path)

    with pytest.raises(FileNotFoundError, match="CSV collector source selected"):
        collector.fetch_all_funds_history(date(2026, 4, 1), date(2026, 4, 1))

    assert MISSING_CSV_FILE_MESSAGE.format(path=csv_path).endswith(str(csv_path))


def test_missing_required_columns_error(tmp_path):
    csv_path = tmp_path / "bad.csv"
    csv_path.write_text("date,title,price\n2026-04-01,AFT Fund,12.34\n", encoding="utf-8")

    with pytest.raises(ValueError, match=MISSING_REQUIRED_COLUMNS_MESSAGE):
        make_collector(csv_path).fetch_all_funds_history(
            date(2026, 4, 1),
            date(2026, 4, 1),
        )


def test_no_valid_parsed_records_error_and_invalid_dates_are_skipped(tmp_path, caplog):
    csv_path = tmp_path / "empty.csv"
    csv_path.write_text(
        "date,fund_code,price\nnot-a-date,AFT,12.34\n2026-04-01,,13.00\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match=NO_VALID_RECORDS_MESSAGE):
        make_collector(csv_path).fetch_all_funds_history(
            date(2026, 4, 1),
            date(2026, 4, 1),
        )

    assert "invalid dates" in caplog.text
