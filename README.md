# Basketball Shot Charts

Small project for exploring NBA and WNBA shot data and creating player shot charts.

## Project layout

```text
data/
  raw/          Season-level parquet files
  processed/    Player-level CSV files used by the charts
src/            Python scripts
outputs/charts/ Generated chart images
requirements.txt
```

## Setup

```powershell
python -m pip install -r requirements.txt
```

## Create the poster chart

Run this from the project root:

```powershell
python src/shot_chart_poster.py
```

The image is saved to `outputs/charts/shot_chart_poster.png`.

Other scripts:

- `python src/shot_chart_espn.py` builds the two-player chart using the ESPN data source.
- `python src/shotchart.py` requests shot data from `nba_api` and builds a chart.
- `python src/explore_shots.py` downloads and inspects season parquet files.

For the full data-to-site workflow, see [WORKFLOW.md](WORKFLOW.md).
