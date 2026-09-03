#!/usr/bin/env python3
"""Produit des cartes WebP depuis la grille native CEP Europe.

Les champs ne sont jamais reconstruits depuis les communes. Les points natifs
du GRIB sont reprojetés sur une image Web Mercator couvrant l'Europe de l'Ouest,
puis les côtes, frontières nationales et limites départementales françaises
sont ajoutées dans une surcouche indépendante.
"""

from __future__ import annotations

import gzip
import json
import math
import struct
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree


MAP_SCHEMA_VERSION = 11
MODULE_VERSION = "1.5.4"
# Une valeur numérique tous les deux pixels cartographiques : le survol reste
# précis à l'échelle d'une commune sans multiplier déraisonnablement le poids
# de la branche de données.
PROBE_DOWNSAMPLE = 2
PROBE_MAGIC = b"CEV1"
STATIC_FIELDS = {"altitude_m"}
CONTOUR_STEPS = {
    "temperature_c": 1.0,
    "surface_temperature_c": 1.0,
    "wind_chill_c": 1.0,
    "dewpoint_c": 1.0,
    "humidex": 1.0,
    "wind_speed_kmh": 5.0,
    "wind_gust_kmh": 5.0,
    "pressure_hpa": 2.0,
    "surface_pressure_hpa": 2.0,
    "cloud_cover_pct": 5.0,
    "cloud_low_pct": 5.0,
    "cloud_mid_pct": 5.0,
    "cloud_high_pct": 5.0,
    "humidity_pct": 5.0,
    "cape_jkg": 100.0,
    "reflectivity_dbz": 2.0,
    "altitude_m": 50.0,
}
DEFAULT_BOUNDS = {
    "south": 38.0,
    "west": -12.0,
    "north": 57.0,
    "east": 18.0,
}


def _iter_shapefile_parts(path: Path):
    """Lit les lignes/polygones ESRI Shapefile sans dépendance externe.

    Les couches Natural Earth embarquées n'ont besoin que des coordonnées X/Y
    et des indices de parties. Les éventuelles valeurs Z/M peuvent donc être
    ignorées en toute sécurité.
    """

    with path.open("rb") as handle:
        header = handle.read(100)
        if len(header) != 100 or struct.unpack_from(">i", header, 0)[0] != 9994:
            raise ValueError(f"En-tête Shapefile invalide : {path}")

        while True:
            record_header = handle.read(8)
            if not record_header:
                break
            if len(record_header) != 8:
                raise ValueError(f"Enregistrement Shapefile tronqué : {path}")

            _record_number, content_words = struct.unpack(">2i", record_header)
            content_size = content_words * 2
            content = handle.read(content_size)
            if len(content) != content_size:
                raise ValueError(f"Contenu Shapefile tronqué : {path}")
            if len(content) < 4:
                continue

            shape_type = struct.unpack_from("<i", content, 0)[0]
            if shape_type == 0:
                continue
            if shape_type not in {3, 5, 13, 15, 23, 25} or len(content) < 44:
                continue

            part_count, point_count = struct.unpack_from("<2i", content, 36)
            if part_count <= 0 or point_count <= 0:
                continue
            required_size = 44 + 4 * part_count + 16 * point_count
            if len(content) < required_size:
                raise ValueError(f"Géométrie Shapefile tronquée : {path}")

            part_starts = list(
                struct.unpack_from(f"<{part_count}i", content, 44)
            )
            points_offset = 44 + 4 * part_count
            part_ends = part_starts[1:] + [point_count]
            for start, end in zip(part_starts, part_ends):
                if start < 0 or end > point_count or start >= end:
                    continue
                yield [
                    struct.unpack_from("<2d", content, points_offset + index * 16)
                    for index in range(start, end)
                ]


@dataclass(frozen=True)
class LayerSpec:
    key: str
    label: str
    unit: str
    field: str
    stops: tuple[tuple[float, str], ...]
    group: str = "Autres"
    decimals: int = 0
    transparent_below: float | None = None
    opacity: int = 244
    discrete: bool = False
    source_key: str | None = None
    range_mode: str | None = None


PRECIPITATION_STOPS = (
    (0.1, "#f5f5f7"),
    (1, "#c9e6ff"),
    (2, "#7fbbff"),
    (3, "#438fff"),
    (5, "#1bd0ef"),
    (7, "#00b8bd"),
    (10, "#00ca76"),
    (15, "#32e300"),
    (20, "#86ed00"),
    (25, "#d2ef00"),
    (30, "#fff000"),
    (40, "#ffd000"),
    (50, "#ff9900"),
    (60, "#ff6500"),
    (70, "#ff2e00"),
    (80, "#ef0054"),
    (90, "#d000a7"),
    (100, "#a000e8"),
    (125, "#6900dc"),
    (150, "#4b00b4"),
    (175, "#291078"),
    (200, "#661070"),
    (250, "#a548bd"),
    (300, "#d487e1"),
    (400, "#f0c8f2"),
    (500, "#ffffff"),
)


LAYER_SPECS = (
    LayerSpec(
        "temperature",
        "Température à 2 m",
        "°C",
        "temperature_c",
        (
            (-25, "#482173"),
            (-15, "#303fa5"),
            (-5, "#3478c5"),
            (0, "#55b7dd"),
            (5, "#53c6a8"),
            (10, "#70cf66"),
            (15, "#cbd83f"),
            (20, "#f2d43d"),
            (25, "#f2a331"),
            (30, "#ea652b"),
            (35, "#d93435"),
            (40, "#a71f57"),
            (45, "#5b1037"),
        ),
        group="Températures",
        decimals=1,
    ),
    LayerSpec(
        "temperature_ressentie",
        "Refroidissement éolien",
        "°C",
        "wind_chill_c",
        (
            (-35, "#27145d"),
            (-25, "#482173"),
            (-15, "#303fa5"),
            (-5, "#3478c5"),
            (0, "#55b7dd"),
            (5, "#53c6a8"),
            (10, "#70cf66"),
            (15, "#cbd83f"),
            (20, "#f2d43d"),
        ),
        group="Températures",
        decimals=1,
    ),
    LayerSpec(
        "temperature_surface",
        "Température de surface",
        "°C",
        "surface_temperature_c",
        (
            (-25, "#482173"), (-15, "#303fa5"), (-5, "#3478c5"),
            (0, "#55b7dd"), (5, "#53c6a8"), (10, "#70cf66"),
            (15, "#cbd83f"), (20, "#f2d43d"), (25, "#f2a331"),
            (30, "#ea652b"), (35, "#d93435"), (40, "#a71f57"),
            (45, "#5b1037"),
        ),
        group="Températures",
        decimals=1,
    ),
    LayerSpec(
        "point_rosee",
        "Point de rosée à 2 m",
        "°C",
        "dewpoint_c",
        (
            (-25, "#57336f"),
            (-15, "#3855a3"),
            (-5, "#398bca"),
            (0, "#56b7d8"),
            (5, "#58c8a2"),
            (10, "#79cf68"),
            (15, "#d5d64a"),
            (20, "#f0a83b"),
            (25, "#df5d3c"),
            (30, "#9f2955"),
        ),
        group="Températures",
        decimals=1,
    ),
    LayerSpec(
        "humidex",
        "Humidex",
        "",
        "humidex",
        (
            (-10, "#3478c5"),
            (0, "#55b7dd"),
            (10, "#53c6a8"),
            (20, "#b9d84c"),
            (25, "#f2d43d"),
            (30, "#f2a331"),
            (35, "#ea652b"),
            (40, "#d93435"),
            (45, "#a71f57"),
            (50, "#5b1037"),
        ),
        group="Températures",
        decimals=1,
    ),
    LayerSpec(
        "temperature_850",
        "Température à 850 hPa",
        "°C",
        "temperature_850_c",
        (
            (-40, "#321253"), (-30, "#423c9c"), (-20, "#326eb7"),
            (-10, "#3da6cf"), (0, "#5ac7ad"), (10, "#bcd84e"),
            (20, "#f0a33a"), (30, "#d6403e"), (40, "#701d4c"),
        ),
        group="Températures",
        decimals=1,
    ),
    LayerSpec(
        "temperature_500",
        "Température à 500 hPa",
        "°C",
        "temperature_500_c",
        (
            (-60, "#25104f"), (-50, "#3f3191"), (-40, "#315fae"),
            (-30, "#398fc7"), (-20, "#51bfd0"), (-10, "#6dc89b"),
            (0, "#cbd84b"), (10, "#ef9937"),
        ),
        group="Températures",
        decimals=1,
    ),
    LayerSpec(
        "pluie_1h",
        "Précipitations depuis l’échéance précédente",
        "mm",
        "precipitation_mm",
        tuple(stop for stop in PRECIPITATION_STOPS if stop[0] <= 100),
        group="Précipitations",
        decimals=1,
        transparent_below=0.03,
        opacity=255,
        discrete=True,
    ),
    LayerSpec(
        "pluie_cumul",
        "Précipitations cumulées sur une période",
        "mm",
        "precipitation_total_mm",
        PRECIPITATION_STOPS,
        group="Précipitations",
        decimals=1,
        transparent_below=0.03,
        opacity=255,
        discrete=True,
        range_mode="difference",
    ),
    LayerSpec(
        "neige",
        "Neige depuis l’échéance précédente (équivalent eau)",
        "mm",
        "snow_mm",
        tuple(stop for stop in PRECIPITATION_STOPS if stop[0] <= 100),
        group="Précipitations",
        decimals=1,
        transparent_below=0.03,
        opacity=255,
        discrete=True,
    ),
    LayerSpec(
        "neige_au_sol",
        "Cumul de neige fraîche (estimé)",
        "cm",
        "snow_depth_cm",
        (
            (0.1, "#f4f7fb"), (1, "#d7efff"), (2, "#a9d9ff"),
            (5, "#70b8ef"), (10, "#3a91d5"), (20, "#536bc1"),
            (30, "#7048ac"), (50, "#963b92"), (75, "#c65382"),
            (100, "#f0b5cf"),
        ),
        group="Précipitations",
        decimals=1,
        transparent_below=0.05,
        discrete=True,
    ),
    LayerSpec(
        "equivalent_eau_neige",
        "Cumul neigeux (équivalent eau)",
        "mm",
        "snow_water_equivalent_mm",
        tuple(stop for stop in PRECIPITATION_STOPS if stop[0] <= 200),
        group="Précipitations",
        decimals=1,
        transparent_below=0.03,
        discrete=True,
    ),
    LayerSpec(
        "graupel",
        "Graupel",
        "mm",
        "graupel_mm",
        tuple(stop for stop in PRECIPITATION_STOPS if stop[0] <= 100),
        group="Précipitations",
        decimals=1,
        transparent_below=0.03,
        discrete=True,
    ),
    LayerSpec(
        "vent",
        "Vent moyen à 10 m",
        "km/h",
        "wind_speed_kmh",
        (
            (0, "#eef7ea"),
            (10, "#a7db8d"),
            (20, "#5cc27d"),
            (30, "#38aaa5"),
            (40, "#347cc3"),
            (50, "#6558b8"),
            (60, "#a43e94"),
            (80, "#d63c57"),
            (100, "#7e1736"),
        ),
        group="Vent",
    ),
    LayerSpec(
        "rafales",
        "Rafales à 10 m",
        "km/h",
        "wind_gust_kmh",
        (
            (0, "#edf7e8"),
            (20, "#a9d77d"),
            (40, "#f0cf46"),
            (60, "#ef8b2c"),
            (80, "#db3d3d"),
            (100, "#9e235d"),
            (130, "#4d1647"),
            (160, "#25152e"),
        ),
        group="Vent",
    ),
    LayerSpec(
        "rafales_max",
        "Rafales maximales sur une période",
        "km/h",
        "wind_gust_kmh",
        (
            (0, "#edf7e8"),
            (20, "#a9d77d"),
            (40, "#f0cf46"),
            (60, "#ef8b2c"),
            (80, "#db3d3d"),
            (100, "#9e235d"),
            (130, "#4d1647"),
            (160, "#25152e"),
        ),
        group="Vent",
        source_key="rafales",
        range_mode="maximum",
    ),
    LayerSpec(
        "vent_850",
        "Vent à 850 hPa",
        "km/h",
        "wind_speed_850_kmh",
        (
            (0, "#eef7ea"), (20, "#a7db8d"), (40, "#43b894"),
            (60, "#347cc3"), (80, "#6558b8"), (100, "#a43e94"),
            (140, "#d63c57"), (180, "#7e1736"), (220, "#35132b"),
        ),
        group="Vent",
    ),
    LayerSpec(
        "vent_500",
        "Vent à 500 hPa",
        "km/h",
        "wind_speed_500_kmh",
        (
            (0, "#eef7ea"), (30, "#a7db8d"), (60, "#43b894"),
            (90, "#347cc3"), (120, "#6558b8"), (150, "#a43e94"),
            (200, "#d63c57"), (250, "#7e1736"), (300, "#35132b"),
        ),
        group="Vent",
    ),
    LayerSpec(
        "jet_stream",
        "Vent à 300 hPa (jet stream)",
        "km/h",
        "wind_speed_300_kmh",
        (
            (0, "#eef7ea"), (40, "#a7db8d"), (80, "#43b894"),
            (120, "#347cc3"), (160, "#6558b8"), (200, "#a43e94"),
            (250, "#d63c57"), (300, "#7e1736"), (350, "#35132b"),
        ),
        group="Vent",
    ),
    LayerSpec(
        "pression",
        "Pression au niveau de la mer (estimée)",
        "hPa",
        "pressure_hpa",
        (
            (960, "#562a7c"),
            (975, "#315ab4"),
            (990, "#2f98c5"),
            (1000, "#48b983"),
            (1010, "#c6d64f"),
            (1020, "#f0c646"),
            (1030, "#e57a34"),
            (1045, "#b52f43"),
        ),
        group="Pression, instabilité et relief",
    ),
    LayerSpec(
        "pression_surface",
        "Pression au sol",
        "hPa",
        "surface_pressure_hpa",
        (
            (700, "#44205f"), (800, "#3455a6"), (900, "#36a1bd"),
            (950, "#54bf7c"), (1000, "#d6d64c"), (1030, "#ed9a36"),
            (1060, "#b52f43"),
        ),
        group="Pression, instabilité et relief",
    ),
    LayerSpec(
        "geopotentiel_500",
        "Géopotentiel à 500 hPa",
        "m",
        "geopotential_500_m",
        (
            (4800, "#3f1d69"), (5000, "#354bab"), (5200, "#3384c3"),
            (5400, "#3cb9aa"), (5600, "#b5d04d"), (5800, "#efad3b"),
            (6000, "#cf493e"),
        ),
        group="Pression, instabilité et relief",
    ),
    LayerSpec(
        "geopotentiel_850",
        "Géopotentiel à 850 hPa",
        "m",
        "geopotential_850_m",
        (
            (900, "#3f1d69"), (1100, "#354bab"), (1300, "#3384c3"),
            (1500, "#3cb9aa"), (1700, "#b5d04d"), (1900, "#efad3b"),
            (2100, "#cf493e"),
        ),
        group="Pression, instabilité et relief",
    ),
    LayerSpec(
        "nebulosite",
        "Nébulosité totale",
        "%",
        "cloud_cover_pct",
        (
            (0, "#dceef6"),
            (20, "#c8dce5"),
            (40, "#abbac5"),
            (60, "#8997a4"),
            (80, "#626e79"),
            (100, "#343d46"),
        ),
        group="Nuages et humidité",
    ),
    LayerSpec(
        "nuages_bas",
        "Couverture nuageuse basse",
        "%",
        "cloud_low_pct",
        (
            (0, "#e6f4fa"),
            (20, "#cddfe7"),
            (40, "#adbec8"),
            (60, "#8997a4"),
            (80, "#626e79"),
            (100, "#343d46"),
        ),
        group="Nuages et humidité",
    ),
    LayerSpec(
        "nuages_moyens",
        "Couverture nuageuse moyenne",
        "%",
        "cloud_mid_pct",
        (
            (0, "#e6f4fa"),
            (20, "#cddfe7"),
            (40, "#adbec8"),
            (60, "#8997a4"),
            (80, "#626e79"),
            (100, "#343d46"),
        ),
        group="Nuages et humidité",
    ),
    LayerSpec(
        "nuages_eleves",
        "Couverture nuageuse élevée",
        "%",
        "cloud_high_pct",
        (
            (0, "#e6f4fa"),
            (20, "#cddfe7"),
            (40, "#adbec8"),
            (60, "#8997a4"),
            (80, "#626e79"),
            (100, "#343d46"),
        ),
        group="Nuages et humidité",
    ),
    LayerSpec(
        "humidite",
        "Humidité relative à 2 m",
        "%",
        "humidity_pct",
        (
            (0, "#9a5429"),
            (20, "#d19a52"),
            (40, "#e3d16b"),
            (60, "#83ca82"),
            (80, "#48a6b6"),
            (100, "#28569f"),
        ),
        group="Nuages et humidité",
    ),
    LayerSpec(
        "visibilite",
        "Visibilité",
        "km",
        "visibility_km",
        (
            (0, "#7b1f1f"),
            (1, "#cf3d35"),
            (2, "#ed8b33"),
            (5, "#e6ce4f"),
            (10, "#88c681"),
            (20, "#67b8d0"),
            (50, "#d8f1ff"),
        ),
        group="Nuages et humidité",
        decimals=1,
    ),
    LayerSpec(
        "humidite_850",
        "Humidité relative à 850 hPa",
        "%",
        "humidity_850_pct",
        (
            (0, "#9a5429"), (20, "#d19a52"), (40, "#e3d16b"),
            (60, "#83ca82"), (80, "#48a6b6"), (100, "#28569f"),
        ),
        group="Nuages et humidité",
    ),
    LayerSpec(
        "humidite_500",
        "Humidité relative à 500 hPa",
        "%",
        "humidity_500_pct",
        (
            (0, "#9a5429"), (20, "#d19a52"), (40, "#e3d16b"),
            (60, "#83ca82"), (80, "#48a6b6"), (100, "#28569f"),
        ),
        group="Nuages et humidité",
    ),
    LayerSpec(
        "base_nuages",
        "Altitude de la base des nuages",
        "m",
        "cloud_base_m",
        (
            (0, "#5c2447"), (100, "#a33a45"), (200, "#df6b3e"),
            (500, "#e6b846"), (1000, "#9bcb72"), (2000, "#59b3bd"),
            (4000, "#6d75bd"), (8000, "#d4d9ef"),
        ),
        group="Nuages et humidité",
    ),
    LayerSpec(
        "couche_limite",
        "Hauteur de la couche limite",
        "m",
        "mixed_layer_depth_m",
        (
            (0, "#36215e"), (100, "#3f4a9f"), (300, "#397fb9"),
            (500, "#46afad"), (1000, "#a6cf66"), (1500, "#e4c84c"),
            (2500, "#e5813d"), (4000, "#b73549"),
        ),
        group="Autres",
    ),
    LayerSpec(
        "rayonnement_global",
        "Rayonnement solaire global cumulé",
        "MJ/m²",
        "global_radiation_mjm2",
        (
            (0, "#24346f"), (0.5, "#346aa5"), (1, "#3da6b3"),
            (2, "#72c776"), (4, "#d4d74c"), (6, "#f3b53d"),
            (9, "#e36b35"), (12, "#a52f49"),
        ),
        group="Autres",
        decimals=2,
    ),
    LayerSpec(
        "rayonnement_court",
        "Rayonnement net ondes courtes cumulé",
        "MJ/m²",
        "net_shortwave_mjm2",
        (
            (-2, "#352061"), (0, "#345e9f"), (1, "#39a3b5"),
            (2, "#77c66e"), (4, "#d5d54a"), (6, "#f0a33b"),
            (10, "#c63d43"),
        ),
        group="Autres",
        decimals=2,
    ),
    LayerSpec(
        "rayonnement_long",
        "Rayonnement net ondes longues cumulé",
        "MJ/m²",
        "net_longwave_mjm2",
        (
            (-8, "#341c64"), (-5, "#3b57aa"), (-3, "#3ca0bd"),
            (-1, "#7bca7d"), (0, "#e2d34c"), (1, "#e47b38"),
            (3, "#b63148"),
        ),
        group="Autres",
        decimals=2,
    ),
    LayerSpec(
        "flux_sensible",
        "Flux de chaleur sensible cumulé",
        "MJ/m²",
        "sensible_heat_mjm2",
        (
            (-8, "#2c2876"), (-4, "#397fbc"), (-1, "#55c1ba"),
            (0, "#e7e8d0"), (1, "#e7cf4e"), (4, "#e47b38"),
            (8, "#aa3049"),
        ),
        group="Autres",
        decimals=2,
    ),
    LayerSpec(
        "flux_latent",
        "Flux de chaleur latente cumulé",
        "MJ/m²",
        "latent_heat_mjm2",
        (
            (-8, "#2c2876"), (-4, "#397fbc"), (-1, "#55c1ba"),
            (0, "#e7e8d0"), (1, "#e7cf4e"), (4, "#e47b38"),
            (8, "#aa3049"),
        ),
        group="Autres",
        decimals=2,
    ),
    LayerSpec(
        "mucape",
        "MUCAPE instantanée",
        "J/kg",
        "cape_jkg",
        (
            (0, "#f3f5f8"), (100, "#d8ebff"), (300, "#91c8ff"),
            (500, "#41a8df"), (800, "#31c878"), (1200, "#d5e52f"),
            (1800, "#ffc62d"), (2500, "#ff7a22"), (3500, "#e83028"),
            (5000, "#8c1d74"),
        ),
        group="Pression, instabilité et relief",
        transparent_below=25.0,
    ),
    LayerSpec(
        "reflectivite",
        "Réflectivité radar maximale",
        "dBZ",
        "reflectivity_dbz",
        (
            (0, "#f5f5f7"), (5, "#c9e6ff"), (10, "#7fbbff"),
            (15, "#25cbe0"), (20, "#00bd75"), (25, "#5be000"),
            (30, "#d5eb00"), (35, "#ffe500"), (40, "#ffae00"),
            (45, "#ff6500"), (50, "#f32020"), (55, "#d00076"),
            (60, "#9300c6"), (70, "#ffffff"),
        ),
        group="Pression, instabilité et relief",
        transparent_below=5.0,
    ),
    LayerSpec(
        "altitude",
        "Altitude du relief",
        "m",
        "altitude_m",
        (
            (-50, "#d6e8ef"), (0, "#d8e8c1"), (100, "#b8d98c"),
            (300, "#9bc267"), (600, "#c3b563"), (1000, "#b88d58"),
            (1500, "#966b52"), (2200, "#765054"), (3200, "#eeeeee"),
            (4500, "#ffffff"),
        ),
        group="Pression, instabilité et relief",
    ),
)


def _hex_to_rgb(value: str) -> np.ndarray:
    clean = value.lstrip("#")
    return np.asarray(
        tuple(int(clean[index : index + 2], 16) for index in (0, 2, 4))
    )


def _mercator(latitude: np.ndarray | float) -> np.ndarray | float:
    radians = np.radians(np.clip(latitude, -85.0, 85.0))
    return np.log(np.tan(np.pi / 4.0 + radians / 2.0))


def _inverse_mercator(value: np.ndarray) -> np.ndarray:
    return np.degrees(2.0 * np.arctan(np.exp(value)) - np.pi / 2.0)


class CEPMapRenderer:
    """Rend les champs CEP natifs et les frontières cartographiques."""

    def __init__(
        self,
        latitudes: np.ndarray,
        longitudes: np.ndarray,
        output_directory: Path,
        *,
        width: int = 2200,
        height: int = 1640,
        bounds: dict[str, float] | None = None,
        source_max_distance: float = 0.22,
        france_latitudes: np.ndarray | None = None,
        france_longitudes: np.ndarray | None = None,
        france_departments: Sequence[str] | None = None,
        boundary_directory: Path | None = None,
        department_boundary_path: Path | None = None,
        pregridded: bool = False,
    ) -> None:
        self.latitudes = np.asarray(latitudes, dtype=np.float64)
        self.longitudes = np.asarray(longitudes, dtype=np.float64)
        self.pregridded = bool(pregridded)
        if self.latitudes.shape != self.longitudes.shape or self.latitudes.ndim != 1:
            raise ValueError("Coordonnées cartographiques invalides")
        if not self.pregridded and len(self.latitudes) < 4:
            raise ValueError("Au moins quatre points CEP sont nécessaires")

        self.output_directory = Path(output_directory)
        self.output_directory.mkdir(parents=True, exist_ok=True)
        self.width = int(width)
        self.height = int(height)
        self.bounds = dict(bounds or DEFAULT_BOUNDS)
        self.source_max_distance = float(source_max_distance)
        self.boundary_directory = (
            Path(boundary_directory) if boundary_directory is not None else None
        )
        self.department_boundary_path = (
            Path(department_boundary_path)
            if department_boundary_path is not None
            else None
        )
        self.france_latitudes = (
            np.asarray(france_latitudes, dtype=np.float64)
            if france_latitudes is not None
            else None
        )
        self.france_longitudes = (
            np.asarray(france_longitudes, dtype=np.float64)
            if france_longitudes is not None
            else None
        )
        self.france_departments = (
            list(france_departments) if france_departments is not None else None
        )
        self.steps: list[dict[str, Any]] = []
        self.available_layers: set[str] = set()
        self._static_assets: dict[str, tuple[str, str]] = {}

        self._prepare_interpolation()
        self._write_static_maps()

    def _prepare_interpolation(self) -> None:
        south = float(self.bounds["south"])
        north = float(self.bounds["north"])
        west = float(self.bounds["west"])
        east = float(self.bounds["east"])
        mercator_rows = np.linspace(_mercator(north), _mercator(south), self.height)
        grid_latitudes = _inverse_mercator(mercator_rows)
        grid_longitudes = np.linspace(west, east, self.width)
        longitude_grid, latitude_grid = np.meshgrid(grid_longitudes, grid_latitudes)
        self._target_latitudes = latitude_grid
        self._target_longitudes = longitude_grid
        latitude_midpoint = (south + north) / 2.0
        self._longitude_scale = math.cos(math.radians(latitude_midpoint))

        if self.pregridded:
            self._coverage_mask = np.ones((self.height, self.width), dtype=bool)
            self._indexes = None
            self._weights = None
            return

        source = np.column_stack(
            (self.longitudes * self._longitude_scale, self.latitudes)
        )
        target = np.column_stack(
            (
                longitude_grid.ravel() * self._longitude_scale,
                latitude_grid.ravel(),
            )
        )
        neighbour_count = min(4, len(source))
        distances, indexes = cKDTree(source).query(
            target,
            k=neighbour_count,
            workers=-1,
        )
        if neighbour_count == 1:
            distances = distances[:, None]
            indexes = indexes[:, None]
        self._indexes = indexes.astype(np.int32, copy=False)
        self._weights = (
            1.0 / np.maximum(distances, 1.0e-4) ** 2
        ).astype(np.float32, copy=False)
        self._coverage_mask = (
            distances[:, 0].reshape(self.height, self.width)
            <= self.source_max_distance
        )

    def _interpolate(self, values: np.ndarray) -> np.ndarray:
        source = np.asarray(values, dtype=np.float64)
        if self.pregridded:
            if source.shape == (self.height, self.width):
                return source.astype(np.float32, copy=False)
            if source.ndim == 1 and source.size == self.height * self.width:
                return source.reshape(self.height, self.width).astype(
                    np.float32, copy=False
                )
            raise ValueError(
                "Le champ CEP préinterpolé ne correspond pas à la carte"
            )
        if source.shape != self.latitudes.shape:
            raise ValueError("Le champ ne correspond pas à la grille CEP native")
        selected = source[self._indexes]
        finite = np.isfinite(selected)
        weights = self._weights * finite
        denominator = np.sum(weights, axis=1)
        numerator = np.sum(np.where(finite, selected, 0.0) * weights, axis=1)
        result = np.full(len(denominator), np.nan, dtype=np.float32)
        valid = denominator > 0
        result[valid] = numerator[valid] / denominator[valid]
        return result.reshape(self.height, self.width)

    def _image_from_field(self, field: np.ndarray, spec: LayerSpec) -> Image.Image:
        stop_values = np.asarray([item[0] for item in spec.stops], dtype=np.float32)
        stop_colours = np.asarray([_hex_to_rgb(item[1]) for item in spec.stops])
        finite_field = np.isfinite(field)
        clipped = np.clip(
            np.where(finite_field, field, stop_values[0]),
            stop_values[0],
            stop_values[-1],
        )
        # Le champ a déjà été interpolé par spline bicubique sur toute la carte.
        # Cette quantification produit ensuite de vraies plages d'isovaleurs
        # remplies : couleur constante dans chaque zone et contours fluides.
        contour_step = CONTOUR_STEPS.get(spec.field)
        if contour_step:
            clipped = np.floor(clipped / contour_step) * contour_step
        upper = np.searchsorted(stop_values, clipped, side="right")
        upper = np.clip(upper, 1, len(stop_values) - 1)
        lower = upper - 1
        if spec.discrete:
            rgb = stop_colours[lower].astype(np.uint8)
        else:
            low_values = stop_values[lower]
            high_values = stop_values[upper]
            fraction = np.divide(
                clipped - low_values,
                high_values - low_values,
                out=np.zeros_like(clipped),
                where=(high_values != low_values),
            )
            rgb = (
                stop_colours[lower] * (1.0 - fraction[..., None])
                + stop_colours[upper] * fraction[..., None]
            ).astype(np.uint8)
        alpha = np.full(field.shape, spec.opacity, dtype=np.uint8)
        valid = self._coverage_mask & finite_field
        if spec.transparent_below is not None:
            valid &= field >= spec.transparent_below
        alpha[~valid] = 0
        return Image.fromarray(np.dstack((rgb, alpha)), mode="RGBA")

    def _write_probe_field(
        self,
        field: np.ndarray,
        spec: LayerSpec,
        destination: Path,
    ) -> None:
        """Écrit une grille numérique compacte pour la valeur sous le pointeur.

        La grille conserve la résolution utile du modèle tout en évitant de
        publier un second raster pleine définition. Les valeurs sont
        quantifiées sur 16 bits puis compressées en gzip ; 65535 représente
        un point hors domaine ou manquant.
        """

        sampled = np.asarray(
            field[::PROBE_DOWNSAMPLE, ::PROBE_DOWNSAMPLE],
            dtype=np.float32,
        )
        coverage = self._coverage_mask[
            ::PROBE_DOWNSAMPLE,
            ::PROBE_DOWNSAMPLE,
        ]
        minimum = (
            0.0
            if spec.transparent_below is not None
            and spec.transparent_below >= 0
            else float(spec.stops[0][0])
        )
        maximum = float(spec.stops[-1][0])
        if not maximum > minimum:
            raise ValueError(f"Échelle cartographique invalide : {spec.key}")

        valid = coverage & np.isfinite(sampled)
        encoded = np.full(sampled.shape, 65535, dtype="<u2")
        normalized = (
            np.clip(sampled[valid], minimum, maximum) - minimum
        ) / (maximum - minimum)
        encoded[valid] = np.rint(normalized * 65534.0).astype("<u2")

        destination.parent.mkdir(parents=True, exist_ok=True)
        header = struct.pack(
            "<4sHHff",
            PROBE_MAGIC,
            encoded.shape[1],
            encoded.shape[0],
            minimum,
            maximum,
        )
        with destination.open("wb") as raw:
            with gzip.GzipFile(
                filename="",
                mode="wb",
                fileobj=raw,
                compresslevel=6,
                mtime=0,
            ) as compressed:
                compressed.write(header)
                compressed.write(encoded.tobytes(order="C"))

    @staticmethod
    def _edge_point(
        edge: int,
        x: int,
        y: int,
        values: tuple[float, float, float, float],
        level: float,
        stride: int,
    ) -> tuple[float, float]:
        top_left, top_right, bottom_right, bottom_left = values
        endpoints = {
            0: ((x, y, top_left), (x + 1, y, top_right)),
            1: ((x + 1, y, top_right), (x + 1, y + 1, bottom_right)),
            2: ((x, y + 1, bottom_left), (x + 1, y + 1, bottom_right)),
            3: ((x, y, top_left), (x, y + 1, bottom_left)),
        }
        first, second = endpoints[edge]
        difference = second[2] - first[2]
        fraction = 0.5 if abs(difference) < 1.0e-9 else (level - first[2]) / difference
        fraction = max(0.0, min(1.0, fraction))
        return (
            (first[0] + fraction * (second[0] - first[0])) * stride,
            (first[1] + fraction * (second[1] - first[1])) * stride,
        )

    def _contour_path(
        self,
        field: np.ndarray,
        levels: Sequence[float],
        stride: int = 8,
        label_candidates: dict[float, list[tuple[float, float]]] | None = None,
    ) -> str:
        sampled = np.asarray(field[::stride, ::stride], dtype=np.float32)
        # Paires d'arêtes Marching Squares : haut, droite, bas, gauche.
        cases = {
            1: ((3, 0),), 2: ((0, 1),), 3: ((3, 1),),
            4: ((1, 2),), 5: ((3, 0), (1, 2)), 6: ((0, 2),),
            7: ((3, 2),), 8: ((2, 3),), 9: ((0, 2),),
            10: ((0, 1), (2, 3)), 11: ((1, 2),),
            12: ((1, 3),), 13: ((0, 1),), 14: ((3, 0),),
        }
        commands: list[str] = []
        for level in levels:
            for y in range(sampled.shape[0] - 1):
                for x in range(sampled.shape[1] - 1):
                    values = (
                        float(sampled[y, x]),
                        float(sampled[y, x + 1]),
                        float(sampled[y + 1, x + 1]),
                        float(sampled[y + 1, x]),
                    )
                    if not all(math.isfinite(value) for value in values):
                        continue
                    case = sum(
                        bit for bit, value in zip((1, 2, 4, 8), values)
                        if value >= level
                    )
                    for first_edge, second_edge in cases.get(case, ()):
                        first = self._edge_point(
                            first_edge, x, y, values, level, stride
                        )
                        second = self._edge_point(
                            second_edge, x, y, values, level, stride
                        )
                        commands.append(
                            f"M{first[0]:.1f},{first[1]:.1f} "
                            f"L{second[0]:.1f},{second[1]:.1f}"
                        )
                        if label_candidates is not None:
                            label_candidates.setdefault(float(level), []).append((
                                (first[0] + second[0]) / 2.0,
                                (first[1] + second[1]) / 2.0,
                            ))
        return " ".join(commands)

    def _isobar_label_points(
        self,
        candidates: dict[float, list[tuple[float, float]]],
        levels: Sequence[float],
    ) -> str:
        labels: list[str] = []
        targets = (
            (self.width * 0.28, self.height * 0.32),
            (self.width * 0.70, self.height * 0.68),
        )
        for level_index, level in enumerate(levels):
            available = list(candidates.get(float(level), ()))
            selected: list[tuple[float, float]] = []
            for target_index in range(len(targets)):
                if not available:
                    break
                target_x, target_y = targets[
                    (target_index + level_index) % len(targets)
                ]
                best = min(
                    available,
                    key=lambda point: (
                        ((point[0] - target_x) / self.width) ** 2
                        + ((point[1] - target_y) / self.height) ** 2
                    ),
                )
                if any(
                    math.hypot(best[0] - previous[0], best[1] - previous[1])
                    < min(self.width, self.height) * 0.22
                    for previous in selected
                ):
                    continue
                selected.append(best)
                available = [
                    point for point in available
                    if math.hypot(point[0] - best[0], point[1] - best[1])
                    >= min(self.width, self.height) * 0.22
                ]
            labels.extend(
                f"{point[0]:.1f},{point[1]:.1f},{level:.0f}"
                for point in selected
            )
        return ";".join(labels)

    @staticmethod
    def _distance_to_isobar(value: float, interval: float) -> float:
        if not math.isfinite(value) or interval <= 0:
            return -1.0
        return abs(value - round(value / interval) * interval)

    @staticmethod
    def _isobar_clearance(
        pressure: np.ndarray,
        x: int,
        y: int,
        interval: float,
        radius: int = 15,
    ) -> float:
        """Distance minimale à une isobare autour de tout le symbole.

        Contrôler uniquement la pression au centre laisse l'axe ou la pointe
        d'une flèche couper une isobare. La zone complète occupée à l'écran est
        donc testée avant de conserver la position.
        """

        if interval <= 0:
            return -1.0
        height, width = pressure.shape
        left = max(0, x - radius)
        right = min(width, x + radius + 1)
        top = max(0, y - radius)
        bottom = min(height, y + radius + 1)
        patch = np.asarray(pressure[top:bottom, left:right], dtype=np.float32)
        finite = patch[np.isfinite(patch)]
        if not finite.size:
            return -1.0
        distances = np.abs(finite - np.rint(finite / interval) * interval)
        return float(np.nanmin(distances))

    def _wind_arrow_paths(
        self,
        u_wind: np.ndarray,
        v_wind: np.ndarray,
        pressure: np.ndarray | None = None,
        isobar_interval: float = 4.0,
        spacing: int = 112,
    ) -> tuple[str, str]:
        commands: list[str] = []
        points: list[str] = []
        # Le tracé SVG compact reste lisible si une ancienne version du module
        # charge les nouvelles données. Le module courant redessine ces symboles
        # à taille constante à partir de ``points``.
        length = 14.0
        head = 4.2
        offsets = (
            (0, 0),
            (spacing // 4, 0),
            (-spacing // 4, 0),
            (0, spacing // 4),
            (0, -spacing // 4),
            (spacing // 5, spacing // 5),
            (-spacing // 5, spacing // 5),
            (spacing // 5, -spacing // 5),
            (-spacing // 5, -spacing // 5),
        )
        for y in range(spacing // 2, self.height, spacing):
            for x in range(spacing // 2, self.width, spacing):
                arrow_x, arrow_y = x, y
                if pressure is not None:
                    candidates: list[tuple[float, int, int]] = []
                    for offset_x, offset_y in offsets:
                        candidate_x = x + offset_x
                        candidate_y = y + offset_y
                        if not (
                            0 <= candidate_x < self.width
                            and 0 <= candidate_y < self.height
                        ):
                            continue
                        candidates.append((
                            self._isobar_clearance(
                                pressure,
                                candidate_x,
                                candidate_y,
                                isobar_interval,
                            ),
                            candidate_x,
                            candidate_y,
                        ))
                    if candidates:
                        score, arrow_x, arrow_y = max(candidates)
                        if score < 0.62:
                            continue

                u_value = float(u_wind[arrow_y, arrow_x])
                v_value = float(v_wind[arrow_y, arrow_x])
                speed = math.hypot(u_value, v_value)
                if not math.isfinite(speed) or speed < 5.0:
                    continue
                dx = u_value / speed
                dy = -v_value / speed
                start_x = arrow_x - dx * length / 2.0
                start_y = arrow_y - dy * length / 2.0
                end_x = arrow_x + dx * length / 2.0
                end_y = arrow_y + dy * length / 2.0
                normal_x, normal_y = -dy, dx
                left_x = end_x - dx * head + normal_x * head * 0.55
                left_y = end_y - dy * head + normal_y * head * 0.55
                right_x = end_x - dx * head - normal_x * head * 0.55
                right_y = end_y - dy * head - normal_y * head * 0.55
                commands.append(
                    f"M{start_x:.1f},{start_y:.1f} L{end_x:.1f},{end_y:.1f} "
                    f"M{left_x:.1f},{left_y:.1f} L{end_x:.1f},{end_y:.1f} "
                    f"L{right_x:.1f},{right_y:.1f}"
                )
                points.append(
                    f"{arrow_x},{arrow_y},{dx:.4f},{dy:.4f},{speed:.1f}"
                )
        return " ".join(commands), ";".join(points)

    @staticmethod
    def _isobar_levels(pressure: np.ndarray, interval: float = 4.0) -> np.ndarray:
        finite = np.asarray(pressure, dtype=np.float32)
        finite = finite[np.isfinite(finite)]
        finite = finite[(finite >= 870.0) & (finite <= 1085.0)]
        if not finite.size:
            return np.empty(0, dtype=np.float32)
        minimum = float(np.nanpercentile(finite, 0.2))
        maximum = float(np.nanpercentile(finite, 99.8))
        first = math.ceil(minimum / interval) * interval
        last = math.floor(maximum / interval) * interval
        if last < first:
            return np.empty(0, dtype=np.float32)
        return np.arange(first, last + interval * 0.5, interval)

    def _write_wind_overlay(
        self,
        u_wind: np.ndarray,
        v_wind: np.ndarray,
        destination: Path,
        pressure: np.ndarray | None = None,
        isobar_interval: float = 4.0,
    ) -> None:
        isobar_path = ""
        isobar_labels = ""
        if pressure is not None and np.any(np.isfinite(pressure)):
            levels = self._isobar_levels(pressure, isobar_interval)
            label_candidates: dict[float, list[tuple[float, float]]] = {}
            isobar_path = self._contour_path(
                pressure, levels, label_candidates=label_candidates
            )
            isobar_labels = self._isobar_label_points(
                label_candidates, levels
            )
        arrow_path, arrow_points = self._wind_arrow_paths(
            u_wind,
            v_wind,
            pressure=pressure,
            isobar_interval=isobar_interval,
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        svg = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.width} '
            f'{self.height}" preserveAspectRatio="none" '
            'shape-rendering="geometricPrecision">\n'
            f'<path d="{isobar_path}" fill="none" stroke="#172b39" '
            'stroke-opacity="0.8" stroke-width="1.05" '
            'stroke-linejoin="round" stroke-linecap="round" '
            'data-cepm-role="isobars" data-cepm-interval="4"/>\n'
            f'<path d="" fill="none" stroke="none" '
            'data-cepm-role="isobar-labels" '
            f'data-cepm-labels="{isobar_labels}"/>\n'
            f'<path d="{arrow_path}" fill="none" stroke="#eef7fa" '
            'stroke-opacity="0.94" stroke-width="4.2" '
            'stroke-linejoin="round" stroke-linecap="round" '
            'data-cepm-role="wind-arrow-fallback"/>\n'
            f'<path d="{arrow_path}" fill="none" stroke="#071923" '
            'stroke-opacity="0.96" stroke-width="1.35" '
            'stroke-linejoin="round" stroke-linecap="round" '
            'data-cepm-role="wind-arrow-fallback"/>\n'
            f'<path d="" fill="none" stroke="none" '
            'data-cepm-role="wind-arrows" '
            f'data-cepm-points="{arrow_points}"/>\n'
            '</svg>\n'
        )
        destination.write_text(svg, encoding="utf-8")

    def _pixel(self, latitude: float, longitude: float) -> tuple[float, float]:
        west = float(self.bounds["west"])
        east = float(self.bounds["east"])
        north_y = float(_mercator(float(self.bounds["north"])))
        south_y = float(_mercator(float(self.bounds["south"])))
        x = (longitude - west) / (east - west) * (self.width - 1)
        y = (north_y - float(_mercator(latitude))) / (north_y - south_y)
        y *= self.height - 1
        # Conserver les sous-pixels est essentiel : un arrondi entier produit
        # des escaliers très visibles sur les limites départementales au zoom.
        return float(x), float(y)

    def _shapefile_svg_path(self, path: Path) -> str:
        if not path.is_file():
            return ""
        south = float(self.bounds["south"]) - 1
        north = float(self.bounds["north"]) + 1
        west = float(self.bounds["west"]) - 1
        east = float(self.bounds["east"]) + 1
        paths: list[str] = []
        for points in _iter_shapefile_parts(path):
            segment: list[tuple[float, float]] = []
            for longitude, latitude in points:
                if west <= longitude <= east and south <= latitude <= north:
                    segment.append(self._pixel(latitude, longitude))
                elif segment:
                    if len(segment) >= 2:
                        paths.append(
                            "M" + " L".join(
                                f"{x:.1f},{y:.1f}" for x, y in segment
                            )
                        )
                    segment = []
            if len(segment) >= 2:
                paths.append(
                    "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in segment)
                )
        return " ".join(paths)

    def _geojson_svg_path(self, path: Path) -> str:
        """Projette les anneaux Polygon/MultiPolygon d'un fichier GeoJSON."""

        if not path.is_file():
            return ""
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return ""

        features = payload.get("features")
        if payload.get("type") != "FeatureCollection" or not isinstance(
            features,
            list,
        ):
            return ""

        south = float(self.bounds["south"]) - 1.0
        north = float(self.bounds["north"]) + 1.0
        west = float(self.bounds["west"]) - 1.0
        east = float(self.bounds["east"]) + 1.0
        paths: list[str] = []

        for feature in features:
            geometry = feature.get("geometry") if isinstance(feature, dict) else None
            if not isinstance(geometry, dict):
                continue
            geometry_type = geometry.get("type")
            coordinates = geometry.get("coordinates")
            if geometry_type == "Polygon":
                polygons = [coordinates]
            elif geometry_type == "MultiPolygon":
                polygons = coordinates
            else:
                continue
            if not isinstance(polygons, list):
                continue

            for polygon in polygons:
                if not isinstance(polygon, list):
                    continue
                for ring in polygon:
                    if not isinstance(ring, list):
                        continue
                    points: list[tuple[float, float]] = []
                    for coordinate in ring:
                        if not isinstance(coordinate, list) or len(coordinate) < 2:
                            continue
                        try:
                            longitude = float(coordinate[0])
                            latitude = float(coordinate[1])
                        except (TypeError, ValueError):
                            continue
                        if math.isfinite(longitude) and math.isfinite(latitude):
                            points.append((longitude, latitude))
                    if len(points) < 2:
                        continue
                    longitudes = [point[0] for point in points]
                    latitudes = [point[1] for point in points]
                    if (
                        max(longitudes) < west
                        or min(longitudes) > east
                        or max(latitudes) < south
                        or min(latitudes) > north
                    ):
                        continue
                    pixels = [
                        self._pixel(latitude, longitude)
                        for longitude, latitude in points
                    ]
                    paths.append(
                        "M"
                        + " L".join(f"{x:.1f},{y:.1f}" for x, y in pixels)
                        + " Z"
                    )
        return " ".join(paths)

    @staticmethod
    def _true_runs(mask: np.ndarray):
        padded = np.concatenate(
            (np.asarray([False]), np.asarray(mask, dtype=bool), np.asarray([False]))
        )
        changes = np.flatnonzero(padded[1:] != padded[:-1])
        return zip(changes[::2], changes[1::2])

    def _department_svg_path(self) -> str:
        if (
            self.france_latitudes is None
            or self.france_longitudes is None
            or self.france_departments is None
            or len(self.france_departments) != len(self.france_latitudes)
        ):
            return ""

        source = np.column_stack(
            (
                self.france_longitudes * self._longitude_scale,
                self.france_latitudes,
            )
        )
        target = np.column_stack(
            (
                self._target_longitudes.ravel() * self._longitude_scale,
                self._target_latitudes.ravel(),
            )
        )
        distances, indexes = cKDTree(source).query(target, k=1, workers=-1)
        codes = {
            code: index + 1
            for index, code in enumerate(sorted(set(self.france_departments)))
        }
        encoded = np.asarray(
            [codes.get(code, 0) for code in self.france_departments]
        )
        departments = encoded[indexes].reshape(self.height, self.width)
        france = distances.reshape(self.height, self.width) <= 0.18

        changes_between_columns = (
            france[:, 1:]
            & france[:, :-1]
            & (departments[:, 1:] != departments[:, :-1])
        )
        changes_between_rows = (
            france[1:, :]
            & france[:-1, :]
            & (departments[1:, :] != departments[:-1, :])
        )
        paths: list[str] = []
        for x in range(changes_between_columns.shape[1]):
            for start, end in self._true_runs(changes_between_columns[:, x]):
                coordinate = x + 0.5
                paths.append(
                    f"M{coordinate:.1f},{start:.1f} L{coordinate:.1f},{end:.1f}"
                )
        for y in range(changes_between_rows.shape[0]):
            for start, end in self._true_runs(changes_between_rows[y, :]):
                coordinate = y + 0.5
                paths.append(
                    f"M{start:.1f},{coordinate:.1f} L{end:.1f},{coordinate:.1f}"
                )
        return " ".join(paths)

    def _write_static_maps(self) -> None:
        base = Image.new("RGB", (self.width, self.height), "#a5a6b0")
        base.save(self.output_directory / "fond.webp", "WEBP", quality=86, method=4)

        national_path = ""
        coastline_path = ""
        if self.boundary_directory is not None:
            national_path = self._shapefile_svg_path(
                self.boundary_directory / "ne_50m_admin_0_boundary_lines_land.shp",
            )
            coastline_path = self._shapefile_svg_path(
                self.boundary_directory / "ne_50m_coastline.shp",
            )
        department_path = ""
        department_quality = "approximate"
        if self.department_boundary_path is not None:
            department_path = self._geojson_svg_path(
                self.department_boundary_path,
            )
            if department_path:
                department_quality = "precise"
        if not department_path:
            department_path = self._department_svg_path()
        hide_deep = "0" if department_quality == "precise" else "1"
        svg = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.width} '
            f'{self.height}" preserveAspectRatio="none" '
            'shape-rendering="geometricPrecision">\n'
            f'<path d="{department_path}" fill="none" stroke="#182732" '
            'stroke-opacity="0.76" stroke-width="0.95" '
            'stroke-linejoin="round" stroke-linecap="round" '
            'data-cepm-layer="departments" '
            f'data-cepm-quality="{department_quality}" '
            f'data-cepm-hide-deep="{hide_deep}" '
            'vector-effect="non-scaling-stroke"/>\n'
            f'<path d="{national_path}" fill="none" stroke="#14202a" '
            'stroke-opacity="0.9" stroke-width="1.55" '
            'stroke-linejoin="round" stroke-linecap="round" '
            'vector-effect="non-scaling-stroke"/>\n'
            f'<path d="{coastline_path}" fill="none" stroke="#07131c" '
            'stroke-width="2.15" stroke-linejoin="round" stroke-linecap="round" '
            'vector-effect="non-scaling-stroke"/>\n'
            '</svg>\n'
        )
        (self.output_directory / "frontieres.svg").write_text(
            svg,
            encoding="utf-8",
        )

    def render_step(
        self,
        *,
        lead_hour: int,
        valid_time: datetime,
        fields: dict[str, np.ndarray],
    ) -> None:
        files: dict[str, str] = {}
        probes: dict[str, str] = {}
        vectors: dict[str, str] = {}
        wind_u = fields.get("wind_u_kmh")
        wind_v = fields.get("wind_v_kmh")
        if wind_u is not None and wind_v is not None:
            destination = (
                self.output_directory / "vectors" / "vent" /
                f"{lead_hour:03d}.svg"
            )
            pressure = fields.get("pressure_hpa")
            self._write_wind_overlay(
                np.asarray(wind_u),
                np.asarray(wind_v),
                destination,
                np.asarray(pressure) if pressure is not None else None,
            )
            vector_path = f"maps/vectors/vent/{destination.name}"
            for layer_key, field_name in (
                ("vent", "wind_speed_kmh"),
                ("rafales", "wind_gust_kmh"),
            ):
                speed = fields.get(field_name)
                if speed is None or not np.any(np.isfinite(speed)):
                    continue
                vectors[layer_key] = (
                    vector_path
                )
        for spec in LAYER_SPECS:
            if spec.source_key is not None:
                continue
            values = fields.get(spec.field)
            if values is None or not np.any(np.isfinite(values)):
                continue
            if spec.field in STATIC_FIELDS and spec.key in self._static_assets:
                files[spec.key], probes[spec.key] = self._static_assets[spec.key]
                self.available_layers.add(spec.key)
                continue
            field = self._interpolate(values)
            destination_directory = self.output_directory / spec.key
            destination_directory.mkdir(parents=True, exist_ok=True)
            file_stem = "statique" if spec.field in STATIC_FIELDS else f"{lead_hour:03d}"
            destination = destination_directory / f"{file_stem}.webp"
            image = self._image_from_field(field, spec)
            image.save(destination, "WEBP", quality=86, method=5)
            files[spec.key] = f"maps/{spec.key}/{destination.name}"
            probe_destination = (
                self.output_directory
                / "values"
                / spec.key
                / f"{file_stem}.hkv.gz"
            )
            self._write_probe_field(field, spec, probe_destination)
            probes[spec.key] = (
                f"maps/values/{spec.key}/{probe_destination.name}"
            )
            if spec.field in STATIC_FIELDS:
                self._static_assets[spec.key] = (
                    files[spec.key], probes[spec.key]
                )
            self.available_layers.add(spec.key)

        for spec in LAYER_SPECS:
            if spec.source_key is None or spec.source_key not in files:
                continue
            files[spec.key] = files[spec.source_key]
            probes[spec.key] = probes[spec.source_key]
            if spec.source_key in vectors:
                vectors[spec.key] = vectors[spec.source_key]
            self.available_layers.add(spec.key)

        self.steps.append(
            {
                "lead_hour": int(lead_hour),
                "valid_time": valid_time.isoformat().replace("+00:00", "Z"),
                "files": files,
                "probes": probes,
                "vectors": vectors,
            }
        )

    def write_manifest(
        self,
        *,
        generated_at: str,
        run_time: str | None,
        places_path: str | None = None,
    ) -> dict[str, Any]:
        layers = {
            spec.key: {
                "label": spec.label,
                "unit": spec.unit,
                "group": spec.group,
                "decimals": spec.decimals,
                "transparent_below": spec.transparent_below,
                "discrete": spec.discrete,
                "opacity": spec.opacity,
                "source_key": spec.source_key,
                "range_mode": spec.range_mode,
                "stops": [
                    {"value": value, "color": colour}
                    for value, colour in spec.stops
                ],
            }
            for spec in LAYER_SPECS
            if spec.key in self.available_layers
        }
        manifest = {
            "schema_version": MAP_SCHEMA_VERSION,
            "status": "ok",
            "module_version": MODULE_VERSION,
            "generated_at": generated_at,
            "run_time": run_time,
            "projection": "EPSG:3857",
            "bounds": self.bounds,
            "width": self.width,
            "height": self.height,
            "background": "maps/fond.webp",
            "overlay": "maps/frontieres.svg",
            "layers": layers,
            "steps": self.steps,
        }
        if places_path:
            manifest["places"] = places_path
        destination = self.output_directory / "index.json"
        with destination.open("w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
        return manifest
