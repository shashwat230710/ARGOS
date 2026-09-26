"""Small U-Net: 7-day SIC stack → 7-day residual forecast."""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F


def conv_block(i: int, o: int) -> nn.Sequential:
    return nn.Sequential(
        nn.Conv2d(i, o, 3, padding=1),
        nn.BatchNorm2d(o),
        nn.ReLU(inplace=True),
        nn.Conv2d(o, o, 3, padding=1),
        nn.BatchNorm2d(o),
        nn.ReLU(inplace=True),
    )


class SmallUNet(nn.Module):
    """~0.5 M params at base=16. Predicts change from last observed day."""

    def __init__(self, in_ch: int, out_ch: int = 7, base: int = 16):
        super().__init__()
        self.e1 = conv_block(in_ch, base)
        self.e2 = conv_block(base, 2 * base)
        self.e3 = conv_block(2 * base, 4 * base)
        self.b = conv_block(4 * base, 8 * base)
        self.u3 = nn.ConvTranspose2d(8 * base, 4 * base, 2, 2)
        self.d3 = conv_block(8 * base, 4 * base)
        self.u2 = nn.ConvTranspose2d(4 * base, 2 * base, 2, 2)
        self.d2 = conv_block(4 * base, 2 * base)
        self.u1 = nn.ConvTranspose2d(2 * base, base, 2, 2)
        self.d1 = conv_block(2 * base, base)
        self.head = nn.Conv2d(base, out_ch, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        e1 = self.e1(x)
        e2 = self.e2(F.max_pool2d(e1, 2))
        e3 = self.e3(F.max_pool2d(e2, 2))
        b = self.b(F.max_pool2d(e3, 2))
        d3 = self.d3(torch.cat([self.u3(b), e3], 1))
        d2 = self.d2(torch.cat([self.u2(d3), e2], 1))
        d1 = self.d1(torch.cat([self.u1(d2), e1], 1))
        return self.head(d1)


def count_params(m: nn.Module) -> int:
    return sum(p.numel() for p in m.parameters() if p.requires_grad)
