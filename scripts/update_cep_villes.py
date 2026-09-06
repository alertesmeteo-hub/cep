#!/usr/bin/env python3
"""Prévisions CEP/ECMWF IFS 0,25° pour les villes hors France (touristes).

Chaîne indépendante du pipeline national (update_cep_france.py) : mêmes
données ouvertes ECMWF, mais un point par ville (pas de carte, pas de
découpage départemental) publié sur la branche ``data-villes`` pour ne pas
interférer avec la publication France (branche ``data``, force-push).
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests
from ecmwf.opendata import Client
from eccodes import (
    codes_get,
    codes_get_double_elements,
    codes_grib_new_from_file,
    codes_release,
)

LOGGER = logging.getLogger("cep.villes")
PIPELINE_VERSION = "1.3.0"
DEFAULT_CURRENT_METADATA_URL = (
    "https://raw.githubusercontent.com/alertesmeteo-hub/cep/data-villes/index.json"
)
USER_AGENT = "alertes-meteo.com/cep-ecmwf-villes/1.0.0"

CEP_NI = 1440
CEP_NJ = 721
CEP_LAT_FIRST = 90.0
CEP_LON_FIRST = -180.0
CEP_STEP = 0.25

IFS_PARAMETERS = ["2t", "tcc", "tp", "10u", "10v", "sf"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", default="config/villes-internationales.json")
    parser.add_argument("--output-dir", default="build/villes")
    parser.add_argument("--forecast-hours", type=int, default=360)
    parser.add_argument("--current-metadata-url", default=DEFAULT_CURRENT_METADATA_URL)
    parser.add_argument("--force", action="store_true")
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


def load_catalog(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    villes = payload.get("villes") or []
    if not villes:
        raise RuntimeError("Catalogue villes internationales vide")
    return villes


def grid_indexes(villes: list[dict[str, Any]]) -> list[int]:
    indexes = []
    for ville in villes:
        row = int(round((CEP_LAT_FIRST - float(ville["lat"])) / CEP_STEP))
        column = int(round(((float(ville["lon"]) - CEP_LON_FIRST) % 360.0) / CEP_STEP)) % CEP_NI
        row = max(0, min(CEP_NJ - 1, row))
        column = max(0, min(CEP_NI - 1, column))
        indexes.append(row * CEP_NI + column)
    return indexes


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


def already_published(url: str, run_time: datetime | None) -> bool:
    if not url or run_time is None:
        return False
    try:
        response = requests.get(url, timeout=(10, 30), headers={"User-Agent": USER_AGENT})
        if response.status_code != 200:
            return False
        payload = response.json()
        model = payload.get("model") or {}
        return (
            payload.get("status") == "ok"
            and str(model.get("run_time") or "") >= iso_utc(run_time)
            and model.get("pipeline_version") == PIPELINE_VERSION
        )
    except (requests.RequestException, ValueError, TypeError):
        return False


def forecast_steps(forecast_hours: int) -> list[int]:
    first = list(range(0, min(forecast_hours, 144) + 1, 3))
    if forecast_hours <= 144:
        return first
    return first + list(range(150, forecast_hours + 1, 6))


def retrieve_ifs_step(client: Client, run_time: datetime, lead: int, destination: Path) -> None:
    client.retrieve(
        date=run_time.strftime("%Y%m%d"),
        time=run_time.hour,
        stream="oper",
        type="fc",
        step=lead,
        param=IFS_PARAMETERS,
        target=str(destination),
    )


def precip_probability_pct(precip_mm: float, cloud_pct: float) -> int:
    """Estimation faute de prévision d'ensemble : 0 sans pluie déterministe,
    sinon une fonction croissante de la lame d'eau et de la nébulosité."""
    if not math.isfinite(precip_mm) or precip_mm <= 0.0:
        return 0 if not math.isfinite(cloud_pct) or cloud_pct < 60 else 3
    return int(round(min(95.0, 30.0 + precip_mm * 15.0)))


def round_to(value: float | None, step: float) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(round(value / step) * step, 2)


def build_hourly(city_series: dict[str, Any], utc_offset_hours: float) -> list[dict[str, Any]]:
    """Série pas-à-pas sur toute la période demandée (résolution 3 h les 6
    premiers jours, puis 6 h) pour le sélecteur de jour et le tableau heure
    par heure côté widget — couvre les 15/16 jours, pas seulement les 6
    premiers."""
    hourly = []
    for j, lead in enumerate(city_series["steps"]):
        iso_time = city_series["valid_time"][j]
        if not iso_time:
            continue
        temp = city_series["temperature_c"][j]
        cloud = city_series["cloud_pct"][j] or 0.0
        precip = city_series["precip_mm"][j] or 0.0
        snow = city_series["snow_mm"][j] or 0.0
        hourly.append({
            "time_utc": iso_time,
            "local_hour": int(round((lead + utc_offset_hours) % 24)),
            "temperature_c": temp,
            "condition_code": condition_code(cloud, precip, snow),
            "precip_pct": precip_probability_pct(precip, cloud),
            "precip_mm": round_to(precip, 0.5),
            "wind_kmh": round_to(city_series["wind_kmh"][j], 5.0),
            "wind_dir_deg": city_series["wind_dir_deg"][j],
        })
    return hourly


def condition_code(cloud_pct: float, precip_mm: float, snow_mm: float) -> int:
    """0 clair · 1 peu nuageux · 2 nuageux · 3 pluie · 4 forte pluie · 5 neige."""
    if not math.isfinite(cloud_pct):
        return 0
    if math.isfinite(snow_mm) and snow_mm >= 0.1:
        return 5
    if math.isfinite(precip_mm) and precip_mm >= 5:
        return 4
    if math.isfinite(precip_mm) and precip_mm >= 0.2:
        return 3
    if cloud_pct > 85:
        return 2
    if cloud_pct > 20:
        return 1
    return 0


def build_product(
    client: Client,
    villes: list[dict[str, Any]],
    forecast_hours: int,
    working_directory: Path,
    run_hint: datetime,
) -> Path:
    result_directory = working_directory / "result"
    downloads = working_directory / "downloads"
    (result_directory / "villes").mkdir(parents=True)
    downloads.mkdir(parents=True)

    point_indexes = grid_indexes(villes)
    n_cities = len(villes)
    grid_valid = False
    lat_first = lon_first = 0.0
    step = CEP_STEP
    lat_step = -CEP_STEP
    ni = CEP_NI

    previous_tp = np.full(n_cities, np.nan)
    previous_sf = np.full(n_cities, np.nan)
    series: list[dict[str, Any]] = [
        {"steps": [], "temperature_c": [], "cloud_pct": [], "precip_mm": [],
         "snow_mm": [], "wind_kmh": [], "wind_dir_deg": [], "valid_time": []}
        for _ in villes
    ]

    model_run = run_hint
    steps = forecast_steps(forecast_hours)
    for step_number, lead in enumerate(steps):
        destination = downloads / f"ifs-{lead:03d}h.grib2"
        LOGGER.info("Téléchargement IFS villes +%03d h (%s/%s)", lead, step_number + 1, len(steps))
        retrieve_ifs_step(client, run_hint, lead, destination)

        raw: dict[str, np.ndarray] = {}
        valid_time = None
        with destination.open("rb") as handle:
            while True:
                gid = codes_grib_new_from_file(handle)
                if gid is None:
                    break
                try:
                    short_name = str(safe_get(gid, "shortName", "")).lower()
                    if not grid_valid:
                        ni = int(safe_get(gid, "Ni", CEP_NI))
                        nj = int(safe_get(gid, "Nj", CEP_NJ))
                        lat_first = float(safe_get(gid, "latitudeOfFirstGridPointInDegrees", CEP_LAT_FIRST))
                        lon_first = float(safe_get(gid, "longitudeOfFirstGridPointInDegrees", CEP_LON_FIRST))
                        lat_last = float(safe_get(gid, "latitudeOfLastGridPointInDegrees", -CEP_LAT_FIRST))
                        step_deg = abs(float(safe_get(gid, "iDirectionIncrementInDegrees", CEP_STEP)))
                        lat_step_deg = abs(float(safe_get(gid, "jDirectionIncrementInDegrees", CEP_STEP)))
                        if lat_last < lat_first:
                            lat_step_deg = -lat_step_deg
                        step, lat_step = step_deg, lat_step_deg
                        point_indexes[:] = []
                        for ville in villes:
                            row = int(round((lat_first - float(ville["lat"])) / abs(lat_step)))
                            column = int(round(((float(ville["lon"]) - lon_first) % 360.0) / step)) % ni
                            row = max(0, min(nj - 1, row))
                            column = max(0, min(ni - 1, column))
                            point_indexes.append(row * ni + column)
                        grid_valid = True
                    values = codes_get_double_elements(gid, "values", point_indexes)
                    values = mask_missing(values, safe_get(gid, "missingValue"))
                    if short_name in {"2t", "10u", "10v", "tcc", "tp", "sf"}:
                        raw[short_name] = values
                    if valid_time is None:
                        valid_time = grib_datetime(gid, "validityDate", "validityTime")
                    model_run = model_run or grib_datetime(gid, "dataDate", "dataTime")
                finally:
                    codes_release(gid)

        if valid_time is None and model_run is not None:
            valid_time = model_run + timedelta(hours=lead)

        temperature = raw.get("2t")
        temperature_c = (temperature - 273.15) if temperature is not None else np.full(n_cities, np.nan)
        cloud_pct = raw.get("tcc", np.full(n_cities, np.nan))
        cloud_pct = np.where(cloud_pct <= 1.0, cloud_pct * 100.0, cloud_pct)
        u_wind = raw.get("10u", np.full(n_cities, np.nan))
        v_wind = raw.get("10v", np.full(n_cities, np.nan))
        wind_kmh = np.hypot(u_wind, v_wind) * 3.6
        wind_dir_deg = np.degrees(np.arctan2(-u_wind, -v_wind)) % 360.0

        tp_total = raw.get("tp", np.full(n_cities, np.nan)) * 1000.0
        sf_total = raw.get("sf", np.full(n_cities, np.nan)) * 1000.0
        tp_increment = np.where(np.isnan(previous_tp), tp_total, np.maximum(tp_total - previous_tp, 0.0))
        sf_increment = np.where(np.isnan(previous_sf), sf_total, np.maximum(sf_total - previous_sf, 0.0))
        previous_tp = tp_total
        previous_sf = sf_total

        for i in range(n_cities):
            series[i]["steps"].append(lead)
            series[i]["valid_time"].append(iso_utc(valid_time))
            series[i]["temperature_c"].append(round(float(temperature_c[i]), 1) if math.isfinite(temperature_c[i]) else None)
            series[i]["cloud_pct"].append(round(float(cloud_pct[i]), 0) if math.isfinite(cloud_pct[i]) else None)
            series[i]["precip_mm"].append(round(float(tp_increment[i]), 1) if math.isfinite(tp_increment[i]) else None)
            series[i]["snow_mm"].append(round(float(sf_increment[i]), 1) if math.isfinite(sf_increment[i]) else None)
            series[i]["wind_kmh"].append(round(float(wind_kmh[i]), 0) if math.isfinite(wind_kmh[i]) else None)
            series[i]["wind_dir_deg"].append(round(float(wind_dir_deg[i]), 0) if math.isfinite(wind_dir_deg[i]) else None)

    index_entries = []
    for i, ville in enumerate(villes):
        daily: dict[str, dict[str, Any]] = {}
        for j, iso_time in enumerate(series[i]["valid_time"]):
            if not iso_time:
                continue
            date_key = iso_time[:10]
            entry = daily.setdefault(date_key, {"tmax": None, "tmin": None, "precip_mm": 0.0, "condition": 0})
            temp = series[i]["temperature_c"][j]
            if temp is not None:
                entry["tmax"] = temp if entry["tmax"] is None else max(entry["tmax"], temp)
                entry["tmin"] = temp if entry["tmin"] is None else min(entry["tmin"], temp)
            precip = series[i]["precip_mm"][j] or 0.0
            entry["precip_mm"] = round(entry["precip_mm"] + precip, 1)
            code = condition_code(
                series[i]["cloud_pct"][j] or 0.0,
                series[i]["precip_mm"][j] or 0.0,
                series[i]["snow_mm"][j] or 0.0,
            )
            entry["condition"] = max(entry["condition"], code)

        ordered_days = sorted(daily.items())[:16]
        current = {
            "temperature_c": series[i]["temperature_c"][0] if series[i]["temperature_c"] else None,
            "condition_code": condition_code(
                series[i]["cloud_pct"][0] or 0.0 if series[i]["cloud_pct"] else 0.0,
                series[i]["precip_mm"][0] or 0.0 if series[i]["precip_mm"] else 0.0,
                series[i]["snow_mm"][0] or 0.0 if series[i]["snow_mm"] else 0.0,
            ),
            "wind_kmh": round_to(series[i]["wind_kmh"][0], 5.0) if series[i]["wind_kmh"] else None,
        }
        utc_offset_hours = float(ville.get("utc_offset_hours", 1))
        hourly = build_hourly(series[i], utc_offset_hours)
        payload = {
            "nom": ville["nom"],
            "slug": ville["slug"],
            "pays": ville.get("pays"),
            "pays_slug": ville.get("pays_slug"),
            "continent": ville.get("continent", "europe"),
            "provider": "ECMWF IFS Open Data (0,25°)",
            "run_time": iso_utc(model_run),
            "pipeline_version": PIPELINE_VERSION,
            "utc_offset_hours": utc_offset_hours,
            "current": current,
            "hourly": hourly,
            "daily": [
                {"date": date, "tmax": v["tmax"], "tmin": v["tmin"], "precip_mm": round_to(v["precip_mm"], 0.5), "condition_code": v["condition"]}
                for date, v in ordered_days
            ],
        }
        file_path = result_directory / "villes" / f"{ville['slug']}.json"
        with file_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        index_entries.append({"slug": ville["slug"], "file": f"villes/{ville['slug']}.json"})

    index = {
        "status": "ok",
        "model": {
            "provider": "ECMWF IFS Open Data",
            "run_time": iso_utc(model_run),
            "pipeline_version": PIPELINE_VERSION,
            "forecast_hours_requested": forecast_hours,
        },
        "villes": index_entries,
    }
    with (result_directory / "index.json").open("w", encoding="utf-8") as handle:
        json.dump(index, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
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
    if not 3 <= args.forecast_hours <= 360:
        raise ValueError("forecast-hours doit être compris entre 3 et 360")
    villes = load_catalog(Path(args.catalog))
    client = Client(source="ecmwf", model="ifs", resol="0p25", infer_stream_keyword=False)
    run_hint = client.latest(stream="oper", type="fc", step=args.forecast_hours, param="2t")
    if run_hint.tzinfo is None:
        run_hint = run_hint.replace(tzinfo=timezone.utc)
    LOGGER.info("Run CEP/IFS villes sélectionné : %s", iso_utc(run_hint))
    if not args.force and already_published(args.current_metadata_url, run_hint):
        LOGGER.info("Ce run est déjà publié pour les villes ; aucune reconstruction nécessaire")
        return 0

    with tempfile.TemporaryDirectory(prefix="cep-villes-build-", ignore_cleanup_errors=True) as temporary:
        result = build_product(client, villes, args.forecast_hours, Path(temporary), run_hint)
        publish_result(result, Path(args.output_dir))
    LOGGER.info("Fichiers villes prêts dans %s", args.output_dir)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        LOGGER.exception("Échec de la mise à jour CEP villes")
        raise SystemExit(1)
