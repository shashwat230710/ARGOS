"""CLI: python -m polarroute <download|preprocess|train|eval|hindcast|serve|prepare>"""

from __future__ import annotations

import argparse
import sys


def main(argv=None):
    p = argparse.ArgumentParser(prog="polarroute")
    p.add_argument(
        "cmd",
        choices=["download", "preprocess", "train", "eval", "hindcast", "serve", "prepare", "export-land"],
    )
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    args = p.parse_args(argv)

    if args.cmd == "download":
        from polarroute.download import main as d

        d()
    elif args.cmd == "preprocess":
        from polarroute.preprocess import run

        run()
    elif args.cmd == "train":
        from polarroute.train import run

        run()
    elif args.cmd == "eval":
        from polarroute.evaluate import run

        run()
    elif args.cmd == "hindcast":
        from polarroute.hindcast import run

        run()
    elif args.cmd == "export-land":
        from polarroute.landpoly import run

        run()
    elif args.cmd == "prepare":
        from polarroute.download import main as d
        from polarroute.preprocess import run as pre
        from polarroute.train import run as tr
        from polarroute.evaluate import run as ev
        from polarroute.hindcast import run as hc
        from polarroute.landpoly import run as land
        from polarroute.config import MODELS_DIR, PROCESSED_DIR

        d()
        pre()
        land()
        if not (MODELS_DIR / "unet.pt").exists():
            tr()
        else:
            print("skip train (models/unet.pt exists)")
        ev()
        hc()
        print("prepare complete")
    elif args.cmd == "serve":
        import uvicorn

        uvicorn.run("polarroute.api:app", host=args.host, port=args.port, reload=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
