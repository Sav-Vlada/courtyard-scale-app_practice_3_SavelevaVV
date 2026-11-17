/* Приложение: состояние, карточка точки, режим «Что если», таблица и поиск. */
(function () {
  "use strict";

  const CONFIG = window.COURTYARD_CONFIG;
  const geo = window.CourtyardGeo;
  const STORAGE_KEY = "courtyard-scale-scenarios-v1";

  const $ = (id) => document.getElementById(id);

  const state = {
    data: null,
    map: null,
    mode: "baseline",
    selected: null,
    scenario: null,
    filters: {
      classId: "all",
      ratioMin: null,
      ratioMax: null,
      levelMin: null,
    },
    sort: { key: "ratio", dir: "desc" },
    page: 1,
    pageSize: 25,
    scenarios: [],
    find: { active: null },
  };

  const modeLabels = {
    baseline: "Исходное состояние",
    scenario: "Сценарий",
    delta: "Изменение",
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    setupStaticContent();
    bindGlobalEvents();

    try {
      const data = await window.CourtyardData.loadAppData(CONFIG, (text) => {
        $("loading-text").textContent = text;
      });
      state.data = data;
      setupMap(data);
      renderTable();
      loadScenarios();
      renderScenarioList();
      updateFreshness();
      $("loading-overlay").hidden = true;
      selectFromHash();
    } catch (error) {
      showFatal(error);
    }
  }

  // -------------------------------------------------------------------------
  // Статическое содержимое и обработчики
  // -------------------------------------------------------------------------

  function setupStaticContent() {
    $("app-version").textContent = `Версия ${CONFIG.app.version} · пороги и стили в app/config.js`;
    updateModeButtons();
    const list = $("about-thresholds");
    const th = CONFIG.thresholds;
    const items = [
      `ratio < ${th.ratioOpenMax} — открытый, слабо замкнутый двор.`,
      `${th.ratioOpenMax} ≤ ratio < ${th.ratioClosedMin} — умеренно замкнутый двор.`,
      `ratio ≥ ${th.ratioClosedMin} — замкнутый двор (колодец).`,
      `Перепад этажности ≥ ${th.levelContrastMin} эт. — метка «визуальный контраст силуэта».`,
      `Стиль ≥ ${Math.round(th.dominantShareMin * 100)}% зданий — доминирующий; иначе среда считается стилистически разнообразной.`,
      `Периоды «${th.specialThreatPeriods.join("» и «")}» при доле ≥ ${Math.round(th.dominantShareMin * 100)}% дают отдельную метку угрозы.`,
    ];
    list.innerHTML = items.map((t) => `<li>${escapeHtml(t)}</li>`).join("");

    const periodList = document.createElement("div");
    periodList.className = "formula-box";
    periodList.innerHTML = `<strong>Периодизация стилей</strong><ul>${CONFIG.stylePeriods
      .map((p) => `<li>${escapeHtml(p.name)}: ${p.from}–${p.to}</li>`)
      .join("")}<li>неизвестно — год отсутствует или вне 1703–2026</li></ul>`;
    $("about-thresholds").after(periodList);
  }

  function bindGlobalEvents() {
    document.querySelectorAll("[data-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!state.selected) return;
        setMode(button.dataset.mode);
      });
    });

    $("about-open").addEventListener("click", () => {
      const dialog = $("about-dialog");
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    });
    $("about-close").addEventListener("click", () => $("about-dialog").close());
    $("about-dialog").addEventListener("click", (event) => {
      if (event.target === $("about-dialog")) $("about-dialog").close();
    });

    $("btn-what-if").addEventListener("click", () => {
      setMode("scenario");
      $("scenario-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    $("scenario-height").addEventListener("input", updateScenarioFromControls);
    $("scenario-gap").addEventListener("input", updateScenarioFromControls);
    $("scenario-reset").addEventListener("click", () => {
      resetScenarioToBase();
      renderScenarioPanel();
    });
    $("scenario-save").addEventListener("click", saveCurrentScenario);
    $("scenarios-clear").addEventListener("click", clearScenarios);

    $("show-reference").addEventListener("change", (event) => {
      if (state.map) state.map.setReferenceVisibility(event.target.checked);
    });
    $("fit-island").addEventListener("click", () => {
      if (state.map) state.map.fitIsland();
    });

    $("export-csv").addEventListener("click", exportCsv);
    $("filter-class").addEventListener("change", (event) => {
      state.filters.classId = event.target.value;
      state.page = 1;
      renderTable();
    });
    ["ratio-min", "ratio-max", "level-min"].forEach((suffix) => {
      $(`filter-${suffix}`).addEventListener("input", () => {
        state.filters.ratioMin = numberOrNull($("filter-ratio-min").value);
        state.filters.ratioMax = numberOrNull($("filter-ratio-max").value);
        state.filters.levelMin = numberOrNull($("filter-level-min").value);
        state.page = 1;
        renderTable();
      });
    });
    $("filters-reset").addEventListener("click", () => {
      state.filters = { classId: "all", ratioMin: null, ratioMax: null, levelMin: null };
      $("filter-class").value = "all";
      $("filter-ratio-min").value = "";
      $("filter-ratio-max").value = "";
      $("filter-level-min").value = "";
      state.page = 1;
      renderTable();
    });

    document.querySelectorAll("[data-find]").forEach((button) => {
      button.addEventListener("click", () => runFind(button.dataset.find));
    });

    document.querySelectorAll("#points-table th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sort.key === key) {
          state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
        } else {
          state.sort = { key, dir: key === "id" || key === "dominant_style" || key === "class_id" ? "asc" : "desc" };
        }
        state.page = 1;
        renderTable();
      });
    });

    $("scenario-label").addEventListener("keydown", (event) => {
      if (event.key === "Enter") saveCurrentScenario();
    });
  }

  // -------------------------------------------------------------------------
  // Карта и выбор точки
  // -------------------------------------------------------------------------

  function setupMap(data) {
    state.map = new window.CourtyardMap($("map"), {
      onMapClick: (lon, lat) => selectPoint(lon, lat, { mode: state.mode }),
      onReferenceClick: (rp) => openReference(rp, false),
      onTileError: () => {
        showMapStatus(
          "Тайлы OpenStreetMap недоступны. Контуры зданий и все расчёты продолжают работать офлайн; подложка карты может не отображаться."
        );
      },
    }).init(data.islandGeo);

    state.map.setBuildings(data.buildings);
    state.map.setReferencePoints(data.referencePoints);
    state.map.setReferenceVisibility($("show-reference").checked);
  }

  function selectPoint(lon, lat, options) {
    const opts = options || {};
    if (!state.data) return;
    const metrics = state.data.computeAt(lon, lat);
    state.selected = {
      lon,
      lat,
      metrics,
      ref: opts.ref || null,
      refId: opts.ref ? opts.ref.properties.id : null,
    };
    state.map.select(lon, lat);
    if (opts.ref) state.map.highlightReference(lon, lat);
    else state.map.clearHighlight();
    initScenarioFromMetrics(metrics);
    if (opts.mode) state.mode = opts.mode;
    updateModeButtons();
    applyMode();

    if (location.hash !== `#p=${lat.toFixed(6)},${lon.toFixed(6)}`) {
      history.replaceState(null, "", `#p=${lat.toFixed(6)},${lon.toFixed(6)}`);
    }
  }

  function openReference(rp, goToScenario) {
    if (!rp) return;
    if (goToScenario) {
      selectPoint(rp.lon, rp.lat, { ref: rp, mode: "scenario" });
    } else {
      selectPoint(rp.lon, rp.lat, { ref: rp, mode: "baseline" });
    }
    state.map.panTo(rp.lon, rp.lat);
  }

  function selectFromHash() {
    const match = /#p=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(location.hash || "");
    if (!match) return;
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      selectPoint(lon, lat, { mode: "baseline" });
    }
  }

  function showMapStatus(text) {
    const el = $("map-status");
    el.textContent = text;
    el.hidden = false;
  }

  // -------------------------------------------------------------------------
  // Режимы и карточка
  // -------------------------------------------------------------------------

  function setMode(mode) {
    if (!modeLabels[mode] || !state.selected) return;
    state.mode = mode;
    updateModeButtons();
    applyMode();
  }

  function updateModeButtons() {
    document.querySelectorAll("[data-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === state.mode);
      button.disabled = !state.selected;
      button.title = state.selected ? "" : "Сначала выберите точку на карте";
    });
  }

  function applyMode() {
    const hasPoint = Boolean(state.selected);
    $("empty-card").hidden = hasPoint || !state.data;
    $("point-card").hidden = !hasPoint;
    if (!hasPoint) {
      $("scenario-panel").hidden = true;
      $("delta-panel").hidden = true;
      if (state.map) state.map.setScenario(null, false);
      return;
    }

    const metrics = state.selected.metrics;
    const canScenario = metrics.avg_height !== null && metrics.min_gap !== null;
    const scenarioMode = state.mode === "scenario" || state.mode === "delta";

    renderPointCard();

    $("scenario-panel").hidden = !scenarioMode || !canScenario;
    $("delta-panel").hidden = state.mode !== "delta" || !canScenario;

    if (scenarioMode && canScenario) {
      renderScenarioPanel();
      renderDeltaPanel();
    } else if (state.mode === "delta" && !canScenario) {
      $("delta-panel").hidden = false;
      $("delta-content").innerHTML =
        '<div class="inline-error">Для этой точки нельзя построить сценарий: в буфере нет валидного зазора или данных о высоте.</div>';
    }

    if (state.map) {
      const active = scenarioMode && canScenario;
      state.map.setScenario(active ? metrics.indices : null, active);
    }
  }

  function renderPointCard() {
    const sel = state.selected;
    const m = sel.metrics;
    const cls = geo.classInfo(m.class_id);

    $("point-source").textContent = sel.ref
      ? `Опорная точка ${sel.ref.properties.id}`
      : "Точка на карте";
    $("point-title").textContent = sel.ref ? `Двор ${sel.ref.properties.id}` : "Двор у точки";
    $("point-coords").textContent =
      `${geo.formatNumber(sel.lat, 5)}° с.ш. · ${geo.formatNumber(sel.lon, 5)}° в.д.`;

    const badge = $("point-class-badge");
    badge.textContent = cls.label;
    badge.dataset.class = cls.id;

    const marker = $("ratio-marker");
    if (m.ratio === null) {
      marker.style.display = "none";
    } else {
      marker.style.display = "";
      marker.style.left = `${Math.min(100, Math.max(0, (m.ratio / 2) * 100))}%`;
    }

    const tiles = [
      ["Средняя высота", geo.formatNumber(m.avg_height, 1), "м"],
      ["Макс. высота", geo.formatNumber(m.max_height, 1), "м"],
      ["Мин. высота", geo.formatNumber(m.min_height, 1), "м"],
      ["Перепад этажности", geo.formatInt(m.level_range), "эт."],
      ["Мин. зазор", geo.formatNumber(m.min_gap, 1), "м"],
      ["Средний зазор", geo.formatNumber(m.avg_gap, 1), "м"],
      ["ratio", geo.formatNumber(m.ratio, 2), ""],
      ["Различных стилей", geo.formatInt(m.style_diversity), ""],
    ];
    const grid = $("point-metrics");
    grid.innerHTML = tiles.map(([label, value, unit]) => metricHtml(label, value, unit)).join("") +
      `<div class="metric wide"><span class="metric-label">Доминирующий стиль</span>
        <span class="metric-value text-value">${escapeHtml(m.dominant_style || "нет (нет стиля ≥ 50%)")}</span></div>` +
      `<div class="metric wide"><span class="metric-label">Зданий в буфере · доля с неизвестным годом</span>
        <span class="metric-value text-value">${geo.formatInt(m.building_count)} · ${m.unknown_style_share === null ? "—" : `${(m.unknown_style_share * 100).toFixed(0)}%`}</span></div>`;

    const interpretation = geo.interpret(m);
    const tags = $("point-interpretation");
    tags.innerHTML = interpretation.tags.map((tag) =>
      `<div class="tag ${tag.type}"><strong>${escapeHtml(tag.title)}</strong><p>${escapeHtml(tag.text)}</p></div>`
    ).join("");

    const errors = $("point-errors");
    const allErrors = interpretation.errors.slice();
    if (m.error === "empty") {
      allErrors.unshift("В радиусе 100 м от точки не найдено зданий.");
    }
    errors.hidden = !allErrors.length;
    errors.innerHTML = allErrors.map((e) => `<div>${escapeHtml(e)}</div>`).join("");

    $("point-formula").innerHTML = `
      <p><strong>ratio</strong> = avg_height / min_gap =
      ${geo.formatNumber(m.avg_height, 1)} / ${geo.formatNumber(m.min_gap, 1)} =
      ${geo.formatNumber(m.ratio, 2)}.</p>
      <ul>
        ${CONFIG.classes
          .filter((c) => c.id !== "no-data")
          .map((c) => `<li><strong>${escapeHtml(c.label)}</strong>: ${escapeHtml(c.condition)}</li>`)
          .join("")}
      </ul>
      <p>Перепад этажности: max(levels) − min(levels) = ${geo.formatInt(m.level_range)} эт.
      Метка контраста ставится при перепаде ≥ ${CONFIG.thresholds.levelContrastMin} эт.</p>
      <p>Стили: ${geo.formatInt(m.style_diversity)} различных известных стилей;
      доминирующий — при доле ≥ ${Math.round(CONFIG.thresholds.dominantShareMin * 100)}%.
      Доля «неизвестно» — ${m.unknown_style_share === null ? "—" : `${(m.unknown_style_share * 100).toFixed(0)}%`};
      при доле выше ${Math.round(CONFIG.thresholds.unknownStyleWarningShare * 100)}% выводы о стилях помечаются как ненадёжные.</p>
      <p>Зазор — кратчайшее расстояние между контурами; пары ближе
      ${geo.formatNumber(CONFIG.minGapIgnoreMeters, 1)} м считаются соприкасающимися.</p>`;

    $("btn-what-if").disabled = !(m.avg_height !== null && m.min_gap !== null);
    $("point-source-note").textContent =
      `Учтено ${m.building_count} зданий в радиусе ${CONFIG.bufferMeters} м.`;
  }

  function metricHtml(label, value, unit) {
    return `<div class="metric">
      <span class="metric-label">${escapeHtml(label)}</span>
      <span class="metric-value">${escapeHtml(value)}${unit ? `<span class="metric-unit"> ${escapeHtml(unit)}</span>` : ""}</span>
    </div>`;
  }

  // -------------------------------------------------------------------------
  // Сценарий
  // -------------------------------------------------------------------------

  function scenarioBaselineValues() {
    const s = state.scenario;
    // «Как есть» должно воспроизводить реальные метрики точки, а не округлённые
    // значения ползунка. Если реальное значение вне диапазона, используем
    // ограниченное, о чём предупреждает панель сценария.
    return {
      floors:
        s.rawFloors >= CONFIG.scenario.heightFloorsMin && s.rawFloors <= CONFIG.scenario.heightFloorsMax
          ? s.rawFloors
          : s.baseFloors,
      gap:
        s.rawGap >= CONFIG.scenario.gapMetersMin && s.rawGap <= CONFIG.scenario.gapMetersMax
          ? s.rawGap
          : s.baseGap,
    };
  }

  function initScenarioFromMetrics(metrics) {
    const floorHeight = CONFIG.scenario.floorHeightMeters;
    const rawFloors = metrics.avg_height !== null ? metrics.avg_height / floorHeight : 5;
    const rawGap = metrics.min_gap !== null ? metrics.min_gap : 20;
    const baseFloors = geo.clamp(rawFloors, CONFIG.scenario.heightFloorsMin, CONFIG.scenario.heightFloorsMax);
    const baseGap = geo.clamp(rawGap, CONFIG.scenario.gapMetersMin, CONFIG.scenario.gapMetersMax);
    state.scenario = {
      rawFloors,
      rawGap,
      baseFloors,
      baseGap,
      floors: baseFloors,
      gap: baseGap,
    };
    const baseline = scenarioBaselineValues();
    state.scenario.floors = baseline.floors;
    state.scenario.gap = baseline.gap;
  }

  function resetScenarioToBase() {
    if (!state.scenario) return;
    const baseline = scenarioBaselineValues();
    state.scenario.floors = baseline.floors;
    state.scenario.gap = baseline.gap;
  }

  function renderScenarioPanel() {
    if (!state.selected || !state.scenario) return;
    const m = state.selected.metrics;
    const s = state.scenario;
    const floorHeight = CONFIG.scenario.floorHeightMeters;
    const baseHeight = s.baseFloors * floorHeight;
    const baseClass = geo.classInfo(m.class_id);

    $("scenario-baseline-line").textContent =
      `Исходно: ${geo.formatNumber(m.avg_height, 1)} м · ${geo.formatNumber(m.min_gap, 1)} м · ratio ${geo.formatNumber(m.ratio, 2)} · ${baseClass.short}.`;

    const warning = $("scenario-warning");
    const warnings = [];
    if (s.rawFloors < CONFIG.scenario.heightFloorsMin || s.rawFloors > CONFIG.scenario.heightFloorsMax) {
      warnings.push(
        `Реальная средняя высота ${geo.formatNumber(s.rawFloors, 1)} эт. вне диапазона слайдера ` +
        `${CONFIG.scenario.heightFloorsMin}–${CONFIG.scenario.heightFloorsMax}; стартовое значение ограничено.`
      );
    }
    if (s.rawGap < CONFIG.scenario.gapMetersMin || s.rawGap > CONFIG.scenario.gapMetersMax) {
      warnings.push(
        `Реальный зазор ${geo.formatNumber(s.rawGap, 1)} м вне диапазона слайдера ` +
        `${CONFIG.scenario.gapMetersMin}–${CONFIG.scenario.gapMetersMax} м; стартовое значение ограничено.`
      );
    }
    warning.hidden = !warnings.length;
    warning.innerHTML = warnings.map((w) => `<div>${escapeHtml(w)}</div>`).join("");

    const heightInput = $("scenario-height");
    const gapInput = $("scenario-gap");
    heightInput.min = CONFIG.scenario.heightFloorsMin;
    heightInput.max = CONFIG.scenario.heightFloorsMax;
    gapInput.min = CONFIG.scenario.gapMetersMin;
    gapInput.max = CONFIG.scenario.gapMetersMax;
    heightInput.value = s.floors;
    gapInput.value = s.gap;

    $("scenario-height-value").textContent =
      `${geo.formatNumber(s.floors, 1)} эт. · ${geo.formatNumber(s.floors * floorHeight, 1)} м`;
    $("scenario-gap-value").textContent = `${geo.formatNumber(s.gap, 1)} м`;

    renderPresets();
    renderScenarioOutputs();
  }

  function renderPresets() {
    const row = $("preset-row");
    row.innerHTML = "";
    CONFIG.scenario.presets.forEach((preset) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = preset.label;
      button.addEventListener("click", () => {
        const s = state.scenario;
        const baseline = scenarioBaselineValues();
        const useBaseline = preset.id === "as-is";
        s.floors = geo.clamp(
          (useBaseline ? baseline.floors : s.baseFloors) + (preset.floorsDelta || 0),
          CONFIG.scenario.heightFloorsMin,
          CONFIG.scenario.heightFloorsMax
        );
        s.gap = geo.clamp(
          (useBaseline ? baseline.gap : s.baseGap) + (preset.gapDelta || 0),
          CONFIG.scenario.gapMetersMin,
          CONFIG.scenario.gapMetersMax
        );
        renderScenarioPanel();
      });
      row.appendChild(button);
    });
  }

  function updateScenarioFromControls() {
    if (!state.scenario) return;
    const s = state.scenario;
    s.floors = Number($("scenario-height").value);
    s.gap = Number($("scenario-gap").value);
    $("scenario-height-value").textContent =
      `${geo.formatNumber(s.floors, 1)} эт. · ${geo.formatNumber(s.floors * CONFIG.scenario.floorHeightMeters, 1)} м`;
    $("scenario-gap-value").textContent = `${geo.formatNumber(s.gap, 1)} м`;
    renderScenarioOutputs();
    if (state.mode === "delta") renderDeltaPanel();
  }

  function renderScenarioOutputs() {
    if (!state.selected || !state.scenario) return;
    const m = state.selected.metrics;
    const result = geo.scenarioResult(m, state.scenario.floors, state.scenario.gap);
    const cls = geo.classInfo(result.class_id);
    const deltaText = result.delta_ratio === null
      ? "—"
      : `${result.delta_ratio > 0 ? "+" : result.delta_ratio < 0 ? "−" : ""}${geo.formatNumber(Math.abs(result.delta_ratio), 2)}`;

    $("scenario-result").innerHTML = `
      <div class="metric">
        <span class="metric-label">Новый ratio</span>
        <span class="metric-value">${geo.formatNumber(result.ratio, 2)}</span>
      </div>
      <div class="metric">
        <span class="metric-label">Класс сценария</span>
        <span class="class-badge" data-class="${cls.id}">${escapeHtml(cls.label)}</span>
      </div>
      <div class="metric wide">
        <span class="metric-label">Высота / зазор</span>
        <span class="metric-value text-value">${geo.formatNumber(result.height, 1)} м / ${geo.formatNumber(result.gap, 1)} м
        <span class="metric-unit">Δ ratio ${deltaText}</span></span>
      </div>`;

    $("scenario-section").innerHTML = sectionSvg(m, result);
  }

  function sectionSvg(metrics, result) {
    const floorHeight = CONFIG.scenario.floorHeightMeters;
    const baseHeight = state.scenario.baseFloors * floorHeight;
    const baseGap = state.scenario.baseGap;
    const scHeight = result.height;
    const scGap = result.gap;
    const maxHeight = Math.max(baseHeight, scHeight, 6);
    const groundY = 116;
    const heightScale = 74 / maxHeight;
    const baseH = baseHeight * heightScale;
    const scH = scHeight * heightScale;
    const gapPx = 18 + (Math.min(scGap, 80) / 80) * 46;
    const baseGapPx = 18 + (Math.min(baseGap, 80) / 80) * 46;
    const width = 36;
    const center = 162;
    const xL = center - gapPx / 2 - width;
    const xR = center + gapPx / 2;
    const baseXl = center - baseGapPx / 2 - width;
    const baseXr = center + baseGapPx / 2;

    function building(x, h, fill, extra) {
      return `<rect x="${x.toFixed(1)}" y="${(groundY - h).toFixed(1)}" width="${width}" height="${h.toFixed(1)}" rx="2" fill="${fill}" ${extra}/>`;
    }

    return `
    <svg viewBox="0 0 324 150" role="img" aria-label="Разрез было стало: высота ${geo.formatNumber(baseHeight, 1)} метров, зазор ${geo.formatNumber(baseGap, 1)} метров; сценарий: высота ${geo.formatNumber(scHeight, 1)} метров, зазор ${geo.formatNumber(scGap, 1)} метров">
      <defs>
        <marker id="arrow" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" fill="#8b8375"></path>
        </marker>
      </defs>
      <line x1="8" y1="${groundY}" x2="316" y2="${groundY}" stroke="#8b8375" stroke-width="1.5"></line>
      <rect x="8" y="${groundY - 2}" width="308" height="6" fill="#e8e1d4"></rect>

      <!-- исходное состояние -->
      ${building(baseXl, baseH, "none", `stroke="#a39a8b" stroke-width="1.4" stroke-dasharray="4 3"`)}
      ${building(baseXr, baseH, "none", `stroke="#a39a8b" stroke-width="1.4" stroke-dasharray="4 3"`)}
      <line x1="${(baseXl + width).toFixed(1)}" y1="${groundY - 8}" x2="${baseXr.toFixed(1)}" y2="${groundY - 8}" stroke="#a39a8b" stroke-width="1" stroke-dasharray="3 3"></line>
      <text x="${center}" y="${groundY - 11}" text-anchor="middle" font-size="8" fill="#8b8375">было: ${geo.formatNumber(baseGap, 1)} м</text>

      <!-- сценарий -->
      ${building(xL, scH, "#2f6f6a", `fill-opacity="0.82"`)}
      ${building(xR, scH, "#2f6f6a", `fill-opacity="0.82"`)}
      <text x="${xL + width / 2}" y="${(groundY - scH - 5).toFixed(1)}" text-anchor="middle" font-size="8.5" fill="#1f4e5a">${geo.formatNumber(scHeight, 1)} м</text>
      <text x="${xR + width / 2}" y="${(groundY - scH - 5).toFixed(1)}" text-anchor="middle" font-size="8.5" fill="#1f4e5a">${geo.formatNumber(scHeight, 1)} м</text>

      <line x1="${(xL + width + 3).toFixed(1)}" y1="132" x2="${(xR - 3).toFixed(1)}" y2="132" stroke="#2f6f6a" stroke-width="1.2" marker-start="url(#arrow)" marker-end="url(#arrow)"></line>
      <text x="${center}" y="145" text-anchor="middle" font-size="8.5" fill="#1f4e5a">стало: зазор ${geo.formatNumber(scGap, 1)} м</text>
      <text x="10" y="12" font-size="8" fill="#8b8375">пунктир — было</text>
      <text x="314" y="12" text-anchor="end" font-size="8" fill="#2f6f6a">заливка — сценарий</text>
    </svg>`;
  }

  function renderDeltaPanel() {
    if (!state.selected || !state.scenario) return;
    const m = state.selected.metrics;
    const result = geo.scenarioResult(m, state.scenario.floors, state.scenario.gap);
    const baseCls = geo.classInfo(m.class_id);
    const scCls = geo.classInfo(result.class_id);
    const floorHeight = CONFIG.scenario.floorHeightMeters;

    const rows = [
      {
        label: "Высота",
        before: `${geo.formatNumber(m.avg_height, 1)} м`,
        after: `${geo.formatNumber(result.height, 1)} м`,
        change: m.avg_height === null ? null : result.height - m.avg_height,
        unit: "м",
        invert: true,
      },
      {
        label: "Мин. зазор",
        before: `${geo.formatNumber(m.min_gap, 1)} м`,
        after: `${geo.formatNumber(result.gap, 1)} м`,
        change: m.min_gap === null ? null : result.gap - m.min_gap,
        unit: "м",
        invert: false,
      },
      {
        label: "ratio",
        before: geo.formatNumber(m.ratio, 2),
        after: geo.formatNumber(result.ratio, 2),
        change: result.delta_ratio,
        unit: "",
        invert: true,
      },
    ];

    const rowsHtml = rows.map((row) => {
      const cls = row.change === null
        ? "delta-neutral"
        : row.change > 0
          ? (row.invert ? "delta-positive" : "delta-negative")
          : row.change < 0
            ? (row.invert ? "delta-negative" : "delta-positive")
            : "delta-neutral";
      const change = row.change === null
        ? "—"
        : `${row.change > 0 ? "+" : row.change < 0 ? "−" : ""}${geo.formatNumber(Math.abs(row.change), row.unit ? 1 : 2)}`;
      return `<div class="delta-row">
        <span class="delta-label">${escapeHtml(row.label)}</span>
        <span class="delta-values">${escapeHtml(row.before)} → ${escapeHtml(row.after)}</span>
        <span class="delta-change ${cls}">${change}</span>
      </div>`;
    }).join("");

    const classChange = baseCls.id === scCls.id
      ? `<span class="delta-neutral">без изменения</span>`
      : `<span class="delta-positive">смена класса</span>`;

    $("delta-content").innerHTML = `
      <div class="delta-grid">
        ${rowsHtml}
        <div class="delta-row">
          <span class="delta-label">Класс</span>
          <span class="delta-values">${escapeHtml(baseCls.short)} → ${escapeHtml(scCls.short)}</span>
          <span class="delta-change">${classChange}</span>
        </div>
        <div class="delta-row">
          <span class="delta-label">Перепад этажности</span>
          <span class="delta-values">${geo.formatInt(m.level_range)} эт. → ${geo.formatInt(m.level_range)} эт.</span>
          <span class="delta-change delta-neutral">не меняется</span>
        </div>
        <div class="delta-row">
          <span class="delta-label">Стили</span>
          <span class="delta-values">${geo.formatInt(m.style_diversity)} → ${geo.formatInt(m.style_diversity)}</span>
          <span class="delta-change delta-neutral">не меняется</span>
        </div>
      </div>
      <p class="delta-note">Сценарий меняет только два параметра: высоту (${geo.formatNumber(state.scenario.floors, 1)} эт. ×
      ${floorHeight} м) и расстояние. Контуры зданий, перепад этажности и стили остаются исходными;
      это аналитический «что если», а не проектное предложение.</p>`;
  }

  // -------------------------------------------------------------------------
  // Таблица опорных точек
  // -------------------------------------------------------------------------

  function filteredSortedPoints() {
    if (!state.data) return [];
    const f = state.filters;
    let rows = state.data.referencePoints.filter((rp) => {
      const p = rp.properties;
      if (f.classId !== "all" && p.class_id !== f.classId) return false;
      if (f.ratioMin !== null && (p.ratio === null || p.ratio < f.ratioMin)) return false;
      if (f.ratioMax !== null && (p.ratio === null || p.ratio > f.ratioMax)) return false;
      if (f.levelMin !== null && (p.level_range === null || p.level_range < f.levelMin)) return false;
      return true;
    });

    const key = state.sort.key;
    const dir = state.sort.dir === "asc" ? 1 : -1;
    const classOrder = Object.fromEntries(CONFIG.classes.map((c, i) => [c.id, i]));
    rows.sort((a, b) => {
      let va = a.properties[key];
      let vb = b.properties[key];
      if (key === "class_id") {
        va = classOrder[va] ?? 99;
        vb = classOrder[vb] ?? 99;
      }
      if (va === null || va === undefined) return vb === null || vb === undefined ? 0 : 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb), "ru") * dir;
    });
    return rows;
  }

  function renderTable() {
    if (!state.data) return;
    const rows = filteredSortedPoints();
    const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;
    const start = (state.page - 1) * state.pageSize;
    const pageRows = rows.slice(start, start + state.pageSize);

    document.querySelectorAll("#points-table th[data-sort]").forEach((th) => {
      th.dataset.dir = th.dataset.sort === state.sort.key ? state.sort.dir : "";
    });

    const tbody = $("points-tbody");
    tbody.innerHTML = "";
    const fragment = document.createDocumentFragment();
    pageRows.forEach((rp) => fragment.appendChild(pointRow(rp)));
    tbody.appendChild(fragment);

    $("table-empty").hidden = rows.length !== 0;
    $("table-empty").textContent = rows.length
      ? ""
      : "Нет точек, удовлетворяющих фильтрам. Сбросьте фильтры или измените диапазон ratio.";
    $("table-count").textContent = rows.length
      ? `${geo.formatInt(rows.length)} точек · стр. ${state.page} из ${totalPages}`
      : "0 точек";

    renderPagination(rows.length, totalPages);
  }

  function pointRow(rp) {
    const p = rp.properties;
    const cls = geo.classInfo(p.class_id);
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    tr.dataset.id = p.id;
    tr.title = "Открыть точку в режиме «Что если»";

    const cells = [
      ["td", "id-cell", p.id],
      ["td", "coords-cell", `${geo.formatNumber(rp.lat, 5)}, ${geo.formatNumber(rp.lon, 5)}`],
      ["td", "numeric", geo.formatNumber(p.avg_height, 1)],
      ["td", "numeric", geo.formatNumber(p.min_gap, 1)],
      ["td", "numeric", geo.formatNumber(p.ratio, 2)],
      ["td", "class-cell", null],
      ["td", "numeric", geo.formatInt(p.level_range)],
      ["td", "numeric", geo.formatInt(p.style_diversity)],
      ["td", "style-cell", p.dominant_style || "—"],
    ];

    cells.forEach(([tag, className, value]) => {
      const td = document.createElement(tag);
      td.className = className;
      if (className === "class-cell") {
        const badge = document.createElement("span");
        badge.className = "class-badge";
        badge.dataset.class = cls.id;
        badge.textContent = cls.short;
        td.appendChild(badge);
      } else {
        td.textContent = value;
      }
      tr.appendChild(td);
    });

    const open = () => openReference(rp, true);
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    return tr;
  }

  function renderPagination(totalRows, totalPages) {
    const nav = $("pagination");
    nav.innerHTML = "";
    if (totalRows <= state.pageSize) return;

    const addButton = (label, page, options) => {
      const opts = options || {};
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      if (opts.active) button.classList.add("active");
      button.disabled = Boolean(opts.disabled);
      button.addEventListener("click", () => {
        state.page = page;
        renderTable();
        $("points-title").scrollIntoView({ behavior: "smooth", block: "start" });
      });
      nav.appendChild(button);
    };

    addButton("←", state.page - 1, { disabled: state.page === 1 });
    const pages = new Set([1, totalPages, state.page - 1, state.page, state.page + 1]);
    let previous = 0;
    Array.from(pages).filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b).forEach((page) => {
      if (previous && page - previous > 1) {
        const span = document.createElement("span");
        span.className = "pagination-info";
        span.textContent = "…";
        nav.appendChild(span);
      }
      addButton(String(page), page, { active: page === state.page });
      previous = page;
    });
    addButton("→", state.page + 1, { disabled: state.page === totalPages });
  }

  function updateFreshness() {
    if (!state.data) return;
    const md = state.data.metadata;
    const date = md.generated_at ? new Date(md.generated_at).toLocaleDateString("ru-RU") : "—";
    $("data-freshness").textContent =
      `Данные: ${date} · ${geo.formatInt(md.counts.buildings)} зданий · ${geo.formatInt(md.counts.reference_points)} точек`;
  }

  // -------------------------------------------------------------------------
  // CSV
  // -------------------------------------------------------------------------

  function exportCsv() {
    const rows = filteredSortedPoints();
    if (!rows.length) {
      $("table-count").textContent = "Нет данных для экспорта — измените фильтры";
      return;
    }
    const header = [
      "id", "lat", "lon", "avg_height_m", "max_height_m", "min_height_m",
      "level_range", "min_gap_m", "avg_gap_m", "ratio", "class_id", "class_label",
      "style_diversity", "dominant_style", "dominant_share", "unknown_style_share",
      "building_count", "plus5_class_id", "plus5_changes_class",
    ];
    const lines = [header.join(";")];
    rows.forEach((rp) => {
      const p = rp.properties;
      const values = [
        p.id, rp.lat, rp.lon, p.avg_height, p.max_height, p.min_height,
        p.level_range, p.min_gap, p.avg_gap, p.ratio, p.class_id, p.class_label,
        p.style_diversity, p.dominant_style || "", p.dominant_share, p.unknown_style_share,
        p.building_count, p.scenario_plus5_class_id || "", p.plus5_changes_class ? "true" : "false",
      ];
      lines.push(values.map(csvCell).join(";"));
    });
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const today = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `dvory_vasilievsky_${today}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    const note = $("table-count");
    const previous = note.textContent;
    note.textContent = `Экспортировано ${geo.formatInt(rows.length)} строк (с учётом фильтра)`;
    setTimeout(() => { note.textContent = previous; }, 4000);
  }

  function csvCell(value) {
    if (value === null || value === undefined) return "";
    const text = String(value);
    if (/[;"\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  // -------------------------------------------------------------------------
  // Автопоиск
  // -------------------------------------------------------------------------

  function runFind(kind) {
    if (!state.data) return;
    const points = state.data.referencePoints.slice();
    let rows = [];
    let title = "";
    let note = "";

    if (kind === "top-ratio") {
      rows = points.filter((rp) => rp.properties.ratio !== null)
        .sort((a, b) => b.properties.ratio - a.properties.ratio)
        .slice(0, 10);
      title = "Топ-10 по замкнутости (ratio)";
      note = "Сортировка по убыванию avg_height / min_gap. Точки с невалидным зазором исключены.";
    } else if (kind === "level-range") {
      rows = points.filter((rp) => rp.properties.level_range >= 5)
        .sort((a, b) => (b.properties.level_range - a.properties.level_range) ||
          ((b.properties.ratio ?? -1) - (a.properties.ratio ?? -1)));
      title = "Дворы с перепадом этажности ≥ 5";
      note = `Найдено ${geo.formatInt(rows.length)} точек; показаны первые ${Math.min(50, rows.length)}.`;
      rows = rows.slice(0, 50);
    } else if (kind === "plus5") {
      rows = points.filter((rp) => rp.properties.plus5_changes_class)
        .sort((a, b) => (b.properties.ratio ?? -1) - (a.properties.ratio ?? -1));
      title = "Дворы, где +5 этажей меняет класс";
      note = `Сценарий: avg_height + 5 × ${CONFIG.scenario.floorHeightMeters} м при неизменном min_gap. ` +
        `Найдено ${geo.formatInt(rows.length)} точек; показаны первые ${Math.min(50, rows.length)}.`;
      rows = rows.slice(0, 50);
    } else if (kind === "low-diversity") {
      rows = points.filter((rp) => rp.properties.ratio !== null)
        .sort((a, b) => (a.properties.style_diversity - b.properties.style_diversity) ||
          ((b.properties.dominant_share ?? 0) - (a.properties.dominant_share ?? 0)) ||
          ((a.properties.unknown_style_share ?? 1) - (b.properties.unknown_style_share ?? 1)))
        .slice(0, 10);
      title = "Дворы с минимальным разнообразием стилей";
      note = "Сортировка: меньше различных известных стилей, затем выше доля доминирующего стиля. " +
        "Проверяйте долю «неизвестно»: она может искажать вывод.";
    }

    state.find = { active: kind, rows, title, note };
    document.querySelectorAll("[data-find]").forEach((button) => {
      button.classList.toggle("active", button.dataset.find === kind);
    });
    renderFindResults();
  }

  function renderFindResults() {
    const out = $("find-output");
    const result = state.find;
    if (!result.rows || !result.rows.length) {
      out.innerHTML = `<div class="find-summary"><strong>${escapeHtml(result.title || "Поиск")}</strong></div>
        <p class="muted">Ничего не найдено для этого запроса. Это нормальный результат: условию не удовлетворяет ни одна опорная точка.</p>`;
      return;
    }

    const table = document.createElement("table");
    table.className = "find-table";
    table.innerHTML = `
      <thead><tr>
        <th>ID</th><th>Координаты</th><th class="numeric">ratio</th><th>Класс</th>
        <th class="numeric">Перепад</th><th class="numeric">Стилей</th>
        <th>Доминирующий стиль</th><th>+5 этажей</th>
      </tr></thead>`;
    const tbody = document.createElement("tbody");
    result.rows.forEach((rp) => {
      const p = rp.properties;
      const cls = geo.classInfo(p.class_id);
      const plusCls = p.scenario_plus5_class_id ? geo.classInfo(p.scenario_plus5_class_id) : null;
      const tr = document.createElement("tr");
      tr.tabIndex = 0;
      const cells = [
        p.id,
        `${geo.formatNumber(rp.lat, 5)}, ${geo.formatNumber(rp.lon, 5)}`,
        geo.formatNumber(p.ratio, 2),
        null,
        geo.formatInt(p.level_range),
        geo.formatInt(p.style_diversity),
        p.dominant_style || "—",
        plusCls ? plusCls.short : "—",
      ];
      cells.forEach((value, index) => {
        const td = document.createElement("td");
        if (index === 0) td.className = "id-cell";
        if (index === 1) td.className = "coords-cell";
        if ([2, 4, 5].includes(index)) td.className = "numeric";
        if (index === 3) {
          const badge = document.createElement("span");
          badge.className = "class-badge";
          badge.dataset.class = cls.id;
          badge.textContent = cls.short;
          td.appendChild(badge);
        } else {
          td.textContent = value;
        }
        tr.appendChild(td);
      });
      const open = () => openReference(rp, true);
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    out.innerHTML = `<div class="find-summary"><strong>${escapeHtml(result.title)}</strong>
      <span>${escapeHtml(result.note)}</span></div>`;
    const wrap = document.createElement("div");
    wrap.className = "table-wrap find-table";
    wrap.appendChild(table);
    out.appendChild(wrap);
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "Нажмите на строку, чтобы открыть точку на карте в режиме «Что если». Исходные данные не изменяются.";
    out.appendChild(hint);
  }

  // -------------------------------------------------------------------------
  // Сохранённые сценарии
  // -------------------------------------------------------------------------

  function loadScenarios() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      state.scenarios = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      state.scenarios = [];
    }
  }

  function persistScenarios() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.scenarios));
    } catch (error) {
      const note = $("scenario-save-note");
      note.hidden = false;
      note.textContent = "Сценарий сохранён только в памяти: браузер запретил localStorage.";
    }
  }

  function saveCurrentScenario() {
    if (!state.selected || !state.scenario) return;
    if (state.selected.metrics.avg_height === null || state.selected.metrics.min_gap === null) {
      showSaveNote("Для этой точки нельзя сохранить сценарий: нет высоты или валидного зазора.");
      return;
    }
    const m = state.selected.metrics;
    const result = geo.scenarioResult(m, state.scenario.floors, state.scenario.gap);
    const labelInput = $("scenario-label");
    const label = (labelInput.value || "").trim() || `Сценарий ${state.scenarios.length + 1}`;
    const entry = {
      id: `S-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      label,
      createdAt: new Date().toISOString(),
      point: {
        lon: state.selected.lon,
        lat: state.selected.lat,
        refId: state.selected.refId,
      },
      base: {
        floors: state.scenario.baseFloors,
        gap: state.scenario.baseGap,
        avg_height: m.avg_height,
        min_gap: m.min_gap,
        ratio: m.ratio,
        class_id: m.class_id,
      },
      scenario: {
        floors: state.scenario.floors,
        gap: state.scenario.gap,
        height: result.height,
        ratio: result.ratio,
        class_id: result.class_id,
        delta_ratio: result.delta_ratio,
      },
    };
    state.scenarios.unshift(entry);
    persistScenarios();
    renderScenarioList();
    labelInput.value = "";
    showSaveNote(`Сценарий «${label}» сохранён. Он появился в блоке «Сравнение сценариев».`);
  }

  function showSaveNote(text) {
    const note = $("scenario-save-note");
    note.hidden = false;
    note.textContent = text;
    clearTimeout(showSaveNote.timer);
    showSaveNote.timer = setTimeout(() => { note.hidden = true; }, 5000);
  }

  function renderScenarioList() {
    const wrap = $("scenario-table-wrap");
    if (!state.scenarios.length) {
      wrap.innerHTML = `<p class="muted">Пока нет сохранённых сценариев. Откройте точку, перейдите
        в «Что если» и нажмите «Сохранить».</p>`;
      return;
    }
    const table = document.createElement("table");
    table.innerHTML = `<thead><tr>
      <th>Метка</th><th>Точка</th><th class="numeric">Высота</th><th class="numeric">Зазор</th>
      <th class="numeric">ratio</th><th>Класс</th><th class="numeric">Δ ratio</th>
      <th>Δ класс</th><th></th>
    </tr></thead>`;
    const tbody = document.createElement("tbody");
    state.scenarios.forEach((entry, index) => {
      const baseCls = geo.classInfo(entry.base.class_id);
      const scCls = geo.classInfo(entry.scenario.class_id);
      const delta = entry.scenario.delta_ratio;
      const deltaText = delta === null
        ? "—"
        : `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${geo.formatNumber(Math.abs(delta), 2)}`;
      const classDelta = baseCls.id === scCls.id
        ? "без изменения"
        : `${baseCls.short} → ${scCls.short}`;
      const tr = document.createElement("tr");

      const values = [
        entry.label,
        entry.point.refId || `${geo.formatNumber(entry.point.lat, 4)}, ${geo.formatNumber(entry.point.lon, 4)}`,
        `${geo.formatNumber(entry.scenario.floors, 1)} эт. / ${geo.formatNumber(entry.scenario.height, 1)} м`,
        `${geo.formatNumber(entry.scenario.gap, 1)} м`,
        geo.formatNumber(entry.scenario.ratio, 2),
        null,
        deltaText,
        classDelta,
        null,
      ];
      values.forEach((value, cellIndex) => {
        const td = document.createElement("td");
        if ([2, 3, 4, 6].includes(cellIndex)) td.className = "numeric";
        if (cellIndex === 5) {
          const badge = document.createElement("span");
          badge.className = "class-badge";
          badge.dataset.class = scCls.id;
          badge.textContent = scCls.short;
          td.appendChild(badge);
        } else if (cellIndex === 8) {
          const open = document.createElement("button");
          open.type = "button";
          open.className = "small-button";
          open.textContent = "Открыть";
          open.addEventListener("click", (event) => {
            event.stopPropagation();
            openSavedScenario(entry);
          });
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "small-button";
          remove.textContent = "Удалить";
          remove.style.marginLeft = "4px";
          remove.addEventListener("click", (event) => {
            event.stopPropagation();
            state.scenarios.splice(index, 1);
            persistScenarios();
            renderScenarioList();
          });
          td.appendChild(open);
          td.appendChild(remove);
        } else {
          td.textContent = value;
        }
        tr.appendChild(td);
      });
      tr.addEventListener("click", () => openSavedScenario(entry));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    const wrapTable = document.createElement("div");
    wrapTable.className = "table-wrap";
    wrapTable.appendChild(table);
    wrap.innerHTML = "";
    wrap.appendChild(wrapTable);
    const note = document.createElement("p");
    note.className = "muted";
    note.style.marginTop = "8px";
    note.textContent = "Сравнение идёт с исходным состоянием выбранной точки. Нажмите на строку, чтобы вернуться к сценарию.";
    wrap.appendChild(note);
  }

  function openSavedScenario(entry) {
    selectPoint(entry.point.lon, entry.point.lat, { mode: "scenario" });
    if (state.scenario) {
      state.scenario.floors = geo.clamp(
        entry.scenario.floors,
        CONFIG.scenario.heightFloorsMin,
        CONFIG.scenario.heightFloorsMax
      );
      state.scenario.gap = geo.clamp(
        entry.scenario.gap,
        CONFIG.scenario.gapMetersMin,
        CONFIG.scenario.gapMetersMax
      );
    }
    state.map.panTo(entry.point.lon, entry.point.lat);
    applyMode();
    $("scenario-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function clearScenarios() {
    if (!state.scenarios.length) return;
    if (!window.confirm("Удалить все сохранённые сценарии?")) return;
    state.scenarios = [];
    persistScenarios();
    renderScenarioList();
  }

  // -------------------------------------------------------------------------
  // Ошибки и утилиты
  // -------------------------------------------------------------------------

  function showFatal(error) {
    $("loading-overlay").hidden = true;
    $("fatal-error").hidden = false;
    $("fatal-message").textContent = error && error.message
      ? error.message
      : String(error || "Неизвестная ошибка загрузки.");
    console.error(error);
  }

  function numberOrNull(value) {
    if (value === "" || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[ch]));
  }
})();
