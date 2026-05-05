from tefas_analysis.collectors.csv_collector import CsvCollector
from tefas_analysis.collectors.tefas_collector import (
    EndpointDiagnosticResult,
    TefasCollector,
    TefasCollectorError,
    TefasEndpointFaultError,
    TefasNoRecordsError,
    TefasWafRejectedError,
)
from tefas_analysis.config import CollectorConfig


def create_collector(config: CollectorConfig):
    if config.source == "csv":
        return CsvCollector(config)
    return TefasCollector(config)

__all__ = [
    "CsvCollector",
    "EndpointDiagnosticResult",
    "TefasCollector",
    "TefasCollectorError",
    "TefasEndpointFaultError",
    "TefasNoRecordsError",
    "TefasWafRejectedError",
    "create_collector",
]
