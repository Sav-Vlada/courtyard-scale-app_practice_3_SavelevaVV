#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Проверка подготовленных данных и воспроизводимости метрик.

Запуск:
    python scripts/validate_data.py

Проверяет:
1. Обязательные поля и уникальность id в buildings.geojson.
2. Три контрольных здания: height, level_difference, nearest_distance, ratio
   пересчитываются заново по контурам и сравниваются с сохранёнными значениями.
3. Три опорные точки (первая, средняя, последняя): метрики пересчитываются
   по buildings.geojson и сравниваются с reference_points.geojson.
4. Классы, сценарные значения +5 этажей и допустимые стили.
5. Все опорные точки лежат внутри полигона острова.
"""

from __future__ import annotations

import json
import math
import sys
from collections import Counter
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prepare_data as prep  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"

REQUIRED_BUILDING_FIELDS = (
    "id", "levels", "height", "year", "style", "level_difference",
    "nearest_distance", "ratio",
)
REQUIRED_POINT_FIELDS = (
    "id", "avg_height", "max_height", "min_height", "level_range",
    "min_gap", "avg_gap", "ratio", "style_diversity", "dominant_style",
    "class_id",
)

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    cfg = prep.load_config()
    origin = cfg["studyArea"]["origin"]
    projection = prep.LocalProjection(*origin)

    print("Загрузка данных…")
    buildings_geo = load_json(DATA / "buildings.geojson")
    points_geo = load_json(DATA / "reference_points.geojson")
    island_geo = load_json(DATA / "island.geojson")
    controls = load_json(DATA / "control_buildings.json")
    metadata = load_json(DATA / "metadata.json")

    records = []
    ids = []
    for feature in buildings_geo["features"]:
        props = feature["properties"]
        geom = shape(feature["geometry"])
        ids.append(props.get("id"))
        records.append(
            {
                "osm_id": props.get("id"),
                "polygon": geom,
                "levels": props.get("levels"),
                "height": props.get("height"),
                "year": props.get("year"),
                "style": props.get("style"),
                "nearest_distance": props.get("nearest_distance"),
                "level_difference": props.get("level_difference"),
                "ratio": props.get("ratio"),
            }
        )
        for field in REQUIRED_BUILDING_FIELDS:
            check(field in props, f"В здании {props.get('id')} нет поля {field}")
        check(geom.is_valid, f"Невалидная геометрия здания {props.get('id')}")
        check((props.get("levels") or 0) > 0, f"Некорректная этажность здания {props.get('id')}")
        check((props.get("height") or 0) > 0, f"Некорректная высота здания {props.get('id')}")
        check(
            geom.area > 0,
            f"Нулевая площадь здания {props.get('id')}",
        )

    check(len(ids) == len(set(ids)), "id зданий не уникальны")
    print(f"  зданий: {len(records)}, уникальных id: {len(set(ids))}")

    allowed_styles = {p["name"] for p in cfg["stylePeriods"]} | {cfg["unknownStyle"]["name"]}
    bad_styles = [r["osm_id"] for r in records if r["style"] not in allowed_styles]
    check(not bad_styles, f"Недопустимые стили у зданий: {bad_styles[:5]}")

    points = points_geo["features"]
    point_ids = [p["properties"].get("id") for p in points]
    check(len(point_ids) == len(set(point_ids)), "id опорных точек не уникальны")
    for feature in points:
        props = feature["properties"]
        for field in REQUIRED_POINT_FIELDS:
            check(field in props, f"В точке {props.get('id')} нет поля {field}")

    island = shape(island_geo["features"][0]["geometry"])
    outside = [
        p["properties"]["id"]
        for p in points
        if not island.contains(Point(p["geometry"]["coordinates"]))
    ]
    check(not outside, f"Точки вне острова: {outside[:5]}")
    print(f"  опорных точек: {len(points)}; классов: {dict(Counter(p['properties']['class_id'] for p in points))}")

    # ---------------------------------------------------------------------
    # 1. Контрольные здания
    # ---------------------------------------------------------------------
    proj_geoms = [projection.project(r["polygon"]) for r in records]
    tree = STRtree(proj_geoms)
    index_by_id = {r["osm_id"]: i for i, r in enumerate(records)}

    print("\nКонтрольные здания (пересчёт по контурам):")
    print(f"{'id':>12}  {'эт.':>5}  {'height':>8}  {'max сосед':>10}  {'Δэт':>4}  {'minD':>7}  {'ratio':>7}")
    for control in controls["buildings"]:
        b_id = control["id"]
        check(b_id in index_by_id, f"Контрольное здание {b_id} отсутствует в buildings.geojson")
        if b_id not in index_by_id:
            continue
        i = index_by_id[b_id]
        geom = proj_geoms[i]
        neighbors = []
        for j in tree.query(geom.buffer(float(cfg["neighbors"]["radiusMeters"]))):
            j = int(j)
            if j == i:
                continue
            d = geom.distance(proj_geoms[j])
            if d <= float(cfg["neighbors"]["radiusMeters"]) + 1e-9:
                neighbors.append((d, j))
        neighbors.sort(key=lambda t: (t[0], records[t[1]]["osm_id"]))
        nearest = neighbors[0][0] if neighbors else None
        max_neighbor_levels = max((records[j]["levels"] for _, j in neighbors), default=None)
        level_diff = (
            int(round(max_neighbor_levels - records[i]["levels"]))
            if max_neighbor_levels is not None else None
        )
        ratio = (
            round(records[i]["height"] / nearest, 4)
            if nearest and nearest > 0 else None
        )
        expected = control
        check(
            abs(records[i]["height"] - expected["height_m"]) < 0.02,
            f"{b_id}: height {records[i]['height']} != {expected['height_m']}",
        )
        check(
            (level_diff is None and expected["level_difference"] is None) or level_diff == expected["level_difference"],
            f"{b_id}: level_difference {level_diff} != {expected['level_difference']}",
        )
        if nearest is not None and expected["nearest_distance_m"] is not None:
            check(
                abs(nearest - expected["nearest_distance_m"]) < 0.02,
                f"{b_id}: nearest_distance {nearest:.3f} != {expected['nearest_distance_m']}",
            )
        if ratio is not None and expected["ratio"] is not None:
            check(
                abs(ratio - expected["ratio"]) < 0.01,
                f"{b_id}: ratio {ratio:.4f} != {expected['ratio']}",
            )
        print(
            f"{b_id:>12}  {records[i]['levels']:>5.1f}  {records[i]['height']:>8.2f}  "
            f"{(max_neighbor_levels or 0):>10.1f}  {(level_diff if level_diff is not None else -1):>4}  "
            f"{(nearest if nearest is not None else float('nan')):>7.2f}  "
            f"{(ratio if ratio is not None else float('nan')):>7.3f}"
        )
        check(
            abs(records[i]["nearest_distance"] - round(nearest, 2)) < 0.02
            if nearest is not None else records[i]["nearest_distance"] is None,
            f"{b_id}: сохранённый nearest_distance не совпал",
        )

    # ---------------------------------------------------------------------
    # 2. Опорные точки
    # ---------------------------------------------------------------------
    print("\nОпорные точки (пересчёт по buildings.geojson):")
    check(len(points) > 0, "Нет опорных точек")
    sample_indices = sorted(set([0, len(points) // 2, len(points) - 1])) if points else []
    for idx in sample_indices:
        feature = points[idx]
        props = feature["properties"]
        lon, lat = feature["geometry"]["coordinates"]
        p = Point(*projection.xy(lon, lat))
        radius = float(cfg["bufferMeters"])
        selected = [
            int(j) for j in tree.query(p.buffer(radius))
            if p.distance(proj_geoms[int(j)]) <= radius + 1e-9
        ]
        recomputed = prep.compute_point_metrics(p, selected, records, proj_geoms, cfg)
        for field in (
            "avg_height", "max_height", "min_height", "level_range",
            "min_gap", "avg_gap", "ratio", "style_diversity", "dominant_style",
            "class_id",
        ):
            expected = props.get(field)
            actual = recomputed.get(field)
            if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
                check(
                    abs(expected - actual) < 0.02,
                    f"{props['id']}: {field} сохранено {expected}, пересчёт {actual}",
                )
            else:
                check(
                    expected == actual,
                    f"{props['id']}: {field} сохранено {expected!r}, пересчёт {actual!r}",
                )
        check(
            recomputed["scenario_plus5_class_id"] == props.get("scenario_plus5_class_id"),
            f"{props['id']}: сценарный класс +5 этажей не совпал",
        )
        print(
            f"  {props['id']}: ratio {props['ratio']} ({props['class_id']}), "
            f"пересчёт {recomputed['ratio']} ({recomputed['class_id']}), "
            f"avg_h {recomputed['avg_height']} м, min_gap {recomputed['min_gap']} м, "
            f"стилей {recomputed['style_diversity']}"
        )

    # ---------------------------------------------------------------------
    # 3. Сводка
    # ---------------------------------------------------------------------
    print("\nСводка:")
    print(f"  generated_at: {metadata.get('generated_at')}")
    print(f"  bbox: {metadata['study_area']['bbox_wgs84']}")
    print(f"  зданий: {metadata['counts']['buildings']}")
    print(f"  с известным годом: {metadata['counts']['buildings_with_known_year']}")
    print(f"  источники года: {metadata.get('year_sources')}")
    print(f"  опорных точек: {metadata['counts']['reference_points']}")
    print(f"  классы точек: {metadata['counts']['reference_classes']}")

    if failures:
        print(f"\nПРОВЕРКА НЕ ПРОЙДЕНА: {len(failures)} ошибок", file=sys.stderr)
        for failure in failures[:40]:
            print(f"  - {failure}", file=sys.stderr)
        if len(failures) > 40:
            print(f"  … и ещё {len(failures) - 40}", file=sys.stderr)
        return 1

    print("\nВсе проверки пройдены.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
