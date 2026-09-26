"""Download NSIDC G02202 V6 yearly aggregates + a short daily demo window."""

from __future__ import annotations

import sys
import urllib.request
from datetime import date, timedelta
from pathlib import Path

from polarroute.config import (
    ALL_YEARS,
    ANCILLARY_NAME,
    DEMO_DAILY_END,
    DEMO_DAILY_START,
    NSIDC_BASE,
    NSIDC_VERSION,
    RAW_DIR,
)


def _urlretrieve(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 1000:
        print(f"skip {dest.name}")
        return
    print(f"GET {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")

    def _progress(blocks, bsize, total):
        if total <= 0:
            return
        pct = min(100, int(blocks * bsize * 100 / total))
        mb = dest.stat().st_size / 1e6 if dest.exists() else blocks * bsize / 1e6
        print(f"\r  {pct:3d}%  {mb:.1f} MB", end="", flush=True)

    try:
        urllib.request.urlretrieve(url, tmp, _progress)
        print()
        tmp.replace(dest)
    except Exception:
        if tmp.exists():
            tmp.unlink()
        raise


def yearly_url(year: int) -> str:
    return (
        f"{NSIDC_BASE}/south/aggregate/"
        f"sic_pss25_{year}0101-{year}1231_{NSIDC_VERSION}.nc"
    )


def daily_url(d: date, sat: str = "F17") -> str:
    stamp = d.strftime("%Y%m%d")
    return (
        f"{NSIDC_BASE}/south/daily/{d.year}/"
        f"sic_pss25_{stamp}_{sat}_{NSIDC_VERSION}.nc"
    )


def download_ancillary() -> Path:
    dest = RAW_DIR / ANCILLARY_NAME
    _urlretrieve(f"{NSIDC_BASE}/ancillary/{ANCILLARY_NAME}", dest)
    return dest


def download_years(years: list[int] | None = None) -> list[Path]:
    years = years or ALL_YEARS
    paths = []
    for year in years:
        dest = RAW_DIR / f"sic_pss25_{year}_{NSIDC_VERSION}.nc"
        _urlretrieve(yearly_url(year), dest)
        paths.append(dest)
    return paths


def daterange(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def download_daily_window(start: str, end: str) -> list[Path]:
    """Fill gaps (e.g. January 2023) not covered by the yearly test file."""
    s = date.fromisoformat(start)
    e = date.fromisoformat(end)
    paths = []
    for d in daterange(s, e):
        dest = RAW_DIR / "daily" / f"sic_pss25_{d.strftime('%Y%m%d')}_{NSIDC_VERSION}.nc"
        try:
            _urlretrieve(daily_url(d), dest)
            paths.append(dest)
        except Exception as exc:
            print(f"WARN {d}: {exc}", file=sys.stderr)
    return paths


def main() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    download_ancillary()
    download_years()
    download_daily_window(DEMO_DAILY_START, DEMO_DAILY_END)
    print("download complete")


if __name__ == "__main__":
    main()
