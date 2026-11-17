/* Загрузка готовых GeoJSON и подготовка индекса зданий. */
(function (global) {
  "use strict";

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`Не удалось загрузить ${url}: HTTP ${response.status}`);
    }
    return response.json();
  }

  async function loadAppData(config, onProgress) {
    const report = (text) => {
      if (typeof onProgress === "function") onProgress(text);
    };

    report("Загружаю контуры зданий…");
    const buildingsGeo = await fetchJson(config.data.buildings);

    report("Загружаю опорные точки…");
    const referenceGeo = await fetchJson(config.data.referencePoints);

    report("Загружаю метаданные…");
    const metadata = await fetchJson(config.data.metadata);

    report("Загружаю границу острова…");
    const islandGeo = await fetchJson(config.data.island);

    if (!Array.isArray(buildingsGeo.features) || !buildingsGeo.features.length) {
      throw new Error("Файл buildings.geojson пуст или имеет неверный формат.");
    }

    const geo = global.CourtyardGeo;
    const buildings = [];
    for (const feature of buildingsGeo.features) {
      if (!feature.geometry) continue;
      const projected = geo.projectGeometry(feature.geometry);
      if (!projected) continue;
      const props = feature.properties || {};
      if (props.height === null || props.levels === null) continue;
      buildings.push({
        props,
        geometry: feature.geometry,
        projected,
        bbox: geo.bboxOfProjected(projected),
      });
    }

    if (!buildings.length) {
      throw new Error("Не удалось подготовить ни одного здания: проверьте поля height и levels.");
    }

    const referencePoints = (referenceGeo.features || [])
      .filter((f) => f.geometry && f.geometry.type === "Point")
      .map((f) => ({
        ...f,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
      }));

    return {
      buildingsGeo,
      referenceGeo,
      referencePoints,
      metadata,
      islandGeo,
      buildings,
      computeAt(lon, lat) {
        return geo.computePointMetrics(buildings, lon, lat);
      },
    };
  }

  global.CourtyardData = { loadAppData, fetchJson };
})(window);
