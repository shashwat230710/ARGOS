import numpy as np

from polarroute.route import astar, speed_factor


def test_open_ocean_is_straight():
    H = W = 40
    forecast = np.zeros((5, H, W), dtype=np.float32)
    path, cost = astar(forecast, (5, 5), (5, 30), w_risk=0.0)
    assert path is not None
    assert all(r == 5 for r, c in path)
    assert path[0] == (5, 5) and path[-1] == (5, 30)


def test_ice_wall_forces_detour():
    H = W = 40
    forecast = np.zeros((5, H, W), dtype=np.float32)
    forecast[:, 5:35, 18:22] = 0.95  # impassable wall
    path, cost = astar(forecast, (20, 2), (20, 35), w_risk=0.0)
    assert path is not None
    cols = [c for r, c in path]
    assert not all(18 <= c <= 21 for c in cols)
    assert path[-1] == (20, 35)


def test_lead_closing_changes_route():
    H = W = 36
    a = np.zeros((6, H, W), dtype=np.float32)
    b = a.copy()
    # corridor open on day 0, closes later in b
    a[:, 10:26, 16:20] = 0.9
    a[:, 17:19, 16:20] = 0.0  # lead
    b[:, 10:26, 16:20] = 0.9
    pa, _ = astar(a, (18, 2), (18, 30), w_risk=0.0)
    pb, _ = astar(b, (18, 2), (18, 30), w_risk=0.0)
    assert pa is not None and pb is not None
    assert pa != pb


def test_speed_factor_limits():
    sic = np.array([0.0, 0.15, 0.4, 0.7, 0.9])
    sf = speed_factor(sic)
    assert sf[0] == 1.0
    assert sf[-1] == 0.0
    assert 0.2 <= sf[2] <= 1.0
