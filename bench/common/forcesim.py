"""A small, deterministic force simulation in the style of d3-force, for the dynamic
benchmark sequences (scenario 11).

Like a d3-force simulation with ``forceLink`` (one iteration, strength
``1 / min(degree(source), degree(target))``, bias by degree), ``forceManyBody`` (computed
exactly instead of Barnes-Hut; ``distanceMin`` 1) and centering: phyllotaxis initial
positions, ``alpha`` decaying from 1 towards ``alpha_target`` in 300 ticks to
``alpha_min``, velocity decay 0.4, fixed nodes (``fixed``: index -> (x, y)) as d3's
``fx``/``fy``. Pure numpy; no random jiggle (coincident nodes do not occur with the
phyllotaxis start).
"""
from __future__ import annotations

import math

import numpy as np


class Simulation:
    def __init__(self, n: int, links: list[tuple[int, int]], distance: float = 30.0,
                 charge: float = -30.0, velocity_decay: float = 0.4, alpha_min: float = 0.001):
        self.n = n
        self.links = np.array(links, dtype=np.int64).reshape(-1, 2)
        self.distance = distance
        self.charge = charge
        self.vdecay = velocity_decay
        self.alpha = 1.0
        self.alpha_min = alpha_min
        self.alpha_decay = 1 - alpha_min ** (1 / 300)
        self.alpha_target = 0.0
        i = np.arange(n, dtype=np.float64)
        r = 10.0 * np.sqrt(0.5 + i)
        a = i * math.pi * (3 - math.sqrt(5))
        self.x = np.stack([r * np.cos(a), r * np.sin(a)], axis=1)
        self.v = np.zeros((n, 2))
        self.fixed: dict[int, tuple[float, float]] = {}
        count = np.bincount(self.links.ravel(), minlength=n).astype(np.float64)
        s, t = self.links[:, 0], self.links[:, 1]
        self.strength = 1.0 / np.minimum(count[s], count[t])
        self.bias = count[s] / (count[s] + count[t])

    def tick(self) -> None:
        self.alpha += (self.alpha_target - self.alpha) * self.alpha_decay
        a = self.alpha
        # links, in link order
        for k, (s, t) in enumerate(self.links):
            d = self.x[t] + self.v[t] - self.x[s] - self.v[s]
            ln = math.hypot(d[0], d[1]) or 1e-9
            d = d * ((ln - self.distance) / ln * a * self.strength[k])
            self.v[t] -= d * self.bias[k]
            self.v[s] += d * (1 - self.bias[k])
        # many-body, exact
        d = self.x[None, :, :] - self.x[:, None, :]
        l2 = (d ** 2).sum(axis=2)
        l2 = np.where(l2 < 1.0, np.sqrt(np.maximum(l2, 1e-12)), l2)
        np.fill_diagonal(l2, np.inf)
        self.v += (d * (self.charge * a / l2)[:, :, None]).sum(axis=1)
        # integrate; fixed nodes stay put
        self.v *= 1 - self.vdecay
        self.x += self.v
        for i, (fx, fy) in self.fixed.items():
            self.x[i] = (fx, fy)
            self.v[i] = 0.0
        # center: mean to the origin
        self.x -= self.x.mean(axis=0)
