"""Rendu de cartes synoptiques statiques (géopotentiel + isobares MSLP).

Module autonome, sans dépendance au reste du pipeline CEP au-delà des
tableaux numpy passés en paramètre. Réutilisable par d'autres modules
(aifs, arome-meteofrance, gfs, ...).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import cartopy.crs as ccrs
import cartopy.io.shapereader as shapereader
import matplotlib.pyplot as plt
import numpy as np
from cartopy.feature import ShapelyFeature
from matplotlib.colors import LinearSegmentedColormap
from scipy.ndimage import maximum_filter, minimum_filter

LOGGER = logging.getLogger("cep.synoptic")

DEFAULT_EXTENT = (-15.0, 20.0, 35.0, 60.0)  # (west, east, south, north)
EUROPE_EXTENT = (-45.0, 41.0, 28.0, 61.0)  # (west, east, south, north)

SYNOPTIC_REGIONS = {
    "france": DEFAULT_EXTENT,
    "europe": EUROPE_EXTENT,
}

# Style de rendu par région : "classic" (fond CEP France, isohypses noires +
# isobares blanches labellisées, légende verticale) ou "infoclimat" (fond
# large Europe façon infoclimat.fr : pas d'isohypses, isobares blanches avec
# centres H/L, légende horizontale, en-tête coin haut-gauche/haut-droit).
SYNOPTIC_STYLES = {
    "france": "classic",
    "europe": "infoclimat",
}

# Palette synoptique classique (bleu marine -> cyan -> vert -> jaune -> orange
# -> rouge -> bordeaux -> violet -> lavande), façon cartes 500 hPa historiques.
GEOPOTENTIAL_CMAP = LinearSegmentedColormap.from_list(
    "geopotential_classic",
    [
        "#0a0a3c", "#00008c", "#0000ff", "#0066ff", "#00ccff", "#00ffff",
        "#00ff99", "#00ff00", "#66ff00", "#ccff00", "#ffff00", "#ffcc00",
        "#ff9900", "#ff6600", "#ff0000", "#cc0000", "#800000", "#800080",
        "#b300b3", "#e066e0", "#f2ccf2",
    ],
)

# Palette façon infoclimat.fr : bleu -> cyan -> vert -> jaune -> orange ->
# rouge -> bordeaux -> violet, sans reprise en lavande claire au sommet.
GEOPOTENTIAL_CMAP_INFOCLIMAT = LinearSegmentedColormap.from_list(
    "geopotential_infoclimat",
    [
        "#00008c", "#0000ff", "#0066ff", "#00ccff", "#00ffcc", "#00cc66",
        "#00cc00", "#66ff00", "#ccff00", "#ffff00", "#ffcc00", "#ff9900",
        "#ff6600", "#ff0000", "#cc0000", "#990033", "#800066", "#660099",
        "#9933cc",
    ],
)

# Réutilise le cache Natural Earth déjà téléchargé pour cep_maps.py, afin
# d'éviter tout accès réseau à l'exécution (utile en CI GitHub Actions).
NATURAL_EARTH_DIRECTORY = Path(__file__).resolve().parents[1] / "config" / "natural-earth"


def _local_feature(shapefile_stem: str, **kwargs) -> ShapelyFeature | None:
    shapefile_path = NATURAL_EARTH_DIRECTORY / f"{shapefile_stem}.shp"
    if not shapefile_path.exists():
        LOGGER.warning("Shapefile Natural Earth introuvable : %s", shapefile_path)
        return None
    geometries = list(shapereader.Reader(str(shapefile_path)).geometries())
    return ShapelyFeature(geometries, ccrs.PlateCarree(), **kwargs)


@dataclass(frozen=True)
class SynopticGrid:
    """Grille lat/lon régulière portant les champs à tracer."""

    latitudes: np.ndarray  # 1D, décroissant ou croissant
    longitudes: np.ndarray  # 1D
    geopotential_height_m: np.ndarray  # 2D (nj, ni), mètres géopotentiels
    mean_sea_level_pressure_pa: np.ndarray  # 2D (nj, ni), Pa

    def __post_init__(self) -> None:
        expected = (len(self.latitudes), len(self.longitudes))
        if self.geopotential_height_m.shape != expected:
            raise ValueError(
                f"geopotential_height_m a la forme {self.geopotential_height_m.shape}, "
                f"attendu {expected}"
            )
        if self.mean_sea_level_pressure_pa.shape != expected:
            raise ValueError(
                f"mean_sea_level_pressure_pa a la forme "
                f"{self.mean_sea_level_pressure_pa.shape}, attendu {expected}"
            )


@dataclass(frozen=True)
class SynopticMeta:
    """Métadonnées d'en-tête pour une carte synoptique."""

    level_hpa: int
    run_time: datetime
    lead_hour: int
    valid_time: datetime
    variable_label: str = "Géopotentiel"


_FRENCH_MONTHS = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
]
_FRENCH_WEEKDAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]


def _format_french_date(moment: datetime, with_weekday: bool = False) -> str:
    text = f"{moment.day:02d} {_FRENCH_MONTHS[moment.month - 1]} {moment.year}"
    if with_weekday:
        text = f"{_FRENCH_WEEKDAYS[moment.weekday()]} {text}"
    return text


def _header_text(meta: SynopticMeta) -> str:
    run = meta.run_time.strftime("%d/%m/%Y %HZ")
    valid = meta.valid_time.strftime("%a %d/%m %HZ")
    return (
        f"{meta.variable_label} {meta.level_hpa} hPa & pression au niveau de la mer  |  "
        f"Run {run}  —  Échéance +{meta.lead_hour:03d} h  —  Validité {valid}"
    )


def _find_pressure_centers(
    mslp_hpa: np.ndarray,
    latitudes: np.ndarray,
    longitudes: np.ndarray,
    neighborhood: int = 45,
    min_separation_deg: float = 8.0,
    max_centers: int = 8,
) -> tuple[list[tuple[float, float, float]], list[tuple[float, float, float]]]:
    """Détecte les principaux centres H/L, sans doublons rapprochés."""

    def _extrema(mask_field: np.ndarray, reverse: bool) -> list[tuple[float, float, float]]:
        rows, columns = np.where(mask_field & np.isfinite(mslp_hpa))
        candidates = sorted(
            (
                (float(mslp_hpa[row, column]), float(longitudes[column]), float(latitudes[row]))
                for row, column in zip(rows, columns)
            ),
            reverse=reverse,
        )
        kept: list[tuple[float, float, float]] = []
        for value, lon, lat in candidates:
            if len(kept) >= max_centers:
                break
            if any(
                abs(lon - existing_lon) < min_separation_deg
                and abs(lat - existing_lat) < min_separation_deg
                for existing_lon, existing_lat, _ in kept
            ):
                continue
            kept.append((lon, lat, value))
        return kept

    highs_mask = mslp_hpa == maximum_filter(mslp_hpa, size=neighborhood, mode="nearest")
    lows_mask = mslp_hpa == minimum_filter(mslp_hpa, size=neighborhood, mode="nearest")
    return _extrema(highs_mask, reverse=True), _extrema(lows_mask, reverse=False)


def render_synoptic_map(
    grid: SynopticGrid,
    meta: SynopticMeta,
    destination: Path,
    extent: tuple[float, float, float, float] = DEFAULT_EXTENT,
    figsize: tuple[float, float] = (11.0, 9.0),
    dpi: int = 130,
    style: str = "classic",
) -> Path:
    """Trace géopotentiel (fond coloré) et isobares MSLP.

    `grid.geopotential_height_m` doit être en mètres géopotentiels (déjà
    divisé par g si issu du champ GRIB `z`). `grid.mean_sea_level_pressure_pa`
    en pascals. `extent` = (west, east, south, north) en degrés. `style` vaut
    "classic" (isohypses noires + isobares blanches labellisées, légende
    verticale) ou "infoclimat" (pas d'isohypses, centres H/L, légende
    horizontale, en-tête coin haut-gauche/haut-droit).
    """
    gh_dam = grid.geopotential_height_m / 10.0
    mslp_hpa = grid.mean_sea_level_pressure_pa / 100.0
    infoclimat = style == "infoclimat"

    west, east, south, north = extent
    data_crs = ccrs.PlateCarree()
    projection = ccrs.Mercator(
        central_longitude=(west + east) / 2.0,
        min_latitude=south,
        max_latitude=north,
    )

    x0, y0 = projection.transform_point(west, south, data_crs)
    x1, y1 = projection.transform_point(east, north, data_crs)
    projected_aspect = (y1 - y0) / (x1 - x0)  # hauteur/largeur en unités projetées

    if infoclimat:
        # Canevas final fixé en 16:9, carte plein cadre (en-tête et légende
        # affichés en surimpression, pas de bande blanche réservée).
        fig_width, fig_height = 12.8, 7.2
        map_aspect_wh = 1.0 / projected_aspect
        canvas_aspect_wh = fig_width / fig_height
        if map_aspect_wh > canvas_aspect_wh:
            axes_width, axes_height = 1.0, canvas_aspect_wh / map_aspect_wh
        else:
            axes_height, axes_width = 1.0, map_aspect_wh / canvas_aspect_wh
        axes_rect = (
            (1.0 - axes_width) / 2.0,
            (1.0 - axes_height) / 2.0,
            axes_width,
            axes_height,
        )
    else:
        axes_rect = (0.03, 0.06, 0.89, 0.86)
        fig_width = figsize[0]
        fig_height = fig_width * axes_rect[2] * projected_aspect / axes_rect[3]

    fig = plt.figure(figsize=(fig_width, fig_height), dpi=dpi)
    ax = fig.add_axes(axes_rect, projection=projection)
    ax.set_extent(extent, crs=data_crs)

    cmap = GEOPOTENTIAL_CMAP_INFOCLIMAT if infoclimat else GEOPOTENTIAL_CMAP
    if infoclimat:
        gh_levels = np.arange(496, 608 + 4, 4)
        fill = ax.contourf(
            grid.longitudes, grid.latitudes, gh_dam,
            levels=gh_levels, cmap=cmap, transform=data_crs, extend="both",
        )
    else:
        fill = ax.contourf(
            grid.longitudes, grid.latitudes, gh_dam,
            levels=30, cmap=cmap, transform=data_crs, extend="both",
        )
        gh_step = 4
        gh_low = int(np.floor(np.nanmin(gh_dam) / gh_step) * gh_step)
        gh_high = int(np.ceil(np.nanmax(gh_dam) / gh_step) * gh_step)
        gh_contours = ax.contour(
            grid.longitudes, grid.latitudes, gh_dam,
            levels=np.arange(gh_low, gh_high + gh_step, gh_step),
            colors="black", linewidths=0.8, transform=data_crs,
        )
        ax.clabel(gh_contours, inline=True, fontsize=7, fmt="%d")

    mslp_step = 5
    mslp_low = int(np.floor(np.nanmin(mslp_hpa) / mslp_step) * mslp_step)
    mslp_high = int(np.ceil(np.nanmax(mslp_hpa) / mslp_step) * mslp_step)
    mslp_levels = np.arange(mslp_low, mslp_high + mslp_step, mslp_step)
    mslp_contours = ax.contour(
        grid.longitudes, grid.latitudes, mslp_hpa,
        levels=mslp_levels, colors="white", linewidths=1.3, transform=data_crs,
    )
    ax.clabel(mslp_contours, inline=True, fontsize=7, fmt="%d", colors="white")

    if infoclimat:
        highs, lows = _find_pressure_centers(mslp_hpa, grid.latitudes, grid.longitudes)
        for lon, lat, value in highs:
            ax.annotate(
                f"H\n{value:.0f}", xy=(lon, lat), xycoords=data_crs._as_mpl_transform(ax),
                ha="center", va="center", fontsize=9, fontweight="bold", color="white",
            )
        for lon, lat, value in lows:
            ax.annotate(
                f"L\n{value:.0f}", xy=(lon, lat), xycoords=data_crs._as_mpl_transform(ax),
                ha="center", va="center", fontsize=9, fontweight="bold", color="white",
            )

    coastline = _local_feature(
        "ne_50m_coastline", facecolor="none", edgecolor="dimgray", linewidth=0.6
    )
    borders = _local_feature(
        "ne_50m_admin_0_boundary_lines_land",
        facecolor="none", edgecolor="dimgray", linewidth=0.4,
    )
    if coastline is not None:
        ax.add_feature(coastline)
    if borders is not None:
        ax.add_feature(borders)

    if infoclimat:
        # Carte plein cadre : en-tête et légende en surimpression (fond
        # blanc semi-transparent), aucune bande blanche réservée autour.
        run = f"{meta.run_time.strftime('%HZ')} {_format_french_date(meta.run_time)}"
        valid = f"{_format_french_date(meta.valid_time, with_weekday=True)} {meta.valid_time.strftime('%H')}H UTC"
        label_box = {"facecolor": "white", "alpha": 0.75, "edgecolor": "none", "pad": 4}
        ax.text(
            0.01, 0.99, f"Run ECMWF/CEP 0,25°\n{run}",
            transform=ax.transAxes, ha="left", va="top", fontsize=9, bbox=label_box,
        )
        ax.text(
            0.99, 0.99, f"Échéance : {valid}",
            transform=ax.transAxes, ha="right", va="top", fontsize=10,
            fontweight="bold", color="#cc0000", bbox=label_box,
        )
        ax.text(
            0.99, 0.935, f"+{meta.lead_hour}H",
            transform=ax.transAxes, ha="right", va="top", fontsize=13,
            fontweight="bold", color="#cc0000", bbox=label_box,
        )
        ax.text(
            0.5, 0.99,
            f"Géopotentiel à {meta.level_hpa}hPa\nPression au niveau de la mer",
            transform=ax.transAxes, ha="center", va="top", fontsize=9, bbox=label_box,
        )
        colorbar_axes = ax.inset_axes([0.34, 0.02, 0.44, 0.035])
        colorbar = fig.colorbar(
            fill, cax=colorbar_axes, orientation="horizontal",
            ticks=np.arange(496, 608 + 4, 16),
        )
        colorbar.ax.tick_params(labelsize=8, colors="black", labeltop=True, labelbottom=False)
        colorbar_axes.set_facecolor("white")
        ax.text(
            0.32, 0.0375, f"Géopotentiel {meta.level_hpa} hPa (gpdam)",
            transform=ax.transAxes, ha="right", va="center", fontsize=8, bbox=label_box,
        )
        ax.text(
            0.99, 0.02, "www.alertes-meteo.com",
            transform=ax.transAxes, ha="right", va="bottom", fontsize=8,
            color="black", bbox=label_box,
        )
    else:
        fig.colorbar(
            fill, ax=ax, orientation="vertical", fraction=0.025, pad=0.01,
            label=f"Géopotentiel {meta.level_hpa} hPa (dam)",
        )
        fig.suptitle(_header_text(meta), fontsize=10, y=0.985)
        fig.text(
            0.5, 0.015, "www.alertes-meteo.com",
            ha="center", va="bottom", fontsize=9, color="dimgray",
        )

    destination.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(destination, format="png")
    plt.close(fig)
    LOGGER.info("Carte synoptique écrite : %s", destination)
    return destination
