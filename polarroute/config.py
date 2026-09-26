"""Demo configuration. Scenario date was chosen before looking at test metrics."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
MODELS_DIR = ROOT / "models"
FRONTEND_DIST = ROOT / "frontend" / "dist"

NSIDC_BASE = "https://noaadata.apps.nsidc.org/NOAA/G02202_V6"
ANCILLARY_NAME = "G02202-ancillary-pss25-v06r00.nc"
# G02202 V5 was retired; V6 is the same 25 km polar-stereographic CDR.
NSIDC_VERSION = "v06r00"
DATASET_NAME = "NOAA/NSIDC Climate Data Record of Passive Microwave Sea Ice Concentration, Version 6 (G02202)"
DATASET_DOI = "https://doi.org/10.7265/b18j-z797"

# Year-blocked split on a laptop-sized shipping-season subset (Nov–Mar).
TRAIN_YEARS = [2016, 2017, 2018]
VAL_YEARS = [2019]
TEST_YEARS = [2022]
ALL_YEARS = TRAIN_YEARS + VAL_YEARS + TEST_YEARS

# Keep only austral shipping months to stay small and relevant.
SEASON_MONTHS = {11, 12, 1, 2, 3}

# Corridor: ~10W–90E, 55S–78S, padded to U-Net-friendly 160 x 184.
CROP_H = 160
CROP_W = 184
# Native NSIDC south grid is y-descending; crop origin chosen in preprocess.py
CELL_M = 25000.0
CELL_KM = 25.0
CELL_KM2 = CELL_KM * CELL_KM

T_IN = 7
K_OUT = 7
IN_CH = T_IN + 1 + 2  # SIC frames + ocean mask + sin/cos doy
BASE_CH = 16
EPOCHS = 12
BATCH_SIZE = 4
LR = 1e-3
SEED = 42

# Showcase window — written down before evaluation (plan §5.4).
DEMO_D0 = "2023-01-10"  # needs 2022 Dec + 2023 Jan files; 2023 is in TEST via extra days
# Demo uses 2022-12-20 as alternate if 2023 days not downloaded with year 2022 only.
# We also download a short 2023 January daily set for the chosen D0.
DEMO_YEAR_EXTRA_DAILY = 2023
DEMO_DAILY_START = "2022-12-01"
DEMO_DAILY_END = "2023-01-24"

# Vessel (illustrative PC6-like, not POLARIS-certified)
SHIP_NAME = "RV Polar Explorer"
SHIP_CLASS = "PC6-like (illustrative)"
OPEN_WATER_KMH = 22.0
MAX_SIC = 0.70
HEAVY_ICE_SIC = 0.40
ICE_EDGE_SIC = 0.15

# Waypoints (lon, lat)
CAPE_TOWN = (18.4241, -33.9249)
ICE_ENTRY = (52.5, -55.0)  # open-water → ice-region handoff
BHARATI = (76.1950, -69.4067)
MAITRI = (11.7333, -70.7667)

EPSG_3412 = (
    "+proj=stere +lat_0=-90 +lat_ts=-70 +lon_0=0 +x_0=0 +y_0=0 "
    "+a=6378273 +b=6356889.449 +units=m +no_defs"
)
