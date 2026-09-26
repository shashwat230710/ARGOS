"""Train the small U-Net on the cropped G02202 subset."""

from __future__ import annotations

import json
import random
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from polarroute.config import (
    BASE_CH,
    BATCH_SIZE,
    EPOCHS,
    IN_CH,
    K_OUT,
    LR,
    MODELS_DIR,
    PROCESSED_DIR,
    SEED,
    TRAIN_YEARS,
)
from polarroute.dataset import SicSequenceDataset, climatology_delta, load_processed
from polarroute.model import SmallUNet, count_params


def set_seed(seed: int = SEED) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def masked_edge_l1(pred, y, ocean):
    edge = ((y > 0.05) & (y < 0.95)).float()
    w = ocean * (1.0 + 4.0 * edge)
    return (w * (pred - y).abs()).sum() / w.sum().clamp_min(1.0)


def is_shipping_season(iso: str) -> bool:
    m = int(iso[5:7])
    return m in (12, 1, 2, 3)


@torch.no_grad()
def val_mae(model, loader, device) -> float:
    model.eval()
    num = den = 0.0
    for batch in loader:
        x = batch["x"].to(device)
        y = batch["y"].to(device)
        last = batch["last"].to(device)
        ocean = batch["ocean"].to(device)[:, None]
        pred = (last + model(x)).clamp(0, 1)
        err = ((pred - y).abs() * ocean).sum().item()
        cnt = (ocean.expand_as(y)).sum().item()
        # Dec-Mar only
        for i, d in enumerate(batch["date"]):
            if not is_shipping_season(d):
                continue
            num += ((pred[i] - y[i]).abs() * ocean[i]).sum().item()
            den += ocean[i].expand_as(y[i]).sum().item()
        if den == 0:
            num, den = err, cnt
    return num / max(den, 1.0)


def run() -> None:
    set_seed()
    bundle = load_processed()
    train_ds = SicSequenceDataset(bundle, "train")
    val_ds = SicSequenceDataset(bundle, "val")
    print(f"train sequences={len(train_ds)} val={len(val_ds)}")
    if len(train_ds) < 8:
        raise RuntimeError("Not enough consecutive training days. Re-run preprocess.")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print("device", device, "params", count_params(SmallUNet(IN_CH, K_OUT, BASE_CH)))
    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True, num_workers=0)
    val_loader = DataLoader(val_ds, batch_size=BATCH_SIZE, shuffle=False, num_workers=0)

    model = SmallUNet(IN_CH, K_OUT, BASE_CH).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=LR)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=EPOCHS)

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    best = 1e9
    history = []
    for epoch in range(1, EPOCHS + 1):
        model.train()
        running = 0.0
        n = 0
        for batch in train_loader:
            x = batch["x"].to(device)
            y = batch["y"].to(device)
            last = batch["last"].to(device)
            ocean = batch["ocean"].to(device)[:, None]
            pred = (last + model(x)).clamp(0, 1)
            loss = masked_edge_l1(pred, y, ocean)
            opt.zero_grad()
            loss.backward()
            opt.step()
            running += loss.item() * x.size(0)
            n += x.size(0)
        sched.step()
        mae = val_mae(model, val_loader, device) if len(val_ds) else float("nan")
        print(f"epoch {epoch:02d}/{EPOCHS} train_loss={running/max(n,1):.4f} val_mae={mae:.4f}")
        history.append({"epoch": epoch, "train_loss": running / max(n, 1), "val_mae": mae})
        if mae < best:
            best = mae
            torch.save(
                {
                    "state_dict": model.state_dict(),
                    "in_ch": IN_CH,
                    "out_ch": K_OUT,
                    "base": BASE_CH,
                    "val_mae": mae,
                    "epoch": epoch,
                },
                MODELS_DIR / "unet.pt",
            )

    from polarroute.dataset import climatology_mean

    delta = climatology_delta(bundle, TRAIN_YEARS)
    np.save(PROCESSED_DIR / "clim_delta.npy", delta)
    np.save(PROCESSED_DIR / "clim_mean.npy", climatology_mean(bundle, TRAIN_YEARS))
    (MODELS_DIR / "train_history.json").write_text(json.dumps(history, indent=2), encoding="utf-8")
    print(f"best val MAE={best:.4f} saved {MODELS_DIR / 'unet.pt'}")


if __name__ == "__main__":
    run()
