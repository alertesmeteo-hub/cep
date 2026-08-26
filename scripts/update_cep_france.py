#!/usr/bin/env python3
"""Construit les cartes et prévisions CEP/ECMWF IFS 0,25° pour la France.

La chaîne lit les données ouvertes GRIB2 officielles de l'ECMWF. Les fichiers
nationaux sont découpés par département pour WordPress et les cartes restent
calculées depuis la grille IFS, jamais depuis les seules communes.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import shutil
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import requests
from ecmwf.opendata import Client
from eccodes import (
    codes_get,
    codes_get_double_array,
    codes_get_double_elements,
    codes_grib_new_from_file,
    codes_release,
)
from scipy.ndimage import map_coordinates

from cep_maps import DEFAULT_BOUNDS, CEPMapRenderer


LOGGER = logging.getLogger("cep.france")
PIPELINE_VERSION = "1.5.0"
DATASET_PAGE = "https://www.ecmwf.int/en/forecasts/datasets/open-data"
DEFAULT_CURRENT_METADATA_URL = (
    "https://raw.githubusercontent.com/alertesmeteo-hub/"
    "cep/data/index.json"
)
USER_AGENT = "alertes-meteo.com/cep-ecmwf-france/1.5.0"

# Grille mondiale régulière IFS Open Data 0,25°.
CEP_NI = 1440
CEP_NJ = 721
CEP_LAT_FIRST = 90.0
CEP_LON_FIRST = -180.0
CEP_STEP = 0.25

MAP_WIDTH = 2200
MAP_HEIGHT = 1640

# Format compact partagé avec le JavaScript. Les diagnostics explicitement
# dérivés sont conservés car ils servent aux tableaux orages et neige.
VALUE_COLUMNS = (
    "temperature_c",
    "humidity_pct",
    "precipitation_mm",
    "cloud_cover_pct",
    "wind_speed_kmh",
    "wind_direction_deg",
    "wind_gust_kmh",
    "pressure_hpa",
    "visibility_km",
    "condition_code",
    "pressure_surface_hpa",
    "dewpoint_c",
    "precipitation_total_mm",
    "cloud_low_pct",
    "cloud_mid_pct",
    "cloud_high_pct",
    "cape_jkg",
    "reflectivity_dbz",
    "graupel_mm",
    "thunder_risk_code",
    "lcl_m",
    "lightning_score",
    "hail_risk_code",
    "convective_precipitation_mm",
    "storm_type_code",
    "snow_risk_code",
    "snowfall_mm",
    "snow_fresh_cm",
    "snow_depth_cm",
    "snow_water_equivalent_mm",
    "snow_stick_risk_code",
    "snow_phase_code",
    "snowfall_total_mm",
)

INTEGER_COLUMNS = {
    "humidity_pct",
    "cloud_cover_pct",
    "wind_speed_kmh",
    "wind_direction_deg",
    "wind_gust_kmh",
    "pressure_hpa",
    "condition_code",
    "pressure_surface_hpa",
    "cloud_low_pct",
    "cloud_mid_pct",
    "cloud_high_pct",
    "cape_jkg",
    "reflectivity_dbz",
    "thunder_risk_code",
    "lcl_m",
    "lightning_score",
    "hail_risk_code",
    "storm_type_code",
    "snow_risk_code",
    "snow_stick_risk_code",
    "snow_phase_code",
}

MAP_FIELDS = {
    "temperature_c",
    "wind_chill_c",
    "dewpoint_c",
    "humidex",
    "humidity_pct",
    "precipitation_mm",
    "precipitation_total_mm",
    "snow_mm",
    "snow_water_equivalent_mm",
    "snow_depth_cm",
    "graupel_mm",
    "wind_speed_kmh",
    "wind_gust_kmh",
    "wind_u_kmh",
    "wind_v_kmh",
    "pressure_hpa",
    "surface_pressure_hpa",
    "cloud_cover_pct",
    "cloud_low_pct",
    "cloud_mid_pct",
    "cloud_high_pct",
    "cape_jkg",
    "reflectivity_dbz",
    "altitude_m",
}

CONDITION_CODES = {
    0: "unknown",
    1: "clear",
    2: "partly_cloudy",
    3: "cloudy",
    4: "overcast",
    5: "rain",
    6: "heavy_rain",
    7: "snow",
    8: "fog",
    9: "windy",
}

@dataclass
class DepartmentData:
    code: str
    global_point_ids: np.ndarray
    points: list[list[Any]]
    communes: list[list[Any]]


@dataclass
class NationalCatalog:
    version: str
    model_indexes: list[int]
    point_latitudes: np.ndarray
    point_longitudes: np.ndarray
    point_departments: list[str]
    departments: dict[str, DepartmentData]
    commune_count: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--catalog",
        default="config/communes-france.json",
        help="Catalogue officiel des communes de France",
    )
    parser.add_argument(
        "--output-dir",
        default="build/cep-national",
        help="Dossier de publication à produire",
    )
    parser.add_argument(
        "--forecast-hours",
        type=int,
        default=240,
        help="Dernière échéance IFS, entre 3 et 240 heures",
    )
    parser.add_argument(
        "--current-metadata-url",
        default=DEFAULT_CURRENT_METADATA_URL,
        help="index.json actuellement publié, pour éviter un run identique",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force la reconstruction même si ce run est déjà publié",
    )
    return parser.parse_args()


def iso_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_get(gid: int, key: str, default: Any = None) -> Any:
    try:
        return codes_get(gid, key)
    except Exception:
        return default


def grib_datetime(gid: int, date_key: str, time_key: str) -> datetime | None:
    date_value = safe_get(gid, date_key)
    time_value = safe_get(gid, time_key)
    if date_value is None or time_value is None:
        return None
    try:
        return datetime.strptime(
            f"{int(date_value):08d}{int(time_value):04d}", "%Y%m%d%H%M"
        ).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def grid_index(latitude: float, longitude: float) -> tuple[int, float, float]:
    row = int(round((CEP_LAT_FIRST - latitude) / CEP_STEP))
    column = int(round(((longitude - CEP_LON_FIRST) % 360.0) / CEP_STEP)) % CEP_NI
    row = max(0, min(CEP_NJ - 1, row))
    column = max(0, min(CEP_NI - 1, column))
    index = row * CEP_NI + column
    model_latitude = CEP_LAT_FIRST - row * CEP_STEP
    model_longitude = CEP_LON_FIRST + column * CEP_STEP
    return index, model_latitude, model_longitude


def load_catalog(path: Path) -> NationalCatalog:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    raw_communes = payload.get("communes") or []
    if len(raw_communes) < 34_000:
        raise RuntimeError("Le catalogue communal France est incomplet")

    mapped: list[tuple[list[Any], int, float, float]] = []
    point_coordinates: dict[int, tuple[float, float]] = {}
    for commune in raw_communes:
        if not isinstance(commune, list) or len(commune) < 7:
            raise RuntimeError("Entrée communale invalide dans le catalogue")
        latitude = float(commune[5])
        longitude = float(commune[6])
        model_index, model_latitude, model_longitude = grid_index(
            latitude, longitude
        )
        mapped.append((commune, model_index, model_latitude, model_longitude))
        point_coordinates[model_index] = (model_latitude, model_longitude)

    model_indexes = sorted(point_coordinates)
    global_identifier = {
        model_index: position for position, model_index in enumerate(model_indexes)
    }
    point_latitudes = np.asarray(
        [point_coordinates[index][0] for index in model_indexes], dtype=np.float64
    )
    point_longitudes = np.asarray(
        [point_coordinates[index][1] for index in model_indexes], dtype=np.float64
    )

    department_votes: dict[int, Counter[str]] = defaultdict(Counter)
    by_department: dict[str, list[tuple[list[Any], int]]] = defaultdict(list)
    for commune, model_index, _latitude, _longitude in mapped:
        department = str(commune[2]).upper()
        global_id = global_identifier[model_index]
        department_votes[global_id][department] += 1
        by_department[department].append((commune, global_id))

    point_departments = [
        department_votes[position].most_common(1)[0][0]
        if department_votes[position]
        else ""
        for position in range(len(model_indexes))
    ]

    departments: dict[str, DepartmentData] = {}
    for department, entries in sorted(by_department.items()):
        global_ids = sorted({global_id for _commune, global_id in entries})
        local_identifier = {
            global_id: position for position, global_id in enumerate(global_ids)
        }
        compact_communes = [
            [
                str(commune[0]),
                str(commune[1]),
                list(commune[3]),
                int(commune[4]),
                float(commune[5]),
                float(commune[6]),
                local_identifier[global_id],
            ]
            for commune, global_id in entries
        ]
        compact_points = [
            [
                model_indexes[global_id],
                round(float(point_latitudes[global_id]), 5),
                round(float(point_longitudes[global_id]), 5),
            ]
            for global_id in global_ids
        ]
        departments[department] = DepartmentData(
            code=department,
            global_point_ids=np.asarray(global_ids, dtype=np.int64),
            points=compact_points,
            communes=compact_communes,
        )

    if len(departments) != 96:
        raise RuntimeError(
            f"Nombre inattendu de départements métropolitains : {len(departments)}"
        )
    LOGGER.info(
        "Catalogue CEP : %s communes, %s points IFS 0,25°, %s départements",
        len(raw_communes),
        len(model_indexes),
        len(departments),
    )
    return NationalCatalog(
        version=f"{payload.get('catalog_version', '1')}-cep001",
        model_indexes=model_indexes,
        point_latitudes=point_latitudes,
        point_longitudes=point_longitudes,
        point_departments=point_departments,
        departments=departments,
        commune_count=len(raw_communes),
    )


def already_published(url: str, run_time: datetime | None) -> bool:
    if not url or run_time is None:
        return False
    try:
        response = requests.get(
            url,
            timeout=(10, 30),
            headers={"User-Agent": USER_AGENT},
        )
        if response.status_code != 200:
            return False
        payload = response.json()
        model = payload.get("model") or {}
        return (
            payload.get("status") == "ok"
            and model.get("run_time") == iso_utc(run_time)
            and model.get("pipeline_version") == PIPELINE_VERSION
        )
    except (requests.RequestException, ValueError, TypeError):
        return False


def mask_missing(values: np.ndarray, missing_value: Any) -> np.ndarray:
    result = np.asarray(values, dtype=np.float64)
    invalid = ~np.isfinite(result) | (np.abs(result) > 1.0e20)
    try:
        missing = float(missing_value)
    except (TypeError, ValueError):
        missing = math.nan
    if math.isfinite(missing):
        invalid |= np.isclose(result, missing, rtol=0.0, atol=1.0e-9)
    result[invalid] = np.nan
    return result


def message_field(gid: int) -> str | None:
    short_name = str(safe_get(gid, "shortName", ""))
    if short_name == "z":
        # Une requête ECMWF sur `z` renvoie le relief de surface puis de
        # nombreux géopotentiels isobares. Sans ce filtre, le dernier message
        # (500 hPa) écrasait le relief et donnait environ 5 800 m à Perpignan.
        return (
            "surface_geopotential"
            if str(safe_get(gid, "typeOfLevel", "")) == "surface"
            else None
        )
    direct = {
        "2t": "temperature_k",
        "2d": "dewpoint_k",
        "10u": "wind_u_ms",
        "10v": "wind_v_ms",
        "10fg": "gust_speed_ms",
        "fg10": "gust_speed_ms",
        "mucape": "cape_jkg",
        "sp": "surface_pressure_pa",
        "msl": "mean_sea_pressure_pa",
        "tcc": "cloud_total_fraction",
        "lcc": "cloud_low_pct",
        "mcc": "cloud_mid_pct",
        "hcc": "cloud_high_pct",
        "tp": "precipitation_total_m",
        "sf": "snow_total_m",
        "sd": "snow_depth_m",
        "vis": "visibility_m",
    }
    if short_name in direct:
        return direct[short_name]
    if (
        int(safe_get(gid, "discipline", -1)) == 0
        and int(safe_get(gid, "parameterCategory", -1)) == 16
        and int(safe_get(gid, "parameterNumber", -1)) == 193
    ):
        return "reflectivity_dbz"
    return None


class NationalGrid:
    def __init__(self, catalog: NationalCatalog) -> None:
        self.catalog = catalog
        self.validated = False

    def validate(self, gid: int) -> None:
        if self.validated:
            return
        ni = int(safe_get(gid, "Ni", 0))
        nj = int(safe_get(gid, "Nj", 0))
        lat_first = float(safe_get(gid, "latitudeOfFirstGridPointInDegrees", 0))
        lon_first = float(safe_get(gid, "longitudeOfFirstGridPointInDegrees", 0))
        lon_first = (lon_first + 180.0) % 360.0 - 180.0
        if (
            ni != CEP_NI
            or nj != CEP_NJ
            or not math.isclose(lat_first, CEP_LAT_FIRST, abs_tol=1.0e-6)
            or not math.isclose(lon_first, CEP_LON_FIRST, abs_tol=1.0e-6)
        ):
            raise RuntimeError(
                "La grille reçue n'est pas IFS Open Data 0,25° "
                f"({ni} × {nj}, premier point {lat_first}/{lon_first})"
            )
        if max(self.catalog.model_indexes) >= ni * nj:
            raise RuntimeError("Un indice communal dépasse la grille CEP")
        self.validated = True

    def extract(self, gid: int) -> np.ndarray:
        self.validate(gid)
        values = codes_get_double_elements(gid, "values", self.catalog.model_indexes)
        return mask_missing(values, safe_get(gid, "missingValue"))


def mercator(latitude: np.ndarray) -> np.ndarray:
    radians = np.radians(np.clip(latitude, -85.0, 85.0))
    return np.log(np.tan(np.pi / 4.0 + radians / 2.0))


def inverse_mercator(value: np.ndarray) -> np.ndarray:
    return np.degrees(2.0 * np.arctan(np.exp(value)) - np.pi / 2.0)


class MapSampler:
    """Rééchantillonne la grille CEP par spline bicubique sur Web Mercator."""

    def __init__(self, width: int, height: int) -> None:
        self.width = int(width)
        self.height = int(height)
        bounds = DEFAULT_BOUNDS
        target_latitudes = inverse_mercator(
            np.linspace(
                mercator(np.asarray(float(bounds["north"]))),
                mercator(np.asarray(float(bounds["south"]))),
                self.height,
            )
        )
        target_longitudes = np.linspace(
            float(bounds["west"]), float(bounds["east"]), self.width
        )
        rows = (CEP_LAT_FIRST - target_latitudes) / CEP_STEP
        columns = (
            (target_longitudes - CEP_LON_FIRST) % 360.0
        ) / CEP_STEP
        self.row_grid = np.broadcast_to(rows[:, None], (self.height, self.width))
        self.column_grid = np.broadcast_to(
            columns[None, :], (self.height, self.width)
        )
        self.coverage = (
            (self.row_grid >= 0)
            & (self.row_grid <= CEP_NJ - 1)
        )

    def extract(self, gid: int, validator: NationalGrid) -> np.ndarray:
        validator.validate(gid)
        values = mask_missing(
            codes_get_double_array(gid, "values"),
            safe_get(gid, "missingValue"),
        ).reshape(CEP_NJ, CEP_NI)
        interpolation_order = 3 if np.all(np.isfinite(values)) else 1
        sampled = map_coordinates(
            values,
            [self.row_grid, self.column_grid],
            order=interpolation_order,
            # La longitude IFS est périodique (-180 à 179,75°) ; grid-wrap
            # conserve cette continuité au bord de la grille mondiale.
            mode="grid-wrap",
            cval=np.nan,
            prefilter=interpolation_order > 1,
        ).astype(np.float32, copy=False)
        sampled[~self.coverage] = np.nan
        return sampled


def parse_grib_files(
    paths: Iterable[Path],
    grid: NationalGrid,
    map_sampler: MapSampler,
    lead_hour: int,
) -> dict[str, Any]:
    point_values: dict[str, np.ndarray] = {}
    map_values: dict[str, np.ndarray] = {}
    run_time: datetime | None = None
    valid_time: datetime | None = None
    observed_lead: int | None = None

    for path in paths:
        with path.open("rb") as handle:
            while True:
                gid = codes_grib_new_from_file(handle)
                if gid is None:
                    break
                try:
                    field = message_field(gid)
                    if field is None:
                        continue
                    run_time = run_time or grib_datetime(gid, "dataDate", "dataTime")
                    valid_time = valid_time or grib_datetime(
                        gid, "validityDate", "validityTime"
                    )
                    end_step = safe_get(gid, "endStep")
                    if end_step is not None:
                        observed_lead = int(end_step)
                    point_field = grid.extract(gid)
                    map_field = map_sampler.extract(gid, grid)
                    if field in {"precipitation_total_m", "snow_total_m", "snow_depth_m"}:
                        point_field = point_field * 1000.0
                        map_field = map_field * 1000.0
                    elif field in {"cloud_total_fraction", "cloud_low_pct", "cloud_mid_pct", "cloud_high_pct"}:
                        point_field = point_field * 100.0
                        map_field = map_field * 100.0
                    elif field == "surface_geopotential":
                        point_field = point_field / 9.80665
                        map_field = map_field / 9.80665
                    point_values[field] = point_field
                    map_values[field] = map_field
                finally:
                    codes_release(gid)

    if "temperature_k" not in point_values:
        raise RuntimeError(f"Température à 2 m absente de l'échéance +{lead_hour:02d} h")
    if observed_lead is not None and observed_lead != lead_hour:
        raise RuntimeError(
            f"Échéance GRIB incohérente : +{observed_lead} h au lieu de +{lead_hour} h"
        )
    if valid_time is None and run_time is not None:
        valid_time = run_time + timedelta(hours=lead_hour)
    if valid_time is None:
        raise RuntimeError(f"Date de validité absente à +{lead_hour:02d} h")
    return {
        "lead_hour": lead_hour,
        "run_time": run_time,
        "valid_time": valid_time,
        "values": point_values,
        "map_values": map_values,
    }


def array_like(
    raw: dict[str, np.ndarray], name: str, shape: tuple[int, ...]
) -> np.ndarray:
    values = raw.get(name)
    if values is None:
        return np.full(shape, np.nan, dtype=np.float64)
    result = np.asarray(values, dtype=np.float64)
    if result.shape != shape:
        raise RuntimeError(f"Forme inattendue pour le champ {name} : {result.shape}")
    return result


def accumulation(
    raw: dict[str, np.ndarray],
    name: str,
    shape: tuple[int, ...],
    previous: np.ndarray | None,
    lead_hour: int,
) -> tuple[np.ndarray, np.ndarray]:
    total = array_like(raw, name, shape)
    if not np.any(np.isfinite(total)) and lead_hour == 0:
        total = np.zeros(shape, dtype=np.float64)
    total = np.where(np.isfinite(total), np.maximum(total, 0.0), np.nan)
    if previous is None:
        hourly = total.copy()
    else:
        hourly = np.maximum(total - previous, 0.0)
        hourly[~np.isfinite(total)] = np.nan
    return hourly, total.copy()


def rounded(values: np.ndarray, decimals: int) -> np.ndarray:
    return np.round(values, decimals)


def transform_step(
    raw: dict[str, np.ndarray],
    altitude: np.ndarray,
    previous: dict[str, np.ndarray],
    lead_hour: int,
) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
    shape = altitude.shape
    temperature = array_like(raw, "temperature_k", shape) - 273.15
    direct_dewpoint = array_like(raw, "dewpoint_k", shape) - 273.15
    temp_gamma = 17.625 * temperature / (243.04 + temperature)
    dew_gamma = 17.625 * direct_dewpoint / (243.04 + direct_dewpoint)
    humidity = np.clip(100.0 * np.exp(dew_gamma - temp_gamma), 0, 100)
    u_wind = array_like(raw, "wind_u_ms", shape)
    v_wind = array_like(raw, "wind_v_ms", shape)
    gust_scalar = array_like(raw, "gust_speed_ms", shape)
    surface_pressure = array_like(raw, "surface_pressure_pa", shape) / 100.0
    cape = np.maximum(array_like(raw, "cape_jkg", shape), 0.0)
    reflectivity = np.clip(array_like(raw, "reflectivity_dbz", shape), 0, 80)
    cloud_total = np.clip(array_like(raw, "cloud_total_fraction", shape), 0, 100)
    cloud_low = np.clip(array_like(raw, "cloud_low_pct", shape), 0, 100)
    cloud_mid = np.clip(array_like(raw, "cloud_mid_pct", shape), 0, 100)
    cloud_high = np.clip(array_like(raw, "cloud_high_pct", shape), 0, 100)

    precipitation, rain_total = accumulation(
        raw,
        "precipitation_total_m",
        shape,
        previous.get("rain_total"),
        lead_hour,
    )
    snow, snow_total = accumulation(
        raw, "snow_total_m", shape, previous.get("snow_total"), lead_hour
    )
    graupel, graupel_total = accumulation(
        raw, "graupel_total_mm", shape, previous.get("graupel_total"), lead_hour
    )

    wind_speed = np.hypot(u_wind, v_wind) * 3.6
    wind_direction = np.degrees(np.arctan2(-u_wind, -v_wind)) % 360.0
    gust_speed = gust_scalar * 3.6

    relative = np.clip(humidity / 100.0, 0.01, 1.0)
    gamma = np.log(relative) + 17.625 * temperature / (243.04 + temperature)
    dewpoint = np.where(np.isfinite(direct_dewpoint), direct_dewpoint,
                        243.04 * gamma / (17.625 - gamma))
    dewpoint[~np.isfinite(temperature) | ~np.isfinite(humidity)] = np.nan
    lcl = np.clip(125.0 * (temperature - dewpoint), 0, 5000)

    dewpoint_kelvin = np.clip(dewpoint + 273.15, 173.15, 333.15)
    vapour_pressure = 6.11 * np.exp(
        5417.7530 * (1.0 / 273.16 - 1.0 / dewpoint_kelvin)
    )
    humidex = temperature + 0.5555 * (vapour_pressure - 10.0)

    wind_chill = temperature.copy()
    chill_valid = (
        np.isfinite(temperature)
        & np.isfinite(wind_speed)
        & (temperature <= 10)
        & (wind_speed >= 4.8)
    )
    wind_factor = np.power(np.maximum(wind_speed, 0), 0.16)
    wind_chill[chill_valid] = (
        13.12
        + 0.6215 * temperature[chill_valid]
        - 11.37 * wind_factor[chill_valid]
        + 0.3965 * temperature[chill_valid] * wind_factor[chill_valid]
    )

    cloud = 100.0 * (
        1.0
        - (1.0 - cloud_low / 100.0)
        * (1.0 - cloud_mid / 100.0)
        * (1.0 - cloud_high / 100.0)
    )
    cloud[
        ~np.isfinite(cloud_low)
        | ~np.isfinite(cloud_mid)
        | ~np.isfinite(cloud_high)
    ] = np.nan
    cloud = np.where(np.isfinite(cloud_total), cloud_total, cloud)

    temperature_kelvin = np.maximum(temperature + 273.15, 180.0)
    pressure = surface_pressure * np.exp(
        9.80665 * np.maximum(altitude, -500.0)
        / (287.05 * (temperature_kelvin + 0.00325 * np.maximum(altitude, 0.0)))
    )
    pressure[~np.isfinite(surface_pressure) | ~np.isfinite(temperature)] = np.nan
    pressure = np.clip(pressure, 850, 1085)
    mean_sea_pressure = array_like(raw, "mean_sea_pressure_pa", shape) / 100.0
    pressure = np.where(np.isfinite(mean_sea_pressure), mean_sea_pressure, pressure)

    condition = np.zeros(shape, dtype=np.int16)
    condition[np.isfinite(cloud) & (cloud <= 20)] = 1
    condition[np.isfinite(cloud) & (cloud > 20) & (cloud <= 55)] = 2
    condition[np.isfinite(cloud) & (cloud > 55) & (cloud <= 85)] = 3
    condition[np.isfinite(cloud) & (cloud > 85)] = 4
    condition[np.isfinite(gust_speed) & (gust_speed >= 70)] = 9
    condition[np.isfinite(precipitation) & (precipitation >= 0.1)] = 5
    condition[np.isfinite(precipitation) & (precipitation >= 5)] = 6
    condition[np.isfinite(snow) & (snow >= 0.1)] = 7

    thunder = np.zeros(shape, dtype=np.int16)
    thunder[(cape >= 100) | (reflectivity >= 30)] = 1
    thunder[(cape >= 500) | (reflectivity >= 40)] = 2
    thunder[(cape >= 1200) | (reflectivity >= 50)] = 3
    thunder[(cape >= 2200) & (reflectivity >= 52)] = 4
    thunder[(reflectivity >= 58) | ((cape >= 1800) & (gust_speed >= 90))] = 4
    thunder[~np.isfinite(cape) & ~np.isfinite(reflectivity)] = 0

    lightning = np.clip(
        np.nan_to_num(cape, nan=0.0) / 30.0
        + np.maximum(np.nan_to_num(reflectivity, nan=0.0) - 25.0, 0) * 1.8,
        0,
        100,
    )
    hail = np.zeros(shape, dtype=np.int16)
    hail[(cape >= 500) & (reflectivity >= 42)] = 1
    hail[(cape >= 1200) & (reflectivity >= 50)] = 2
    hail[((cape >= 2200) & (reflectivity >= 55)) | (graupel >= 2)] = 3
    convective_fraction = np.clip(
        np.nan_to_num(cape, nan=0.0) / 1200.0, 0, 1
    ) * np.clip(
        (np.nan_to_num(reflectivity, nan=0.0) - 20.0) / 25.0, 0, 1
    )
    convective_precipitation = precipitation * convective_fraction
    storm_type = np.zeros(shape, dtype=np.int16)
    storm_type[thunder == 1] = 1
    storm_type[thunder == 2] = 2
    storm_type[(thunder >= 3) & (reflectivity >= 50)] = 3
    storm_type[(thunder >= 4) & (cape >= 2000)] = 4

    snow_ratio = np.select(
        [temperature <= -10, temperature <= -5, temperature <= 0, temperature <= 1.5],
        [15.0, 12.0, 10.0, 6.0],
        default=2.0,
    )
    snow_fresh = np.maximum(snow, 0.0) * snow_ratio / 10.0
    previous_fresh = previous.get("fresh_snow")
    if previous_fresh is None:
        snow_depth = snow_fresh.copy()
    else:
        snow_depth = np.nan_to_num(previous_fresh, nan=0.0) + np.nan_to_num(
            snow_fresh, nan=0.0
        )
        snow_depth[~np.isfinite(snow_fresh) & ~np.isfinite(previous_fresh)] = np.nan

    snow_phase = np.zeros(shape, dtype=np.int16)
    snow_phase[np.isfinite(precipitation) & (precipitation >= 0.1)] = 1
    snow_phase[(snow >= 0.03) & (temperature > 0.5)] = 2
    snow_phase[(snow >= 0.03) & (temperature <= 0.5)] = 3
    snow_stick = np.zeros(shape, dtype=np.int16)
    snow_stick[(snow_fresh >= 0.05) & (temperature <= 2.0)] = 1
    snow_stick[(snow_fresh >= 0.2) & (temperature <= 1.0)] = 2
    snow_stick[(snow_fresh >= 0.5) & (temperature <= 0.0)] = 3
    snow_risk = np.zeros(shape, dtype=np.int16)
    snow_risk[(snow >= 0.03) | ((precipitation >= 0.2) & (temperature <= 1.5))] = 1
    snow_risk[(snow_fresh >= 0.3) | ((precipitation >= 1) & (temperature <= 0.5))] = 2
    snow_risk[(snow_fresh >= 1.0) | ((precipitation >= 3) & (temperature <= 0))] = 3
    snow_risk[(snow_fresh >= 3.0) | ((precipitation >= 8) & (temperature <= -1))] = 4

    result = {
        "temperature_c": rounded(temperature, 1),
        "wind_chill_c": rounded(wind_chill, 1),
        "dewpoint_c": rounded(dewpoint, 1),
        "humidex": rounded(humidex, 1),
        "humidity_pct": rounded(humidity, 0),
        "precipitation_mm": rounded(precipitation, 1),
        "precipitation_total_mm": rounded(rain_total, 1),
        "cloud_cover_pct": rounded(cloud, 0),
        "cloud_low_pct": rounded(cloud_low, 0),
        "cloud_mid_pct": rounded(cloud_mid, 0),
        "cloud_high_pct": rounded(cloud_high, 0),
        "wind_speed_kmh": rounded(wind_speed, 0),
        "wind_direction_deg": rounded(wind_direction, 0),
        "wind_gust_kmh": rounded(gust_speed, 0),
        "wind_u_kmh": rounded(u_wind * 3.6, 1),
        "wind_v_kmh": rounded(v_wind * 3.6, 1),
        "pressure_hpa": rounded(pressure, 0),
        "pressure_surface_hpa": rounded(surface_pressure, 0),
        "surface_pressure_hpa": rounded(surface_pressure, 0),
        "visibility_km": rounded(array_like(raw, "visibility_m", shape) / 1000.0, 1),
        "condition_code": condition,
        "cape_jkg": rounded(cape, 0),
        "reflectivity_dbz": rounded(reflectivity, 0),
        "graupel_mm": rounded(graupel, 2),
        "thunder_risk_code": thunder,
        "lcl_m": rounded(lcl, 0),
        "lightning_score": rounded(lightning, 0),
        "hail_risk_code": hail,
        "convective_precipitation_mm": rounded(convective_precipitation, 1),
        "storm_type_code": storm_type,
        "snow_risk_code": snow_risk,
        "snowfall_mm": rounded(snow, 2),
        "snow_mm": rounded(snow, 2),
        "snow_fresh_cm": rounded(snow_fresh, 1),
        "snow_depth_cm": rounded(snow_depth, 1),
        "snow_water_equivalent_mm": rounded(snow_total, 1),
        "snow_stick_risk_code": snow_stick,
        "snow_phase_code": snow_phase,
        "snowfall_total_mm": rounded(snow_total, 1),
        "altitude_m": rounded(altitude, 0),
    }
    state = {
        "rain_total": rain_total,
        "snow_total": snow_total,
        "graupel_total": graupel_total,
        "fresh_snow": snow_depth,
    }
    return result, state


def json_number(value: Any, integer: bool = False) -> int | float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return int(round(number)) if integer else number


def compact_rows(
    transformed: dict[str, np.ndarray], point_ids: np.ndarray
) -> list[list[int | float | None]]:
    selected = {
        column: np.asarray(transformed[column])[point_ids] for column in VALUE_COLUMNS
    }
    return [
        [
            json_number(selected[column][position], column in INTEGER_COLUMNS)
            for column in VALUE_COLUMNS
        ]
        for position in range(len(point_ids))
    ]


def write_map_places(catalog: NationalCatalog, destination: Path) -> int:
    places = [
        [
            str(commune[1]),
            int(commune[3]),
            round(float(commune[4]), 5),
            round(float(commune[5]), 5),
            str(commune[0]),
            department.code,
        ]
        for department in catalog.departments.values()
        for commune in department.communes
        if int(commune[3]) > 0
    ]
    places.sort(key=lambda place: (-place[1], place[0]))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8") as handle:
        json.dump(
            {
                "schema_version": 2,
                "columns": [
                    "name",
                    "population",
                    "latitude",
                    "longitude",
                    "code_insee",
                    "department",
                ],
                "count": len(places),
                "places": places,
            },
            handle,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        handle.write("\n")
    return len(places)


def write_departments(
    result_directory: Path,
    forecast_directory: Path,
    catalog: NationalCatalog,
    generated_at: str,
) -> tuple[dict[str, Any], int]:
    destination_directory = result_directory / "departements"
    destination_directory.mkdir(parents=True, exist_ok=True)
    department_index: dict[str, Any] = {}
    total_size = 0
    for code, department in catalog.departments.items():
        destination = destination_directory / f"{code}.json"
        with destination.open("w", encoding="utf-8") as output:
            output.write("{")
            output.write('"schema_version":3,"status":"ok","generated_at":')
            json.dump(generated_at, output)
            output.write(',"department":')
            json.dump(code, output)
            output.write(',"columns":')
            json.dump(
                {
                    "points": ["model_index", "latitude", "longitude", "altitude_m"],
                    "communes": [
                        "code_insee",
                        "name",
                        "postal_codes",
                        "population",
                        "latitude",
                        "longitude",
                        "point_id",
                    ],
                    "values": list(VALUE_COLUMNS),
                },
                output,
                ensure_ascii=False,
                separators=(",", ":"),
            )
            output.write(',"points":')
            json.dump(department.points, output, ensure_ascii=False, separators=(",", ":"))
            output.write(',"communes":')
            json.dump(
                department.communes, output, ensure_ascii=False, separators=(",", ":")
            )
            output.write(',"forecast":[')
            first = True
            with (forecast_directory / f"{code}.ndjson").open(
                "r", encoding="utf-8"
            ) as lines:
                for line in lines:
                    if not line.strip():
                        continue
                    if not first:
                        output.write(",")
                    output.write(line.strip())
                    first = False
            output.write("]}\n")
        size = destination.stat().st_size
        total_size += size
        department_index[code] = {
            "file": f"departements/{code}.json",
            "communes": len(department.communes),
            "points": len(department.points),
            "size_bytes": size,
        }
    return department_index, total_size


IFS_PARAMETERS = [
    "2t", "2d", "10u", "10v", "10fg", "msl", "sp", "tcc",
    "tp", "sf", "sd", "mucape", "z",
]


def forecast_steps(forecast_hours: int) -> list[int]:
    """Échéances déterministes IFS : 3 h jusqu'à 144 h, puis 6 h."""
    first = list(range(0, min(forecast_hours, 144) + 1, 3))
    if forecast_hours <= 144:
        return first
    return first + list(range(150, forecast_hours + 1, 6))


def retrieve_ifs_step(
    client: Client,
    run_time: datetime,
    lead: int,
    destination: Path,
) -> None:
    client.retrieve(
        date=run_time.strftime("%Y%m%d"),
        time=run_time.hour,
        stream="oper",
        type="fc",
        step=lead,
        param=IFS_PARAMETERS,
        target=str(destination),
    )


def build_product(
    client: Client,
    catalog: NationalCatalog,
    forecast_hours: int,
    working_directory: Path,
    run_hint: datetime,
) -> Path:
    result_directory = working_directory / "result"
    forecast_directory = working_directory / "forecast-lines"
    downloads = working_directory / "downloads"
    result_directory.mkdir(parents=True)
    forecast_directory.mkdir(parents=True)
    downloads.mkdir(parents=True)

    line_handles = {
        code: (forecast_directory / f"{code}.ndjson").open("w", encoding="utf-8")
        for code in catalog.departments
    }
    grid = NationalGrid(catalog)
    map_sampler = MapSampler(MAP_WIDTH, MAP_HEIGHT)
    map_renderer = CEPMapRenderer(
        np.empty(0),
        np.empty(0),
        result_directory / "maps",
        width=MAP_WIDTH,
        height=MAP_HEIGHT,
        france_latitudes=catalog.point_latitudes,
        france_longitudes=catalog.point_longitudes,
        france_departments=catalog.point_departments,
        boundary_directory=(
            Path(__file__).resolve().parents[1] / "config" / "natural-earth"
        ),
        department_boundary_path=(
            Path(__file__).resolve().parents[1]
            / "config"
            / "france"
            / "departements.geojson"
        ),
        pregridded=True,
    )

    point_altitude: np.ndarray | None = None
    map_altitude: np.ndarray | None = None
    point_state: dict[str, np.ndarray] = {}
    map_state: dict[str, np.ndarray] = {}
    model_run = run_hint
    source_bytes = 0

    try:
        steps = forecast_steps(forecast_hours)
        for step_number, lead in enumerate(steps):
            current_paths: list[Path] = []
            try:
                destination = downloads / f"ifs-{lead:03d}h.grib2"
                LOGGER.info("Téléchargement IFS +%03d h", lead)
                retrieve_ifs_step(client, run_hint, lead, destination)
                source_bytes += destination.stat().st_size
                current_paths.append(destination)
                LOGGER.info(
                    "Décodage et cartes CEP %s/%s : +%03d h",
                    step_number + 1,
                    len(steps),
                    lead,
                )
                step = parse_grib_files(current_paths, grid, map_sampler, lead)
                model_run = model_run or step["run_time"]
                if lead == 0:
                    point_altitude = step["values"].get("surface_geopotential")
                    map_altitude = step["map_values"].get("surface_geopotential")
                    if point_altitude is None:
                        point_altitude = np.zeros(len(catalog.model_indexes))
                    if map_altitude is None:
                        map_altitude = np.zeros((MAP_HEIGHT, MAP_WIDTH))
                    for department in catalog.departments.values():
                        for position, global_id in enumerate(department.global_point_ids):
                            department.points[position].append(
                                json_number(point_altitude[int(global_id)], integer=True)
                            )
                assert point_altitude is not None and map_altitude is not None
                transformed, point_state = transform_step(
                    step["values"], point_altitude, point_state, lead
                )
                map_transformed, map_state = transform_step(
                    step["map_values"], map_altitude, map_state, lead
                )
                map_fields = {
                    key: values
                    for key, values in map_transformed.items()
                    if key in MAP_FIELDS
                }
                map_renderer.render_step(
                    lead_hour=lead,
                    valid_time=step["valid_time"],
                    fields=map_fields,
                )
                iso_time = iso_utc(step["valid_time"])
                for code, department in catalog.departments.items():
                    line = [
                        iso_time,
                        compact_rows(transformed, department.global_point_ids),
                    ]
                    json.dump(
                        line,
                        line_handles[code],
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    line_handles[code].write("\n")
            finally:
                for path in current_paths:
                    path.unlink(missing_ok=True)
    finally:
        for handle in line_handles.values():
            handle.close()

    generated_at = iso_utc(datetime.now(timezone.utc))
    assert generated_at is not None
    run_time = iso_utc(model_run)
    places_path = result_directory / "maps" / "communes.json"
    places_count = write_map_places(catalog, places_path)
    map_manifest = map_renderer.write_manifest(
        generated_at=generated_at,
        run_time=run_time,
        places_path="maps/communes.json",
    )
    department_index, total_size = write_departments(
        result_directory,
        forecast_directory,
        catalog,
        generated_at,
    )

    model = {
        "name": "CEP / ECMWF IFS déterministe",
        "provider": "ECMWF",
        "dataset": "ECMWF Open Data — IFS HRES",
        "domain": "Monde, extraction France et Europe de l'Ouest",
        "resolution_degrees": 0.25,
        "resolution_km": 28.0,
        "forecast_hours_requested": forecast_hours,
        "run_time": run_time,
        "pipeline_version": PIPELINE_VERSION,
        "catalog_version": catalog.version,
        "storm_diagnostics": True,
        "snow_diagnostics": True,
        "source_url": DATASET_PAGE,
        "source_size_bytes": source_bytes,
        "license": "Creative Commons Attribution 4.0 International (CC BY 4.0)",
    }
    index = {
        "schema_version": 3,
        "status": "ok",
        "generated_at": generated_at,
        "model": model,
        "coverage": {
            "label": "France métropolitaine et Corse",
            "communes": catalog.commune_count,
            "departments": len(catalog.departments),
        },
        "condition_codes": CONDITION_CODES,
        "diagnostics": {
            "direct": [
                "MUCAPE",
                "pluie cumulée",
                "neige cumulée",
                "pression de surface",
                "nébulosité totale",
                "pression au niveau de la mer",
            ],
            "derived": [
                "humidité relative à 2 m",
                "LCL",
                "risque orage",
                "phase et tenue de la neige",
            ],
        },
        "search": {
            "provider": "API Découpage administratif — République française",
            "endpoint": "https://geo.api.gouv.fr/communes",
        },
        "maps": {
            "status": "ok",
            "module_version": map_manifest["module_version"],
            "manifest": "maps/index.json",
            "layers": len(map_manifest["layers"]),
            "steps": len(map_manifest["steps"]),
            "places": places_count,
        },
        "departments": department_index,
        "total_department_bytes": total_size,
    }
    with (result_directory / "index.json").open("w", encoding="utf-8") as handle:
        json.dump(index, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
    LOGGER.info(
        "Produit CEP prêt : %.1f Mo de tableaux, %s couches, %s échéances",
        total_size / 1e6,
        len(map_manifest["layers"]),
        len(map_manifest["steps"]),
    )
    return result_directory


def safe_output_directory(path: Path) -> Path:
    resolved = path.resolve()
    forbidden = {Path("/").resolve(), Path.cwd().resolve(), Path.home().resolve()}
    if resolved in forbidden or len(resolved.parts) < 3:
        raise RuntimeError(f"Dossier de sortie dangereux : {resolved}")
    return resolved


def publish_result(source: Path, destination: Path) -> None:
    target = safe_output_directory(destination)
    temporary = target.with_name(target.name + ".new")
    if temporary.exists():
        shutil.rmtree(temporary)
    shutil.copytree(source, temporary)
    if target.exists():
        shutil.rmtree(target)
    temporary.replace(target)


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO),
        format="%(asctime)s | %(levelname)s | %(message)s",
    )
    if not 3 <= args.forecast_hours <= 240:
        raise ValueError("forecast-hours doit être compris entre 3 et 240")
    catalog = load_catalog(Path(args.catalog))
    client = Client(
        source="ecmwf",
        model="ifs",
        resol="0p25",
        infer_stream_keyword=False,
    )
    run_hint = client.latest(stream="oper", type="fc", step=args.forecast_hours, param="2t")
    if run_hint.tzinfo is None:
        run_hint = run_hint.replace(tzinfo=timezone.utc)
    LOGGER.info("Run CEP/IFS sélectionné : %s", iso_utc(run_hint))
    if not args.force and already_published(
        args.current_metadata_url, run_hint
    ):
        LOGGER.info("Ce run CEP est déjà publié ; aucune reconstruction nécessaire")
        return 0

    with tempfile.TemporaryDirectory(
        prefix="cep-france-build-", ignore_cleanup_errors=True
    ) as temporary:
        result = build_product(
            client,
            catalog,
            args.forecast_hours,
            Path(temporary),
            run_hint,
        )
        publish_result(result, Path(args.output_dir))
    LOGGER.info("Fichiers nationaux prêts dans %s", args.output_dir)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        LOGGER.exception("Échec de la mise à jour CEP France")
        raise SystemExit(1)
