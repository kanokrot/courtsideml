from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_RAW = PROJECT_ROOT / "data" / "raw"
DATA_PROCESSED = PROJECT_ROOT / "data" / "processed"
CHARTS_DIR = PROJECT_ROOT / "outputs" / "charts"


def ensure_project_dirs():
    for path in (DATA_RAW, DATA_PROCESSED, CHARTS_DIR):
        path.mkdir(parents=True, exist_ok=True)
