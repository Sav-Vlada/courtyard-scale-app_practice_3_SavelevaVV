#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Подготовка данных для приложения «Дворовый масштаб».

Что делает скрипт
-----------------
1. Скачивает контуры зданий Васильевского острова из OpenStreetMap (Overpass API)
   и кэширует ответы в data/raw/ (повторный запуск не требует сети).
2. Считает height = height (если тег есть) или building:levels × 3.3.
   Пропуски building:levels импутируются медианой по ячейке 500 × 500 м,
   при малом объёме данных — медианой по району (острову).
3. Обогащает год постройки: OSM (building:year / start_date), затем
   пространственное сопоставление с выгрузкой kontikimaps.ru (ODbL).
4. Для каждого здания находит до 5 ближайших соседей в радиусе 100 м
   (кратчайшее расстояние между полигонами, а не центроидами), считает
   level_difference, nearest_distance и ratio = height / nearest_distance.
5. Классифицирует здание по стилю согласно периодизации из app/config.js.
6. Создаёт сетку опорных точек 50 × 50 м и заранее считает для каждой
   метрики двора в радиусе 100 м, включая сценарные проверки.
7. Пишет data/buildings.geojson, data/reference_points.geojson,
   data/metadata.json и data/control_buildings.json.

Пороги, список стилей, буфер и bbox берутся из app/config.js — единого
источника настроек для Python и JavaScript.

Источники и лицензии
--------------------
OSM: © участники OpenStreetMap, ODbL 1.0, https://www.openstreetmap.org/copyright
Годы постройки kontikimaps.ru: © how-old-is-this.house / Кон-Тики, ODbL 1.0,
https://kontikimaps.ru/how-old/cities250/datasets
Перед использованием данных kontikimaps сверяйтесь с актуальными условиями
на сайте. Лицензия ODbL вирусная: производные базы данных распространяются
на тех же условиях с указанием авторства.

Запуск
------
    python scripts/prepare_data.py
    python scripts/prepare_data.py --kontiki-gpkg data/raw/HOITH_database_231118.gpkg
    python scripts/prepare_data.py --refresh-osm --chunks 5
    python scripts/prepare_data.py --bbox 30.17,59.91,30.32,59.96 --no-island-filter

Требования: Python 3.10+, requests, shapely, geojson (см. requirements.txt).
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import sqlite3
import statistics
import sys
import time
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import requests
from shapely import wkb
from shapely.geometry import (
    GeometryCollection,
    MultiPolygon,
    Point,
    Polygon,
    box,
    mapping,
    shape,
)
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree
from shapely.validation import make_valid

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "app" / "config.js"
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
DEFAULT_ISLAND = DATA_DIR / "island.geojson"

EARTH_RADIUS = 6_378_137.0
OSM_USER_AGENT = (
    "courtyard-scale-app/1.0 (educational research; "
    "OSM data ODbL; https://www.openstreetmap.org/copyright)"
)
OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
PLAUSIBLE_YEAR_MIN = 1703
PLAUSIBLE_YEAR_MAX = 2026


# ---------------------------------------------------------------------------
# Конфигурация
# ---------------------------------------------------------------------------


def load_config(path: Path = CONFIG_PATH) -> dict[str, Any]:
    """Читает JSON-объект из app/config.js.

    config.js специально оформлен как валидный JSON внутри присваивания,
    поэтому Python и браузер используют один и тот же набор порогов.
    """
    text = path.read_text(encoding="utf-8")
    match = re.search(r"window\.COURTYARD_CONFIG\s*=\s*(\{.*\})\s*;", text, re.S)
    if not match:
        raise RuntimeError(
            f"Не удалось прочитать объект конфигурации из {path}. "
            "Убедитесь, что файл содержит window.COURTYARD_CONFIG = { ... };"
        )
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"app/config.js должен содержать валидный JSON: {exc}") from exc


# ---------------------------------------------------------------------------
# Геометрия и метрики
# ---------------------------------------------------------------------------


class LocalProjection:
    """Равнопромежуточная локальная проекция в метры.

    Для территории ~12 км ошибка относительно точных геодезических расстояний
    пренебрежимо мала (<0.1%). Та же формула используется в app/js/geo.js,
    поэтому клик в браузере и предрасчёт в Python дают одинаковые результаты.
    """

    def __init__(self, origin_lon: float, origin_lat: float):
        self.lon0 = float(origin_lon)
        self.lat0 = float(origin_lat)
        self.cos_lat0 = math.cos(math.radians(self.lat0))

    def xy(self, lon: float, lat: float) -> tuple[float, float]:
        x = math.radians(lon - self.lon0) * EARTH_RADIUS * self.cos_lat0
        y = math.radians(lat - self.lat0) * EARTH_RADIUS
        return x, y

    def lonlat(self, x: float, y: float) -> tuple[float, float]:
        lon = self.lon0 + math.degrees(x / (EARTH_RADIUS * self.cos_lat0))
        lat = self.lat0 + math.degrees(y / EARTH_RADIUS)
        return lon, lat

    def project(self, geom):
        return transform(lambda x, y, z=None: self.xy(x, y), geom)

    def unproject(self, geom):
        return transform(lambda x, y, z=None: self.lonlat(x, y), geom)


def clean_geometry(geom):
    """Возвращает валидный Polygon/MultiPolygon или None."""
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = make_valid(geom)
    if geom.geom_type == "Polygon":
        return geom if geom.area > 0 else None
    if geom.geom_type == "MultiPolygon":
        parts = [p for p in geom.geoms if p.area > 0]
        if not parts:
            return None
        return parts[0] if len(parts) == 1 else MultiPolygon(parts)
    if geom.geom_type == "GeometryCollection":
        parts = [clean_geometry(g) for g in geom.geoms]
        parts = [p for p in parts if p is not None]
        if not parts:
            return None
        merged = unary_union(parts)
        return clean_geometry(merged)
    return None


def round_coords(obj, ndigits: int = 7):
    if isinstance(obj, float):
        return round(obj, ndigits)
    if isinstance(obj, (list, tuple)):
        return [round_coords(v, ndigits) for v in obj]
    if isinstance(obj, dict):
        return {k: round_coords(v, ndigits) for k, v in obj.items()}
    return obj


def parse_numeric_list(value: Any) -> list[float]:
    """Извлекает числа из тегов вида «5;6;5», «12,5 м», «4.5»."""
    if value is None:
        return []
    text = str(value).replace(",", ".")
    numbers = re.findall(r"\d+(?:\.\d+)?", text)
    result = []
    for n in numbers:
        try:
            v = float(n)
        except ValueError:
            continue
        if v > 0:
            result.append(v)
    return result


def parse_levels(tags: dict[str, Any]) -> float | None:
    for key in ("building:levels", "levels"):
        values = parse_numeric_list(tags.get(key))
        values = [v for v in values if 0 < v <= 120]
        if values:
            return float(statistics.median(values))
    return None


def parse_height(tags: dict[str, Any]) -> float | None:
    for key in ("height", "building:height"):
        values = parse_numeric_list(tags.get(key))
        values = [v for v in values if 1.0 <= v <= 400.0]
        if values:
            return float(statistics.median(values))
    return None


def parse_year(tags: dict[str, Any]) -> tuple[int | None, str | None]:
    """Возвращает (год, источник) из OSM-тегов."""
    keys = (
        "building:year",
        "start_date",
        "construction_date",
        "year_built",
        "built",
        "building:year_built",
    )
    for key in keys:
        raw = tags.get(key)
        if raw is None:
            continue
        years = [int(y) for y in re.findall(r"(?<!\d)(1[6-9]\d{2}|20\d{2})(?!\d)", str(raw))]
        years = [y for y in years if PLAUSIBLE_YEAR_MIN <= y <= PLAUSIBLE_YEAR_MAX]
        if years:
            return years[0], f"osm:{key}"
    return None, None


def style_for_year(year: int | None, periods: list[dict[str, Any]], unknown: str) -> str:
    """Классификация по году.

    Диапазоны в config.js заданы включительно и местами пересекаются
    (1905, 1935). При пересечении выбирается период с более поздним началом:
    1905 → неоклассицизм, 1935 → «От неоклассики к функциональной
    архитектуре». Это делает правило однозначным.
    """
    if year is None:
        return unknown
    candidates = [p for p in periods if int(p["from"]) <= year <= int(p["to"])]
    if not candidates:
        return unknown
    return max(candidates, key=lambda p: int(p["from"]))["name"]


def gap_metrics(selected: list[int], geoms: list[Any], ignore_meters: float) -> tuple[float | None, float | None, list[float]]:
    """Минимальный и средний зазор между зданиями в наборе.

    Зазор считается между контурами полигонов. Пары, соприкасающиеся или
    разделённые менее чем ignore_meters (стены по меже, погрешность
    оцифровки), не считаются разрывом застройки. Для каждого здания берётся
    ближайший положительный зазор, min_gap = минимум по зданиям,
    avg_gap = среднее по зданиям.
    """
    per_building: list[float] = []
    for i in selected:
        gi = geoms[i]
        best: float | None = None
        bi = gi.bounds
        for j in selected:
            if j == i:
                continue
            bj = geoms[j].bounds
            # Быстрая проверка: даже прямоугольники дальше текущего минимума
            if best is not None:
                dx = max(0.0, max(bi[0] - bj[2], bj[0] - bi[2]))
                dy = max(0.0, max(bi[1] - bj[3], bj[1] - bi[3]))
                if math.hypot(dx, dy) >= best:
                    continue
            d = gi.distance(geoms[j])
            if d > ignore_meters and (best is None or d < best):
                best = d
        if best is not None:
            per_building.append(best)
    if not per_building:
        return None, None, []
    return min(per_building), statistics.fmean(per_building), per_building


def class_for_ratio(ratio: float | None, cfg: dict[str, Any]) -> dict[str, Any]:
    classes = {c["id"]: c for c in cfg["classes"]}
    if ratio is None or not math.isfinite(ratio):
        return classes["no-data"]
    th = cfg["thresholds"]
    if ratio < float(th["ratioOpenMax"]):
        return classes["open"]
    if ratio < float(th["ratioClosedMin"]):
        return classes["moderate"]
    return classes["closed"]


def compute_point_metrics(
    point_xy: Point,
    selected: list[int],
    buildings: list[dict[str, Any]],
    proj_geoms: list[Any],
    cfg: dict[str, Any],
) -> dict[str, Any]:
    """Метрики двора в радиусе bufferMeters от точки."""
    th = cfg["thresholds"]
    unknown_style = cfg["unknownStyle"]["name"]
    ignore = float(cfg.get("minGapIgnoreMeters", 1.0))

    heights = [buildings[i]["height"] for i in selected]
    levels = [buildings[i]["levels"] for i in selected]
    styles = [buildings[i]["style"] for i in selected]
    known_styles = [s for s in styles if s != unknown_style]

    min_gap, avg_gap, gaps = gap_metrics(selected, proj_geoms, ignore)

    avg_height = round(statistics.fmean(heights), 2) if heights else None
    max_height = round(max(heights), 2) if heights else None
    min_height = round(min(heights), 2) if heights else None
    level_range = int(round(max(levels) - min(levels))) if levels else None

    ratio = None
    if avg_height is not None and min_gap is not None and min_gap > 0:
        ratio = avg_height / min_gap

    style_counts = Counter(styles)
    known_counts = Counter(known_styles)
    total = len(styles)
    unknown_share = round(style_counts.get(unknown_style, 0) / total, 4) if total else None
    style_diversity = len(known_counts)

    dominant_style = None
    dominant_share = None
    if known_counts:
        ranked = sorted(known_counts.items(), key=lambda kv: (-kv[1], kv[0]))
        top_name, top_count = ranked[0]
        second_count = ranked[1][1] if len(ranked) > 1 else 0
        share = top_count / total if total else 0.0
        dominant_share = round(share, 4)
        # При точном равенстве двух стилей (50/50) доминирующего нет.
        if share >= float(th["dominantShareMin"]) and top_count > second_count:
            dominant_style = top_name

    if total == 0:
        diversity_status = "no-data"
    elif unknown_share is not None and unknown_share > float(th["unknownStyleWarningShare"]):
        diversity_status = "insufficient"
    elif dominant_style is None:
        diversity_status = "diverse"
    else:
        diversity_status = "homogeneous"

    threat_periods = []
    for period_name in th.get("specialThreatPeriods", []):
        count = style_counts.get(period_name, 0)
        if total and count / total >= float(th["dominantShareMin"]):
            threat_periods.append(period_name)

    class_info = class_for_ratio(ratio, cfg)
    contrast = bool(level_range is not None and level_range >= int(th["levelContrastMin"]))

    floor_height = float(cfg["scenario"]["floorHeightMeters"])
    plus_floors = int(th.get("plusFloorsSearch", 5))
    scenario_plus5_ratio = None
    scenario_plus5_class = None
    if avg_height is not None and min_gap is not None and min_gap > 0:
        scenario_plus5_ratio = (avg_height + plus_floors * floor_height) / min_gap
        scenario_plus5_class = class_for_ratio(scenario_plus5_ratio, cfg)["id"]
    scenario_expand_ratio = None
    scenario_expand_class = None
    if avg_height is not None and min_gap is not None:
        gap_plus = min_gap + 10.0
        if gap_plus > 0:
            scenario_expand_ratio = avg_height / gap_plus
            scenario_expand_class = class_for_ratio(scenario_expand_ratio, cfg)["id"]

    return {
        "building_count": total,
        "avg_height": avg_height,
        "max_height": max_height,
        "min_height": min_height,
        "level_range": level_range,
        "min_gap": round(min_gap, 2) if min_gap is not None else None,
        "avg_gap": round(avg_gap, 2) if avg_gap is not None else None,
        "ratio": round(ratio, 4) if ratio is not None else None,
        "style_diversity": style_diversity,
        "dominant_style": dominant_style,
        "dominant_share": dominant_share,
        "unknown_style_share": unknown_share,
        "diversity_status": diversity_status,
        "threat_periods": threat_periods,
        "class_id": class_info["id"],
        "class_label": class_info["label"],
        "contrast": contrast,
        "scenario_plus5_ratio": round(scenario_plus5_ratio, 4) if scenario_plus5_ratio is not None else None,
        "scenario_plus5_class_id": scenario_plus5_class,
        "plus5_changes_class": bool(
            scenario_plus5_class is not None and scenario_plus5_class != class_info["id"]
        ),
        "scenario_expand10_ratio": round(scenario_expand_ratio, 4) if scenario_expand_ratio is not None else None,
        "scenario_expand10_class_id": scenario_expand_class,
    }


# ---------------------------------------------------------------------------
# Загрузка данных
# ---------------------------------------------------------------------------


def http_get_json(url: str, params: dict[str, Any] | None = None, timeout: int = 120) -> Any:
    headers = {"User-Agent": OSM_USER_AGENT, "Accept": "application/json"}
    response = requests.get(url, params=params, headers=headers, timeout=timeout)
    response.raise_for_status()
    return response.json()


def fetch_island_boundary(cfg: dict[str, Any], out_path: Path, refresh: bool = False) -> Any:
    if out_path.exists() and not refresh:
        data = json.loads(out_path.read_text(encoding="utf-8"))
        feat = data["features"][0]
        geom = shape(feat["geometry"])
        print(f"Граница острова: {out_path} (кэш)")
        return geom

    print("Запрашиваю границу острова через Nominatim…")
    query = f"{cfg['studyArea']['name']}"
    data = http_get_json(
        "https://nominatim.openstreetmap.org/search",
        {
            "q": query,
            "format": "jsonv2",
            "polygon_geojson": 1,
            "limit": 5,
            "accept-language": "ru",
        },
        timeout=90,
    )
    if not data:
        raise RuntimeError("Nominatim не вернул границу острова")
    target_id = int(cfg["studyArea"].get("islandRelationId", 0) or 0)
    chosen = next((d for d in data if int(d.get("osm_id", 0)) == target_id), data[0])
    geom = shape(chosen["geojson"])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "name": "island_boundary",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {
                            "name": chosen.get("display_name"),
                            "osm_type": chosen.get("osm_type"),
                            "osm_id": chosen.get("osm_id"),
                            "source": "OpenStreetMap via Nominatim",
                            "license": "ODbL 1.0",
                            "fetched_at": datetime.now(timezone.utc).date().isoformat(),
                        },
                        "geometry": round_coords(mapping(geom)),
                    }
                ],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"Сохранено: {out_path}")
    return geom


def split_bbox(bbox: list[float], chunks: int) -> list[tuple[float, float, float, float]]:
    west, south, east, north = bbox
    chunks = max(1, chunks)
    dx = (east - west) / chunks
    dy = (north - south) / chunks
    result = []
    for ix in range(chunks):
        for iy in range(chunks):
            result.append(
                (
                    west + ix * dx,
                    south + iy * dy,
                    west + (ix + 1) * dx,
                    south + (iy + 1) * dy,
                )
            )
    return result


def overpass_query(bbox: tuple[float, float, float, float], timeout: int = 180) -> dict[str, Any]:
    west, south, east, north = bbox
    query = f"""[out:json][timeout:{timeout}][maxsize:536870912];
way["building"]({south:.7f},{west:.7f},{north:.7f},{east:.7f});
out tags geom;"""
    last_error: Exception | None = None
    for attempt in range(3):
        endpoint = OVERPASS_ENDPOINTS[attempt % len(OVERPASS_ENDPOINTS)]
        try:
            response = requests.post(
                endpoint,
                data={"data": query},
                headers={"User-Agent": OSM_USER_AGENT, "Accept": "application/json"},
                timeout=timeout + 60,
            )
            if response.status_code == 200:
                try:
                    return response.json()
                except ValueError:
                    pass
            else:
                last_error = RuntimeError(f"HTTP {response.status_code}: {response.text[:160]}")
        except Exception as exc:  # network problems, timeouts, resets
            last_error = exc
        wait = min(20, 3 * (2 ** attempt)) + random.uniform(0, 2)
        print(f"    Overpass попытка {attempt + 1}/3 не удалась ({type(last_error).__name__}); ждём {wait:.0f} с")
        time.sleep(wait)
    raise RuntimeError(f"Не удалось получить здания через Overpass: {last_error}")


def osm_api_query(bbox: tuple[float, float, float, float], timeout: int = 180) -> dict[str, Any]:
    """Резервный источник: OSM API 0.6 map.

    Возвращает ответ в формате, совместимом с Overpass (`elements` + `geometry`),
    чтобы кэш и последующая обработка не зависели от источника.
    Область острова укладывается в лимит OSM API (0.25 кв. градуса).
    """
    west, south, east, north = bbox
    url = "https://api.openstreetmap.org/api/0.6/map"
    params = {"bbox": f"{west:.7f},{south:.7f},{east:.7f},{north:.7f}"}
    response = requests.get(
        url,
        params=params,
        headers={"User-Agent": OSM_USER_AGENT},
        timeout=timeout + 60,
    )
    response.raise_for_status()

    root = ET.fromstring(response.content)
    nodes: dict[str, tuple[float, float]] = {}
    for node in root.findall("node"):
        node_id = node.get("id")
        if node_id is None:
            continue
        nodes[node_id] = (float(node.get("lon")), float(node.get("lat")))

    elements: list[dict[str, Any]] = []
    latest_timestamp: str | None = None
    for way in root.findall("way"):
        tags = {tag.get("k"): tag.get("v") for tag in way.findall("tag")}
        if "building" not in tags:
            continue
        coords = [
            nodes[ref.get("ref")]
            for ref in way.findall("nd")
            if ref.get("ref") in nodes
        ]
        if len(coords) < 4:
            continue
        elements.append(
            {
                "type": "way",
                "id": int(way.get("id")),
                "timestamp": way.get("timestamp"),
                "tags": tags,
                "geometry": [{"lon": lon, "lat": lat} for lon, lat in coords],
            }
        )
        ts = way.get("timestamp")
        if ts and (latest_timestamp is None or ts > latest_timestamp):
            latest_timestamp = ts

    return {
        "version": 0.6,
        "generator": "openstreetmap.org API 0.6 (fallback)",
        "osm3s": {
            "timestamp_osm_base": latest_timestamp,
            "copyright": (
                "The data included in this document is from www.openstreetmap.org. "
                "The data is made available under ODbL."
            ),
        },
        "elements": elements,
    }


def fetch_osm_buildings(
    bbox: list[float],
    chunks: int,
    refresh: bool,
    cache_dir: Path,
    force_osm_api: bool = False,
) -> tuple[list[dict[str, Any]], str | None]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    elements: list[dict[str, Any]] = []
    timestamps: list[str] = []
    boxes = split_bbox(bbox, chunks)
    for idx, bb in enumerate(boxes, start=1):
        tag = f"chunk_{idx:02d}_" + "_".join(f"{v:.4f}" for v in bb)
        path = cache_dir / f"overpass_{tag}.json"
        if path.exists() and not refresh:
            payload = json.loads(path.read_text(encoding="utf-8"))
            print(f"  [{idx}/{len(boxes)}] Overpass: кэш {path.name}")
        else:
            print(f"  [{idx}/{len(boxes)}] Overpass: скачиваю {bb}…")
            if force_osm_api:
                payload = osm_api_query(bb)
                time.sleep(0.5)
            else:
                try:
                    payload = overpass_query(bb)
                except RuntimeError as exc:
                    print(f"    Overpass недоступен ({exc}); использую OSM API 0.6")
                    payload = osm_api_query(bb)
                    time.sleep(0.5)
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        elements.extend(payload.get("elements", []))
        ts = payload.get("osm3s", {}).get("timestamp_osm_base")
        if ts:
            timestamps.append(ts)
    return elements, max(timestamps) if timestamps else None


def osm_element_to_feature(element: dict[str, Any], island_geom) -> dict[str, Any] | None:
    if element.get("type") != "way":
        return None
    geometry = element.get("geometry")
    if not geometry or len(geometry) < 4:
        return None
    coords = [(p["lon"], p["lat"]) for p in geometry if "lon" in p and "lat" in p]
    if len(coords) < 4:
        return None
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    try:
        polygon = Polygon(coords)
    except Exception:
        return None
    polygon = clean_geometry(polygon)
    if polygon is None:
        return None
    if island_geom is not None:
        rep = polygon.representative_point()
        inside = island_geom.contains(rep)
        if not inside:
            try:
                inter = island_geom.intersection(polygon).area
                inside = polygon.area > 0 and inter / polygon.area >= 0.5
            except Exception:
                inside = False
        if not inside:
            return None
    return {
        "osm_id": int(element["id"]),
        "polygon": polygon,
        "tags": element.get("tags", {}) or {},
    }


# ---------------------------------------------------------------------------
# kontikimaps (ODbL)
# ---------------------------------------------------------------------------


def mercator_xy(lon: float, lat: float) -> tuple[float, float]:
    x = lon * 20037508.342789244 / 180.0
    y = math.log(math.tan((90.0 + lat) * math.pi / 360.0)) / (math.pi / 180.0)
    y = y * 20037508.342789244 / 180.0
    return x, y


def mercator_to_lonlat(x: float, y: float) -> tuple[float, float]:
    lon = x / 20037508.342789244 * 180.0
    lat = math.degrees(2.0 * math.atan(math.exp(y / EARTH_RADIUS)) - math.pi / 2.0)
    return lon, lat


def gpkg_geom_to_shapely(blob: bytes):
    if not blob or len(blob) < 8 or blob[:2] != b"GP":
        raise ValueError("Некорректный GeoPackage geometry blob")
    flags = blob[3]
    envelope_code = (flags >> 1) & 0x07
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    offset = 8 + envelope_sizes.get(envelope_code, 0)
    geom = wkb.loads(blob[offset:])
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    return None


def import_kontiki_subset(gpkg_path: Path, bbox: list[float], cache_path: Path) -> list[dict[str, Any]]:
    """Извлекает из большой ODbL-выгрузки kontikimaps здания в bbox.

    Выгрузка: HOITH_database_231118.gpkg (1.8 ГБ, 80 городов), версия
    18.11.2023. Скачивается вручную по ссылке с
    https://kontikimaps.ru/how-old/cities250/datasets (ODbL).
    """
    print(f"Импорт kontikimaps из {gpkg_path.name} (bbox острова)…")
    west, south, east, north = bbox
    xmin, ymin = mercator_xy(west, south)
    xmax, ymax = mercator_xy(east, north)
    con = sqlite3.connect(str(gpkg_path))
    con.row_factory = sqlite3.Row
    query = """
        SELECT a.fid, a.r_year_int, a.r_floors, a.r_adress, a.r_style, a.geom
        FROM all_cities_181123 AS a
        WHERE a.city = 'saint petersburg'
          AND a.fid IN (
            SELECT id FROM rtree_all_cities_181123_geom
            WHERE maxx >= ? AND minx <= ? AND maxy >= ? AND miny <= ?
          )
    """
    params = (xmin - 50, xmax + 50, ymin - 50, ymax + 50)
    features: list[dict[str, Any]] = []
    total = 0
    for row in con.execute(query, params):
        total += 1
        try:
            geom3857 = gpkg_geom_to_shapely(row["geom"])
        except Exception:
            continue
        if geom3857 is None or geom3857.is_empty:
            continue
        geom = transform(lambda x, y, z=None: mercator_to_lonlat(x, y), geom3857)
        geom = clean_geometry(geom)
        if geom is None:
            continue
        minx, miny, maxx, maxy = geom.bounds
        if maxx < west - 0.001 or minx > east + 0.001 or maxy < south - 0.001 or miny > north + 0.001:
            continue
        year = int(row["r_year_int"]) if row["r_year_int"] is not None else None
        if year is not None and not (PLAUSIBLE_YEAR_MIN <= year <= PLAUSIBLE_YEAR_MAX):
            year = None
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "year": year,
                    "floors": row["r_floors"],
                    "address": row["r_adress"],
                    "style": row["r_style"],
                    "source": "kontikimaps.ru",
                    "license": "ODbL 1.0",
                },
                "geometry": round_coords(mapping(geom)),
            }
        )
    con.close()
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "name": "kontiki_spb_island_subset",
                "attribution": "Данные о годе постройки: Кон-Тики (kontikimaps.ru), ODbL",
                "source": "HOITH_database_231118.gpkg",
                "license": "ODbL 1.0",
                "features": features,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"  kontikimaps: строк в bbox {total}, сохранено {len(features)} → {cache_path}")
    return features


def load_kontiki_features(
    args: argparse.Namespace, bbox: list[float], cache_path: Path
) -> list[dict[str, Any]]:
    if args.no_kontiki:
        return []
    if cache_path.exists() and not args.refresh_kontiki:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        print(f"kontikimaps: кэш {cache_path} ({len(payload.get('features', []))} зданий)")
        return payload.get("features", [])
    if not args.kontiki_gpkg:
        print(
            "kontikimaps: выгрузка не указана. Годы будут только из OSM.\n"
            "  Для обогащения скачайте HOITH_database_231118.gpkg (ODbL) и запустите\n"
            "  python scripts/prepare_data.py --kontiki-gpkg data/raw/HOITH_database_231118.gpkg"
        )
        return []
    gpkg = Path(args.kontiki_gpkg)
    if not gpkg.is_absolute():
        gpkg = ROOT / gpkg
    if not gpkg.exists():
        raise FileNotFoundError(f"Не найден GeoPackage kontikimaps: {gpkg}")
    return import_kontiki_subset(gpkg, bbox, cache_path)


def enrich_years_from_kontiki(
    buildings: list[dict[str, Any]],
    proj_geoms: list[Any],
    kontiki_features: list[dict[str, Any]],
    max_match_meters: float,
    projection: "LocalProjection",
) -> dict[str, int]:
    """Сопоставляет здания OSM с контурами kontikimaps по расстоянию."""
    if not kontiki_features:
        return {"matched": 0, "candidates": 0}
    k_geoms = []
    k_years = []
    for feat in kontiki_features:
        year = feat.get("properties", {}).get("year")
        if year is None:
            continue
        try:
            geom = shape(feat["geometry"])
        except Exception:
            continue
        if geom.is_empty:
            continue
        # Контуры kontikimaps хранятся в WGS84, а метрики зданий — в локальной
        # метрической проекции. Без приведения к одной системе расстояния и
        # площади несопоставимы, поэтому сопоставляем в метрах.
        geom = projection.project(geom)
        if geom.is_empty:
            continue
        k_geoms.append(geom)
        k_years.append(int(year))
    if not k_geoms:
        return {"matched": 0, "candidates": 0}
    tree = STRtree(k_geoms)
    matched = 0
    candidates_total = 0
    for i, bld in enumerate(buildings):
        if bld.get("year") is not None:
            continue
        geom = proj_geoms[i]
        cand = list(tree.query(geom.buffer(max_match_meters)))
        candidates_total += len(cand)
        best = None
        best_score = None
        for j in cand:
            kg = k_geoms[j]
            dist = geom.distance(kg)
            if dist > max_match_meters:
                continue
            area_ratio = geom.area / kg.area if kg.area > 0 else 0
            if not (0.35 <= area_ratio <= 2.8):
                continue
            score = dist + abs(math.log(max(area_ratio, 1e-9))) * 3.0
            if best_score is None or score < best_score:
                best_score = score
                best = j
        if best is not None:
            bld["year"] = k_years[best]
            bld["year_source"] = "kontiki"
            matched += 1
    return {"matched": matched, "candidates": candidates_total}


# ---------------------------------------------------------------------------
# Основной конвейер
# ---------------------------------------------------------------------------


def build_building_records(
    raw_elements: list[dict[str, Any]],
    island_geom,
    cfg: dict[str, Any],
    projection: LocalProjection,
) -> tuple[list[dict[str, Any]], list[Any]]:
    seen: dict[int, dict[str, Any]] = {}
    for element in raw_elements:
        feat = osm_element_to_feature(element, island_geom)
        if feat is None:
            continue
        seen.setdefault(feat["osm_id"], feat)
    print(f"  уникальных зданий после фильтра острова: {len(seen)}")

    records = []
    for osm_id, feat in seen.items():
        tags = feat["tags"]
        levels = parse_levels(tags)
        height = parse_height(tags)
        year, year_source = parse_year(tags)
        records.append(
            {
                "osm_id": osm_id,
                "polygon": feat["polygon"],
                "tags": tags,
                "levels": levels,
                "height": height,
                "year": year,
                "year_source": year_source,
                "levels_source": "osm" if levels is not None else ("height" if height is not None else None),
                "levels_imputed": False,
            }
        )

    # Импутация этажности: ячейка 500 м → район (медиана острова).
    floor_height = float(cfg["scenario"]["floorHeightMeters"])
    known = [r["levels"] for r in records if r["levels"] is not None]
    district_median = float(statistics.median(known)) if known else 5.0
    cells: dict[tuple[int, int], list[float]] = {}
    for r in records:
        if r["levels"] is None:
            continue
        cx, cy = projection.xy(r["polygon"].centroid.x, r["polygon"].centroid.y)
        cells.setdefault((int(math.floor(cx / 500)), int(math.floor(cy / 500))), []).append(r["levels"])
    cell_medians = {k: float(statistics.median(v)) for k, v in cells.items() if len(v) >= 8}

    for r in records:
        if r["levels"] is None:
            if r["height"] is not None:
                r["levels"] = r["height"] / floor_height
                r["levels_source"] = "height"
            else:
                cx, cy = projection.xy(r["polygon"].centroid.x, r["polygon"].centroid.y)
                key = (int(math.floor(cx / 500)), int(math.floor(cy / 500)))
                if key in cell_medians:
                    r["levels"] = cell_medians[key]
                    r["levels_source"] = "imputed_cell"
                else:
                    r["levels"] = district_median
                    r["levels_source"] = "imputed_district"
                r["levels_imputed"] = True

    for r in records:
        if r["height"] is None:
            r["height"] = float(r["levels"]) * floor_height
            if r["levels_source"] == "osm":
                r["levels_source"] = "osm"

    for r in records:
        r["levels"] = round(float(r["levels"]), 2)
        r["height"] = round(float(r["height"]), 2)
        r["style"] = style_for_year(
            r["year"], cfg["stylePeriods"], cfg["unknownStyle"]["name"]
        )

    records.sort(key=lambda r: r["osm_id"])
    geoms = [r["polygon"] for r in records]
    return records, geoms


def compute_building_neighbors(
    records: list[dict[str, Any]],
    proj_geoms: list[Any],
    max_neighbors: int,
    radius: float,
) -> None:
    print(f"  ищу до {max_neighbors} соседей в радиусе {radius:.0f} м (расстояние между полигонами)…")
    tree = STRtree(proj_geoms)
    for i, r in enumerate(records):
        geom = proj_geoms[i]
        candidates = list(tree.query(geom.buffer(radius)))
        neighbors: list[tuple[float, int]] = []
        for j in candidates:
            if j == i:
                continue
            d = geom.distance(proj_geoms[j])
            if d <= radius + 1e-9:
                neighbors.append((float(d), int(j)))
        neighbors.sort(key=lambda t: (t[0], records[t[1]]["osm_id"]))
        nearest = neighbors[:max_neighbors]
        r["neighbor_count"] = len(neighbors)
        r["neighbors"] = [
            {
                "id": records[j]["osm_id"],
                "distance": round(d, 2),
                "levels": records[j]["levels"],
            }
            for d, j in nearest
        ]
        if neighbors:
            r["nearest_distance"] = round(neighbors[0][0], 2)
            r["level_difference"] = int(round(max(records[j]["levels"] for _, j in neighbors) - r["levels"]))
        else:
            r["nearest_distance"] = None
            r["level_difference"] = None
        if r["nearest_distance"] is not None and r["nearest_distance"] > 0:
            r["ratio"] = round(r["height"] / r["nearest_distance"], 4)
        else:
            r["ratio"] = None


def build_reference_points(
    cfg: dict[str, Any],
    records: list[dict[str, Any]],
    proj_geoms: list[Any],
    island_proj,
    projection: LocalProjection,
) -> list[dict[str, Any]]:
    th = cfg["thresholds"]
    radius = float(cfg["bufferMeters"])
    step = float(cfg["gridStepMeters"])
    ignore = float(cfg.get("minGapIgnoreMeters", 1.0))
    min_buildings = int(th.get("minBuildingsForMetrics", 2))
    unknown_style = cfg["unknownStyle"]["name"]

    tree = STRtree(proj_geoms)
    minx, miny, maxx, maxy = island_proj.bounds
    start_x = math.ceil(minx / step) * step
    start_y = math.ceil(miny / step) * step

    points: list[dict[str, Any]] = []
    skipped_inside = 0
    skipped_sparse = 0
    skipped_nogap = 0
    y = start_y
    while y <= maxy:
        x = start_x
        while x <= maxx:
            p = Point(x, y)
            if not island_proj.contains(p):
                x += step
                continue
            # Не ставим точку внутри здания или вплотную к стене.
            near = list(tree.query(p))
            if any(proj_geoms[i].distance(p) < 1.0 for i in near):
                skipped_inside += 1
                x += step
                continue

            candidates = list(tree.query(p.buffer(radius)))
            selected = [i for i in candidates if p.distance(proj_geoms[i]) <= radius + 1e-9]
            if len(selected) < min_buildings:
                skipped_sparse += 1
                x += step
                continue

            metrics = compute_point_metrics(p, selected, records, proj_geoms, cfg)
            if metrics["min_gap"] is None or metrics["ratio"] is None:
                skipped_nogap += 1
                x += step
                continue

            lon, lat = projection.lonlat(x, y)
            rp_id = f"RP-{len(points) + 1:04d}"
            props = {
                "id": rp_id,
                "lon": round(lon, 7),
                "lat": round(lat, 7),
                **metrics,
                "count_known_styles": sum(
                    1 for i in selected if records[i]["style"] != unknown_style
                ),
            }
            points.append(
                {
                    "type": "Feature",
                    "properties": props,
                    "geometry": {"type": "Point", "coordinates": [round(lon, 7), round(lat, 7)]},
                }
            )
            x += step
        y += step
        if len(points) % 500 == 0 and len(points):
            print(f"    опорных точек: {len(points)}…", end="\r", flush=True)
    print(
        f"\n  опорные точки: {len(points)}; пропущено внутри зданий: {skipped_inside}, "
        f"мало зданий: {skipped_sparse}, нет валидного зазора: {skipped_nogap}"
    )
    return points


def write_geojson(path: Path, features: list[dict[str, Any]], name: str, attribution: str) -> None:
    payload = {
        "type": "FeatureCollection",
        "name": name,
        "attribution": attribution,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "features": features,
    }
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"  записано: {path} ({path.stat().st_size / 1e6:.2f} МБ, {len(features)} объектов)")


def make_control_buildings(
    records: list[dict[str, Any]],
    projection: LocalProjection,
) -> list[dict[str, Any]]:
    eligible = [
        (i, r)
        for i, r in enumerate(records)
        if r.get("nearest_distance") and r["nearest_distance"] > 1.0 and r.get("ratio") is not None
    ]
    if not eligible:
        return []
    eligible.sort(key=lambda t: projection.xy(t[1]["polygon"].centroid.x, t[1]["polygon"].centroid.y)[0])
    picks = []
    for frac in (0.2, 0.5, 0.8):
        idx = min(len(eligible) - 1, max(0, int(round(frac * (len(eligible) - 1)))))
        picks.append(eligible[idx])
    controls = []
    for _, r in picks:
        controls.append(
            {
                "id": r["osm_id"],
                "address": " ".join(
                    filter(None, [r["tags"].get("addr:street"), r["tags"].get("addr:housenumber")])
                )
                or None,
                "levels": r["levels"],
                "height_m": r["height"],
                "year": r["year"],
                "year_source": r["year_source"],
                "style": r["style"],
                "neighbors": r.get("neighbors", []),
                "level_difference": r["level_difference"],
                "nearest_distance_m": r["nearest_distance"],
                "ratio": r["ratio"],
                "manual_formula": {
                    "height": (
                        f"{r['levels']} эт. × 3.3 = {r['height']} м"
                        if r.get("levels_source") in ("osm", "imputed_cell", "imputed_district")
                        else f"тег height = {r['height']} м"
                    ),
                    "level_difference": (
                        f"max(этажи соседей) − {r['levels']} = {r['level_difference']}"
                        if r.get("neighbors")
                        else "нет соседей"
                    ),
                    "ratio": (
                        f"{r['height']} / {r['nearest_distance']} = {r['ratio']}"
                        if r.get("nearest_distance")
                        else "нет соседей"
                    ),
                },
            }
        )
    return controls


def write_metadata(
    cfg: dict[str, Any],
    args: argparse.Namespace,
    bbox: list[float],
    island_geom,
    records: list[dict[str, Any]],
    points: list[dict[str, Any]],
    counters: dict[str, Any],
    osm_timestamp: str | None,
    island_path: Path,
) -> dict[str, Any]:
    year_sources = Counter(
        (r["year_source"].split(":")[0] if r.get("year_source") else "unknown") for r in records
    )
    levels_sources = Counter(r.get("levels_source") or "unknown" for r in records)
    class_counts = Counter(p["properties"]["class_id"] for p in points)
    diversity_counts = Counter(p["properties"]["diversity_status"] for p in points)
    known_years = sum(1 for r in records if r.get("year") is not None)
    controls = make_control_buildings(records, LocalProjection(*cfg["studyArea"]["origin"]))
    metadata = {
        "app": cfg["app"],
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "study_area": {
            "name": cfg["studyArea"]["name"],
            "bbox_wgs84": bbox,
            "origin_wgs84": cfg["studyArea"]["origin"],
            "island_source": "OpenStreetMap relation 1576083 via Nominatim",
            "island_file": str(island_path.relative_to(ROOT)).replace("\\", "/"),
            "island_area_km2": round(island_geom.area * 111.32 * 111.32 * math.cos(math.radians(59.936)), 3),
        },
        "method": {
            "buffer_meters": cfg["bufferMeters"],
            "grid_step_meters": cfg["gridStepMeters"],
            "height_rule": "height из тега height, иначе building:levels × 3.3",
            "levels_imputation": "медиана по ячейке 500×500 м (≥8 зданий), иначе медиана по району",
            "neighbor_rule": f"до {cfg['neighbors']['maxNeighbors']} ближайших зданий в радиусе {cfg['neighbors']['radiusMeters']} м; расстояние между полигонами",
            "level_difference_rule": "max(building:levels соседей) − building:levels здания",
            "ratio_rule": "height / nearest_distance (для здания); avg_height / min_gap (для двора)",
            "gap_rule": (
                f"минимальный ненулевой зазор между контурами; пары ближе {cfg.get('minGapIgnoreMeters', 1.0)} м "
                "считаются соприкасающимися (стены по меже); min_gap — минимум ближайших положительных зазоров, "
                "avg_gap — среднее по зданиям"
            ),
            "style_rule": "год → период из app/config.js; при пересечении границ (1905, 1935) выбирается более поздний период; год вне 1703–2026 → «неизвестно»",
            "style_diversity_rule": "число различных известных стилей, без «неизвестно»; доля неизвестных показывается отдельно",
            "dominant_rule": "стиль ≥50% зданий; при равенстве двух стилей доминирующий не определяется",
            "scenario_plus5_rule": "avg_height + 5 × 3.3 м при неизменном min_gap",
            "scenario_expand_rule": "avg_height / (min_gap + 10 м)",
            "reference_points_rule": "сетка 50×50 м внутри полигона острова; точки внутри зданий и точки без валидного зазора исключены",
        },
        "thresholds": cfg["thresholds"],
        "styles": [p["name"] for p in cfg["stylePeriods"]],
        "counts": {
            "buildings": len(records),
            "buildings_with_known_year": known_years,
            "buildings_with_ratio": sum(1 for r in records if r.get("ratio") is not None),
            "buildings_without_neighbors": sum(1 for r in records if r.get("nearest_distance") is None),
            "reference_points": len(points),
            "reference_classes": dict(class_counts),
            "reference_diversity": dict(diversity_counts),
            **counters,
        },
        "year_sources": dict(year_sources),
        "levels_sources": dict(levels_sources),
        "osm_base_timestamp": osm_timestamp,
        "licenses": {
            "osm": {
                "name": "OpenStreetMap",
                "license": "ODbL 1.0",
                "attribution": "© участники OpenStreetMap, ODbL",
                "url": "https://www.openstreetmap.org/copyright",
            },
            "kontikimaps": {
                "name": "Кон-Тики / how-old-is-this.house",
                "license": "ODbL 1.0",
                "attribution": "Данные о годе постройки: Кон-Тики (kontikimaps.ru), ODbL",
                "url": "https://kontikimaps.ru/how-old/cities250/datasets",
                "dataset": "HOITH_database_231118.gpkg, версия 18.11.2023",
                "note": "Перед использованием сверяйтесь с актуальными условиями на сайте. Лицензия ODbL вирусная.",
            },
        },
        "disclaimer": (
            "Приложение показывает связь метрик застройки с восприятием масштаба и стилистической "
            "неоднородности. Это не оценка качества среды и не прогноз поведения. Выбор участка "
            "требует градостроительного обоснования."
        ),
    }
    (DATA_DIR / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (DATA_DIR / "control_buildings.json").write_text(
        json.dumps(
            {
                "generated_at": metadata["generated_at"],
                "note": "Три контрольных здания для ручной сверки height, level_difference, nearest_distance, ratio",
                "buildings": controls,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return metadata


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Подготовка GeoJSON и метрик для приложения «Дворовый масштаб»."
    )
    parser.add_argument(
        "--bbox",
        help="bbox в формате W,S,E,N (долгота/широта). По умолчанию — из app/config.js",
    )
    parser.add_argument("--chunks", type=int, default=4, help="число частей по каждой оси для Overpass (по умолчанию 4)")
    parser.add_argument("--refresh-osm", action="store_true", help="перекачать здания из Overpass")
    parser.add_argument(
        "--osm-api",
        action="store_true",
        help="скачивать здания через OSM API 0.6 вместо Overpass (резервный источник)",
    )
    parser.add_argument("--refresh-island", action="store_true", help="перезапросить границу острова")
    parser.add_argument("--island", default=str(DEFAULT_ISLAND), help="путь к GeoJSON границы острова")
    parser.add_argument("--no-island-filter", action="store_true", help="не фильтровать здания полигоном острова")
    parser.add_argument("--kontiki-gpkg", help="путь к HOITH_database_231118.gpkg (ODbL)")
    parser.add_argument("--refresh-kontiki", action="store_true", help="переимпортировать kontikimaps из gpkg")
    parser.add_argument("--no-kontiki", action="store_true", help="не использовать kontikimaps")
    parser.add_argument("--kontiki-match-meters", type=float, default=15.0, help="макс. расстояние сопоставления, м")
    parser.add_argument("--max-neighbors", type=int, default=None, help="переопределить число соседей")
    parser.add_argument("--skip-reference", action="store_true", help="не строить сетку опорных точек")
    parser.add_argument("--limit-buildings", type=int, help="ограничить число зданий (для отладки)")
    args = parser.parse_args()

    cfg = load_config()
    bbox = [float(x) for x in (args.bbox.split(",") if args.bbox else cfg["studyArea"]["bbox"])]
    if len(bbox) != 4:
        raise SystemExit("--bbox должен содержать четыре числа: W,S,E,N")
    west, south, east, north = bbox
    if not (west < east and south < north):
        raise SystemExit("Некорректный bbox: нужны W<E и S<N")
    origin = (
        ((west + east) / 2, (south + north) / 2)
        if args.bbox
        else tuple(cfg["studyArea"]["origin"])
    )
    projection = LocalProjection(*origin)
    cfg["studyArea"]["origin"] = [origin[0], origin[1]]

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)

    island_geom = None
    island_path = Path(args.island)
    if not island_path.is_absolute():
        island_path = ROOT / island_path
    if not args.no_island_filter:
        island_geom = fetch_island_boundary(cfg, island_path, refresh=args.refresh_island)
    island_proj = projection.project(island_geom) if island_geom is not None else box(
        *projection.xy(west, south), *projection.xy(east, north)
    )

    print("\n1/6. Здания OSM")
    raw_elements, osm_timestamp = fetch_osm_buildings(
        bbox, max(1, args.chunks), args.refresh_osm, RAW_DIR, force_osm_api=args.osm_api
    )
    records, _ = build_building_records(raw_elements, island_geom, cfg, projection)
    if args.limit_buildings:
        records = records[: args.limit_buildings]
    if not records:
        raise SystemExit(
            "Не найдено ни одного здания. Проверьте bbox, фильтр острова и доступность Overpass."
        )
    print(f"  зданий: {len(records)}")

    proj_geoms = [projection.project(r["polygon"]) for r in records]
    # замыкаем списки после возможного limit
    records = records[: len(proj_geoms)]

    print("\n2/6. Год постройки")
    kontiki_features = load_kontiki_features(
        args, bbox, RAW_DIR / "kontiki_buildings.geojson"
    )
    unknown_before_match = sum(1 for r in records if r.get("year") is None)
    match_stats = enrich_years_from_kontiki(
        records, proj_geoms, kontiki_features, args.kontiki_match_meters, projection
    )
    print(
        f"  kontikimaps: сопоставлено {match_stats['matched']} из "
        f"{unknown_before_match} зданий без года OSM"
    )
    for r in records:
        r["style"] = style_for_year(
            r["year"], cfg["stylePeriods"], cfg["unknownStyle"]["name"]
        )
    year_counter = Counter(
        (r["year_source"].split(":")[0] if r.get("year_source") else "unknown") for r in records
    )
    print(f"  источники года: {dict(year_counter)}")

    print("\n3/6. Соседи и метрики зданий")
    max_neighbors = args.max_neighbors or int(cfg["neighbors"]["maxNeighbors"])
    compute_building_neighbors(
        records,
        proj_geoms,
        max_neighbors=max_neighbors,
        radius=float(cfg["neighbors"]["radiusMeters"]),
    )

    print("\n4/6. GeoJSON зданий")
    building_features = []
    for r in records:
        props = {
            "id": r["osm_id"],
            "osm_id": r["osm_id"],
            "levels": r["levels"],
            "height": r["height"],
            "year": r["year"],
            "year_source": r["year_source"],
            "style": r["style"],
            "level_difference": r["level_difference"],
            "nearest_distance": r["nearest_distance"],
            "ratio": r["ratio"],
            "neighbor_count": r.get("neighbor_count", 0),
            "addr_street": r["tags"].get("addr:street"),
            "addr_housenumber": r["tags"].get("addr:housenumber"),
            "building": r["tags"].get("building"),
            "levels_source": r["levels_source"],
            "levels_imputed": bool(r["levels_imputed"]),
        }
        building_features.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": round_coords(mapping(r["polygon"])),
            }
        )
    write_geojson(
        DATA_DIR / "buildings.geojson",
        building_features,
        "courtyard_buildings_vasilievsky",
        "© участники OpenStreetMap, ODbL; годы постройки частично © Кон-Тики (kontikimaps.ru), ODbL",
    )

    print("\n5/6. Опорные точки")
    if args.skip_reference:
        points = []
        print("  пропущено по --skip-reference")
    else:
        points = build_reference_points(cfg, records, proj_geoms, island_proj, projection)
        write_geojson(
            DATA_DIR / "reference_points.geojson",
            points,
            "courtyard_reference_points_50m",
            "Расчёт по данным © участники OpenStreetMap, ODbL; годы постройки частично © Кон-Тики (kontikimaps.ru), ODbL",
        )

    print("\n6/6. Метаданные")
    counters = {
        "osm_raw_elements": len(raw_elements),
        "osm_unique_buildings": len(records),
        "kontiki_matched": match_stats["matched"],
        "kontiki_candidates": match_stats["candidates"],
        "kontiki_subset_features": len(kontiki_features),
    }
    metadata = write_metadata(
        cfg, args, bbox, island_geom, records, points, counters, osm_timestamp, island_path
    )
    print(
        f"  зданий: {metadata['counts']['buildings']}, "
        f"с годом: {metadata['counts']['buildings_with_known_year']}, "
        f"опорных точек: {metadata['counts']['reference_points']}"
    )
    print("\nГотово.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nПрервано пользователем.", file=sys.stderr)
        raise SystemExit(130)
