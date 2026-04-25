from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from tefas_analysis.main import main


if __name__ == "__main__":
    raise SystemExit(main())
