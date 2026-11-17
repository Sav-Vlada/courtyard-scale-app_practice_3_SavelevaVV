/*
 * Геометрия и rule-based интерпретация.
 *
 * Расчёты намеренно повторяют scripts/prepare_data.py:
 *  - локальная равнопромежуточная проекция в метры (та же формула и origin);
 *  - здание учитывается, если расстояние от точки до его контура ≤ 100 м;
 *  - зазор — кратчайшее расстояние между контурами; пары ближе 1 м
 *    считаются соприкасающимися (стены по меже);
 *  - min_gap — минимум ближайших положительных зазоров,
 *    avg_gap — среднее ближайших положительных зазоров по зданиям.
 *
 * Turf.js используется для буфера и проверок попадания точки, а расстояние
 * между полигонами считается напрямую по отрезкам — так результат совпадает
 * с предрасчётом Shapely.
 */
(function (global) {
  "use strict";

  const CONFIG = global.COURTYARD_CONFIG;
  const EARTH_RADIUS = 6378137.0;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function round(value, digits) {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    const p = Math.pow(10, digits);
    const scaled = value * p;
    const lower = Math.floor(scaled);
    // Python round() округляет половину к чётному, причём по точному
    // двоичному значению: 4.125 → 4.12, 6.875 → 6.88, а 11.825000000000001
    // → 11.83. Поэтому точную половину проверяем по 20 значащим цифрам,
    // а в остальных случаях используем toFixed.
    if (scaled - lower === 0.5) {
      const [integerPart, fractionPart = ""] = value.toPrecision(20).split(".");
      const fraction = (integerPart.includes("e") ? "" : fractionPart).padEnd(digits + 2, "0");
      const isExactHalf =
        fraction[digits] === "5" && /^0*$/.test(fraction.slice(digits + 1));
      if (isExactHalf) {
        return (lower % 2 === 0 ? lower : lower + 1) / p;
      }
    }
    return Number(value.toFixed(digits));
  }

  function fsum(values) {
    // Точное суммирование в стиле math.fsum (Shewchuk), чтобы средние в
    // браузере совпадали с statistics.fmean в prepare_data.py.
    const partials = [];
    for (const value of values) {
      let x = value;
      let i = 0;
      for (let j = 0; j < partials.length; j += 1) {
        let y = partials[j];
        if (Math.abs(x) < Math.abs(y)) {
          const swap = x;
          x = y;
          y = swap;
        }
        const hi = x + y;
        const lo = y - (hi - x);
        if (lo !== 0) {
          partials[i] = lo;
          i += 1;
        }
        x = hi;
      }
      partials.length = i;
      partials.push(x);
    }

    let n = partials.length;
    let hi = 0;
    let lo = 0;
    if (n > 0) {
      hi = partials[(n -= 1)];
      while (n > 0) {
        const x = hi;
        const y = partials[(n -= 1)];
        hi = x + y;
        const yr = hi - x;
        lo = y - yr;
        if (lo !== 0) break;
      }
      if (n > 0 && ((lo < 0 && partials[n - 1] < 0) || (lo > 0 && partials[n - 1] > 0))) {
        const y = lo * 2;
        const x = hi + y;
        const yr = x - hi;
        if (y === yr) hi = x;
      }
    }
    return hi;
  }

  function mean(values) {
    if (!values.length) return null;
    return fsum(values) / values.length;
  }

  class LocalProjection {
    constructor(originLon, originLat) {
      this.lon0 = Number(originLon);
      this.lat0 = Number(originLat);
      this.cosLat0 = Math.cos((this.lat0 * Math.PI) / 180);
    }

    xy(lon, lat) {
      const x = ((lon - this.lon0) * Math.PI / 180) * EARTH_RADIUS * this.cosLat0;
      const y = ((lat - this.lat0) * Math.PI / 180) * EARTH_RADIUS;
      return [x, y];
    }

    lonlat(x, y) {
      const lon = this.lon0 + (x / (EARTH_RADIUS * this.cosLat0)) * 180 / Math.PI;
      const lat = this.lat0 + (y / EARTH_RADIUS) * 180 / Math.PI;
      return [lon, lat];
    }
  }

  const projection = new LocalProjection(
    CONFIG.studyArea.origin[0],
    CONFIG.studyArea.origin[1]
  );

  function projectRing(ring) {
    return ring.map((p) => projection.xy(p[0], p[1]));
  }

  function projectGeometry(geometry) {
    if (!geometry) return null;
    if (geometry.type === "Polygon") {
      return { type: "Polygon", coordinates: geometry.coordinates.map(projectRing) };
    }
    if (geometry.type === "MultiPolygon") {
      return {
        type: "MultiPolygon",
        coordinates: geometry.coordinates.map((poly) => poly.map(projectRing)),
      };
    }
    if (geometry.type === "Point") {
      return { type: "Point", coordinates: projection.xy(geometry.coordinates[0], geometry.coordinates[1]) };
    }
    return null;
  }

  function polygonList(projected) {
    if (!projected) return [];
    if (projected.type === "Polygon") return [projected.coordinates];
    if (projected.type === "MultiPolygon") return projected.coordinates;
    return [];
  }

  function bboxOfProjected(projected) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    polygonList(projected).forEach((poly) => {
      poly.forEach((ring) => {
        ring.forEach(([x, y]) => {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        });
      });
    });
    return [minX, minY, maxX, maxY];
  }

  function pointInRing(point, ring) {
    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const intersects = (yi > y) !== (yj > y) &&
        x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function pointInPolygon(point, poly) {
    if (!poly.length || !pointInRing(point, poly[0])) return false;
    for (let i = 1; i < poly.length; i += 1) {
      if (pointInRing(point, poly[i])) return false;
    }
    return true;
  }

  function pointSegmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function pointToPolygonDistance(point, poly) {
    if (pointInPolygon(point, poly)) return 0;
    let best = Infinity;
    poly.forEach((ring) => {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const d = pointSegmentDistance(
          point[0], point[1],
          ring[i][0], ring[i][1],
          ring[i + 1][0], ring[i + 1][1]
        );
        if (d < best) best = d;
      }
    });
    return best;
  }

  function pointToGeometryDistance(point, projected) {
    let best = Infinity;
    polygonList(projected).forEach((poly) => {
      const d = pointToPolygonDistance(point, poly);
      if (d < best) best = d;
    });
    return best;
  }

  function segmentDistance(a1, a2, b1, b2) {
    // Пересекающиеся отрезки дают 0; иначе минимум из четырёх «точка–отрезок».
    const d1 = orientation(a1, a2, b1);
    const d2 = orientation(a1, a2, b2);
    const d3 = orientation(b1, b2, a1);
    const d4 = orientation(b1, b2, a2);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
      return 0;
    }
    return Math.min(
      pointSegmentDistance(a1[0], a1[1], b1[0], b1[1], b2[0], b2[1]),
      pointSegmentDistance(a2[0], a2[1], b1[0], b1[1], b2[0], b2[1]),
      pointSegmentDistance(b1[0], b1[1], a1[0], a1[1], a2[0], a2[1]),
      pointSegmentDistance(b2[0], b2[1], a1[0], a1[1], a2[0], a2[1])
    );
  }

  function orientation(a, b, c) {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  }

  function polygonDistance(polyA, polyB) {
    // Вложенность (редкий случай для зданий) — расстояние 0.
    if (polyA.length && polyB.length) {
      if (pointInPolygon(polyB[0][0], polyA) || pointInPolygon(polyA[0][0], polyB)) {
        return 0;
      }
    }
    let best = Infinity;
    for (let ra = 0; ra < polyA.length; ra += 1) {
      const ringA = polyA[ra];
      for (let ia = 0; ia < ringA.length - 1; ia += 1) {
        const a1 = ringA[ia];
        const a2 = ringA[ia + 1];
        for (let rb = 0; rb < polyB.length; rb += 1) {
          const ringB = polyB[rb];
          for (let ib = 0; ib < ringB.length - 1; ib += 1) {
            const d = segmentDistance(a1, a2, ringB[ib], ringB[ib + 1]);
            if (d < best) best = d;
            if (best === 0) return 0;
          }
        }
      }
    }
    return best;
  }

  function geometryDistance(projectedA, projectedB) {
    const polysA = polygonList(projectedA);
    const polysB = polygonList(projectedB);
    let best = Infinity;
    for (let i = 0; i < polysA.length; i += 1) {
      for (let j = 0; j < polysB.length; j += 1) {
        const d = polygonDistance(polysA[i], polysB[j]);
        if (d < best) best = d;
        if (best === 0) return 0;
      }
    }
    return best;
  }

  function bboxDistance(a, b) {
    const dx = Math.max(0, Math.max(a[0] - b[2], b[0] - a[2]));
    const dy = Math.max(0, Math.max(a[1] - b[3], b[1] - a[3]));
    return Math.hypot(dx, dy);
  }

  function gapMetrics(selected, buildings, ignoreMeters) {
    const perBuilding = [];
    for (let a = 0; a < selected.length; a += 1) {
      const i = selected[a];
      const gi = buildings[i];
      let best = null;
      for (let b = 0; b < selected.length; b += 1) {
        if (a === b) continue;
        const j = selected[b];
        const gj = buildings[j];
        if (best !== null && bboxDistance(gi.bbox, gj.bbox) >= best) continue;
        const d = geometryDistance(gi.projected, gj.projected);
        if (d > ignoreMeters && (best === null || d < best)) best = d;
      }
      if (best !== null) perBuilding.push(best);
    }
    if (!perBuilding.length) return { minGap: null, avgGap: null };
    return { minGap: Math.min(...perBuilding), avgGap: mean(perBuilding) };
  }

  function classInfo(id) {
    return CONFIG.classes.find((c) => c.id === id) || CONFIG.classes[CONFIG.classes.length - 1];
  }

  function classForRatio(ratio) {
    if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
      return classInfo("no-data");
    }
    if (ratio < CONFIG.thresholds.ratioOpenMax) return classInfo("open");
    if (ratio < CONFIG.thresholds.ratioClosedMin) return classInfo("moderate");
    return classInfo("closed");
  }

  function ratioColor(ratio) {
    const cls = classForRatio(ratio);
    return CONFIG.ratioColors[cls.id] || CONFIG.ratioColors.unknown;
  }

  function styleColor(style) {
    if (style === CONFIG.unknownStyle.name) return CONFIG.unknownStyle.color;
    const p = CONFIG.stylePeriods.find((x) => x.name === style);
    return p ? p.color : CONFIG.unknownStyle.color;
  }

  function computePointMetrics(buildings, lon, lat) {
    const pt = projection.xy(lon, lat);
    const selected = [];
    for (let i = 0; i < buildings.length; i += 1) {
      const b = buildings[i];
      if (b.bbox[0] - CONFIG.bufferMeters > pt[0] ||
          b.bbox[2] + CONFIG.bufferMeters < pt[0] ||
          b.bbox[1] - CONFIG.bufferMeters > pt[1] ||
          b.bbox[3] + CONFIG.bufferMeters < pt[1]) {
        continue;
      }
      if (pointToGeometryDistance(pt, b.projected) <= CONFIG.bufferMeters + 1e-9) {
        selected.push(i);
      }
    }

    const total = selected.length;
    if (!total) {
      return {
        lon, lat, building_count: 0, indices: [],
        avg_height: null, max_height: null, min_height: null,
        level_range: null, min_gap: null, avg_gap: null, ratio: null,
        style_diversity: 0, dominant_style: null, dominant_share: null,
        unknown_style_share: null, diversity_status: "no-data",
        threat_periods: [], class_id: "no-data", class_label: classInfo("no-data").label,
        contrast: false, scenario_plus5_ratio: null, scenario_plus5_class_id: null,
        plus5_changes_class: false, scenario_expand10_ratio: null,
        scenario_expand10_class_id: null, error: "empty",
      };
    }

    const heights = selected.map((i) => buildings[i].props.height);
    const levels = selected.map((i) => buildings[i].props.levels);
    const styles = selected.map((i) => buildings[i].props.style);
    const unknownName = CONFIG.unknownStyle.name;
    const known = styles.filter((s) => s !== unknownName);

    const { minGap, avgGap } = gapMetrics(selected, buildings, CONFIG.minGapIgnoreMeters);

    const avgHeight = round(mean(heights), 2);
    const maxHeight = round(Math.max(...heights), 2);
    const minHeight = round(Math.min(...heights), 2);
    const levelRange = round(Math.max(...levels) - Math.min(...levels), 0);

    let ratio = null;
    if (avgHeight !== null && minGap !== null && minGap > 0) ratio = avgHeight / minGap;

    const counts = new Map();
    styles.forEach((s) => counts.set(s, (counts.get(s) || 0) + 1));
    const knownCounts = known.reduce((acc, s) => {
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});
    const unknownShare = (counts.get(unknownName) || 0) / total;
    const styleDiversity = Object.keys(knownCounts).length;

    let dominantStyle = null;
    let dominantShare = null;
    const ranked = Object.entries(knownCounts).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], "ru"));
    if (ranked.length) {
      const [topName, topCount] = ranked[0];
      const second = ranked.length > 1 ? ranked[1][1] : 0;
      dominantShare = topCount / total;
      if (dominantShare >= CONFIG.thresholds.dominantShareMin && topCount > second) {
        dominantStyle = topName;
      }
    }

    let diversityStatus = "diverse";
    if (unknownShare > CONFIG.thresholds.unknownStyleWarningShare) {
      diversityStatus = "insufficient";
    } else if (dominantStyle !== null) {
      diversityStatus = "homogeneous";
    }

    const threatPeriods = CONFIG.thresholds.specialThreatPeriods.filter((name) => {
      const c = counts.get(name) || 0;
      return total > 0 && c / total >= CONFIG.thresholds.dominantShareMin;
    });

    const cls = classForRatio(ratio);
    const contrast = levelRange >= CONFIG.thresholds.levelContrastMin;

    const floorHeight = CONFIG.scenario.floorHeightMeters;
    const plusFloors = CONFIG.thresholds.plusFloorsSearch;
    let plus5Ratio = null;
    let plus5Class = null;
    if (avgHeight !== null && minGap !== null && minGap > 0) {
      plus5Ratio = (avgHeight + plusFloors * floorHeight) / minGap;
      plus5Class = classForRatio(plus5Ratio).id;
    }
    let expandRatio = null;
    let expandClass = null;
    if (avgHeight !== null && minGap !== null) {
      expandRatio = avgHeight / (minGap + 10);
      expandClass = classForRatio(expandRatio).id;
    }

    return {
      lon, lat,
      building_count: total,
      indices: selected,
      avg_height: avgHeight,
      max_height: maxHeight,
      min_height: minHeight,
      level_range: levelRange,
      min_gap: round(minGap, 2),
      avg_gap: round(avgGap, 2),
      ratio: round(ratio, 4),
      style_diversity: styleDiversity,
      dominant_style: dominantStyle,
      dominant_share: round(dominantShare, 4),
      unknown_style_share: round(unknownShare, 4),
      diversity_status: diversityStatus,
      threat_periods: threatPeriods,
      class_id: cls.id,
      class_label: cls.label,
      contrast,
      scenario_plus5_ratio: round(plus5Ratio, 4),
      scenario_plus5_class_id: plus5Class,
      plus5_changes_class: plus5Class !== null && plus5Class !== cls.id,
      scenario_expand10_ratio: round(expandRatio, 4),
      scenario_expand10_class_id: expandClass,
      error: null,
    };
  }

  function scenarioResult(metrics, floors, gapMeters) {
    const height = floors * CONFIG.scenario.floorHeightMeters;
    const gap = Number(gapMeters);
    // Для стартового состояния («как есть») используем сохранённый ratio,
    // чтобы округление высоты и зазора не создавало фиктивного изменения.
    const isBaseline =
      metrics.avg_height !== null &&
      metrics.min_gap !== null &&
      Math.abs(height - metrics.avg_height) < 1e-6 &&
      Math.abs(gap - metrics.min_gap) < 1e-6;
    const ratio = isBaseline ? metrics.ratio : gap > 0 ? height / gap : null;
    const cls = classForRatio(ratio);
    return {
      floors,
      gap,
      height: round(height, 2),
      ratio: round(ratio, 4),
      class_id: cls.id,
      class_label: cls.label,
      delta_ratio: metrics.ratio !== null && ratio !== null ? round(ratio - metrics.ratio, 4) : null,
      class_changed: cls.id !== metrics.class_id,
    };
  }

  function interpret(metrics) {
    const tags = [];
    const errors = [];
    const th = CONFIG.thresholds;

    if (metrics.error === "empty") {
      errors.push(
        "В радиусе 100 м от точки не найдено зданий. Выберите точку в застроенной части острова."
      );
      return { tags, errors };
    }

    const cls = classInfo(metrics.class_id);
    tags.push({
      type: "class",
      title: cls.label,
      text: `ratio = avg_height / min_gap = ${formatNumber(metrics.avg_height, 1)} / ${formatNumber(metrics.min_gap, 1)} = ${formatNumber(metrics.ratio, 2)}`,
    });

    if (metrics.ratio === null) {
      errors.push(
        "Не удалось вычислить ratio: в буфере нет валидного зазора между контурами зданий (здания соприкасаются или их меньше двух)."
      );
    }

    if (metrics.contrast) {
      tags.push({
        type: "contrast",
        title: "Визуальный контраст силуэта",
        text: `Перепад этажности ${metrics.level_range} эт. ≥ ${th.levelContrastMin} эт.`,
      });
    }

    if (metrics.diversity_status === "diverse") {
      tags.push({
        type: "positive",
        title: "Позитивный фактор: среда стилистически разнообразна",
        text: `Нет стиля с долей ≥ ${Math.round(th.dominantShareMin * 100)}%; различных известных стилей: ${metrics.style_diversity}.`,
      });
    } else if (metrics.diversity_status === "homogeneous") {
      tags.push({
        type: "threat",
        title: "Угроза: среда гомогенна",
        text: `Доминирует «${metrics.dominant_style}» — ${(metrics.dominant_share * 100).toFixed(0)}% зданий в буфере.`,
      });
    } else if (metrics.diversity_status === "insufficient") {
      tags.push({
        type: "warning",
        title: "Недостаточно данных о стилях",
        text: `Доля зданий с неизвестным годом — ${(metrics.unknown_style_share * 100).toFixed(0)}%. Стилистические выводы ненадёжны.`,
      });
    }

    if (metrics.unknown_style_share !== null &&
        metrics.unknown_style_share > 0 &&
        metrics.unknown_style_share <= th.unknownStyleWarningShare) {
      tags.push({
        type: "warning",
        title: "Часть годов постройки неизвестна",
        text: `${(metrics.unknown_style_share * 100).toFixed(0)}% зданий в буфере имеют стиль «неизвестно»; они не участвуют в оценке разнообразия.`,
      });
    }

    metrics.threat_periods.forEach((period) => {
      tags.push({
        type: "threat",
        title: "Угроза: потенциально монотонная / типовая застройка",
        text: `≥ ${Math.round(th.dominantShareMin * 100)}% зданий относятся к периоду «${period}».`,
      });
    });

    return { tags, errors };
  }

  function formatNumber(value, digits) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    const d = digits === undefined ? 1 : digits;
    return Number(value).toLocaleString("ru-RU", {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  }

  function formatInt(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    return Number(value).toLocaleString("ru-RU");
  }

  global.CourtyardGeo = {
    CONFIG,
    LocalProjection,
    projection,
    projectGeometry,
    projectRing,
    pointInPolygon,
    pointToGeometryDistance,
    geometryDistance,
    bboxOfProjected,
    computePointMetrics,
    scenarioResult,
    gapMetrics,
    classForRatio,
    classInfo,
    ratioColor,
    styleColor,
    interpret,
    formatNumber,
    formatInt,
    round,
    clamp,
  };
})(window);
