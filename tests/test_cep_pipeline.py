from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from update_cep_france import (  # noqa: E402
    CEP_NI,
    forecast_steps,
    grid_index,
    transform_step,
)


class CEPGridTests(unittest.TestCase):
    def test_france_negative_longitude_wraps_on_global_grid(self) -> None:
        index, latitude, longitude = grid_index(48.8566, 2.3522)
        self.assertGreaterEqual(index, 0)
        self.assertAlmostEqual(latitude, 48.75, places=2)
        self.assertAlmostEqual(longitude, 2.25, places=2)

        _index, _latitude, longitude = grid_index(48.4, -4.5)
        self.assertAlmostEqual(longitude, -4.5, places=2)
        self.assertLess(_index % CEP_NI, CEP_NI)

    def test_deterministic_schedule_to_240_hours(self) -> None:
        steps = forecast_steps(240)
        self.assertEqual(steps[0], 0)
        self.assertEqual(steps[-1], 240)
        self.assertEqual(len(steps), 65)
        self.assertEqual(steps[48], 144)
        self.assertEqual(steps[49], 150)

    def test_surface_fields_are_transformed(self) -> None:
        shape = (2,)
        raw = {
            "temperature_k": np.array([273.15, 293.15]),
            "dewpoint_k": np.array([271.15, 288.15]),
            "wind_u_ms": np.array([3.0, 4.0]),
            "wind_v_ms": np.array([4.0, 3.0]),
            "gust_speed_ms": np.array([8.0, 10.0]),
            "surface_pressure_pa": np.array([101000.0, 100000.0]),
            "mean_sea_pressure_pa": np.array([102000.0, 101500.0]),
            "cloud_total_fraction": np.array([25.0, 80.0]),
            "precipitation_total_m": np.array([0.0, 2.5]),
        }
        result, _state = transform_step(raw, np.zeros(shape), {}, 0)
        np.testing.assert_allclose(result["temperature_c"], [0.0, 20.0])
        np.testing.assert_allclose(result["wind_speed_kmh"], [18.0, 18.0])
        np.testing.assert_allclose(result["pressure_hpa"], [1020.0, 1015.0])
        self.assertTrue(np.all(np.isfinite(result["humidity_pct"])))


if __name__ == "__main__":
    unittest.main()
