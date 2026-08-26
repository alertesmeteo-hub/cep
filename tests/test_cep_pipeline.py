from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from update_cep_france import (  # noqa: E402
    CEP_NI,
    MapSampler,
    forecast_steps,
    grid_index,
    message_field,
    transform_step,
)
from cep_maps import CEPMapRenderer  # noqa: E402


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

    def test_map_sampling_covers_the_complete_domain(self) -> None:
        sampler = MapSampler(601, 180)
        self.assertTrue(np.all(sampler.coverage))
        self.assertLess(np.min(np.abs(sampler.column_grid - CEP_NI / 2)), 0.01)

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

    def test_only_surface_geopotential_is_used_as_altitude(self) -> None:
        metadata = {
            1: {"shortName": "z", "typeOfLevel": "surface"},
            2: {"shortName": "z", "typeOfLevel": "isobaricInhPa"},
        }

        def fake_get(gid: int, key: str, default=None):
            return metadata.get(gid, {}).get(key, default)

        with patch("update_cep_france.safe_get", side_effect=fake_get):
            self.assertEqual(message_field(1), "surface_geopotential")
            self.assertIsNone(message_field(2))

    def test_precise_department_boundaries_are_rendered(self) -> None:
        boundary_path = (
            ROOT
            / "config"
            / "france"
            / "departements-version-simplifiee.geojson"
        )
        with tempfile.TemporaryDirectory() as directory:
            output_directory = Path(directory) / "maps"
            CEPMapRenderer(
                np.empty(0),
                np.empty(0),
                output_directory,
                width=320,
                height=240,
                department_boundary_path=boundary_path,
                pregridded=True,
            )
            overlay = (output_directory / "frontieres.svg").read_text(
                encoding="utf-8",
            )

        self.assertIn('data-cepm-quality="precise"', overlay)
        self.assertIn('data-cepm-hide-deep="0"', overlay)
        self.assertGreater(overlay.count("M"), 100)


if __name__ == "__main__":
    unittest.main()
