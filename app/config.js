/*
 * Единая конфигурация приложения «Дворовый масштаб».
 * Значения ниже читаются и фронтендом, и Python-скриптом подготовки данных
 * (scripts/prepare_data.py извлекает этот JSON-объект), поэтому пороги,
 * классификация стилей и параметры расчёта не дублируются.
 *
 * Объект должен оставаться валидным JSON: без комментариев внутри,
 * без висячих запятых, ключи в двойных кавычках.
 */
window.COURTYARD_CONFIG = {
  "app": {
    "title": "Дворовый масштаб",
    "subtitle": "Васильевский остров · восприятие масштаба и стилистической неоднородности",
    "version": "1.0.0"
  },
  "studyArea": {
    "name": "Васильевский остров, Санкт-Петербург",
    "bbox": [30.1777808, 59.9184544, 30.3077042, 59.9544329],
    "origin": [30.2427425, 59.93644365],
    "islandRelationId": 1576083,
    "islandRelationUrl": "https://www.openstreetmap.org/relation/1576083"
  },
  "bufferMeters": 100,
  "gridStepMeters": 50,
  "neighbors": {
    "radiusMeters": 100,
    "maxNeighbors": 5
  },
  "minGapIgnoreMeters": 1.0,
  "scenario": {
    "floorHeightMeters": 3.3,
    "heightFloorsMin": 3,
    "heightFloorsMax": 30,
    "gapMetersMin": 10,
    "gapMetersMax": 80,
    "presets": [
      {
        "id": "as-is",
        "label": "Как есть",
        "floorsDelta": 0,
        "gapDelta": 0
      },
      {
        "id": "densify",
        "label": "Уплотнение +5 этажей",
        "floorsDelta": 5,
        "gapDelta": 0
      },
      {
        "id": "expand",
        "label": "Расширение двора +10 м",
        "floorsDelta": 0,
        "gapDelta": 10
      }
    ]
  },
  "thresholds": {
    "ratioOpenMax": 0.3,
    "ratioClosedMin": 1.0,
    "levelContrastMin": 3,
    "dominantShareMin": 0.5,
    "unknownStyleWarningShare": 0.5,
    "specialThreatPeriods": [
      "От неоклассики к функциональной архитектуре",
      "Современная архитектура"
    ],
    "plusFloorsSearch": 5,
    "minBuildingsForMetrics": 2
  },
  "classes": [
    {
      "id": "open",
      "label": "Открытый, слабо замкнутый двор",
      "short": "открытый",
      "condition": "ratio < 0.3",
      "color": "#2f9e6f"
    },
    {
      "id": "moderate",
      "label": "Умеренно замкнутый двор",
      "short": "умеренно замкнутый",
      "condition": "0.3 ≤ ratio < 1.0",
      "color": "#d99a2b"
    },
    {
      "id": "closed",
      "label": "Замкнутый двор (колодец)",
      "short": "замкнутый",
      "condition": "ratio ≥ 1.0",
      "color": "#cf4b4b"
    },
    {
      "id": "no-data",
      "label": "Недостаточно данных",
      "short": "нет данных",
      "condition": "нет валидного зазора или меньше двух зданий",
      "color": "#9aa3ad"
    }
  ],
  "stylePeriods": [
    {
      "name": "Ранее барокко",
      "from": 1703,
      "to": 1739,
      "color": "#8c6d4f"
    },
    {
      "name": "Высокое барокко",
      "from": 1740,
      "to": 1759,
      "color": "#b8865b"
    },
    {
      "name": "Ранний классицизм",
      "from": 1760,
      "to": 1779,
      "color": "#c2a25a"
    },
    {
      "name": "Строгий классицизм",
      "from": 1780,
      "to": 1800,
      "color": "#a9a35a"
    },
    {
      "name": "Высокий классицизм",
      "from": 1801,
      "to": 1809,
      "color": "#8fae67"
    },
    {
      "name": "Поздний классицизм (ампир)",
      "from": 1810,
      "to": 1830,
      "color": "#6fa76f"
    },
    {
      "name": "Эклектика (историцизм)",
      "from": 1831,
      "to": 1899,
      "color": "#5f9ea0"
    },
    {
      "name": "Модерн",
      "from": 1900,
      "to": 1905,
      "color": "#5b8db8"
    },
    {
      "name": "Неоклассицизм",
      "from": 1905,
      "to": 1919,
      "color": "#6d7fbf"
    },
    {
      "name": "Авангард",
      "from": 1920,
      "to": 1935,
      "color": "#8a6fb5"
    },
    {
      "name": "От неоклассики к функциональной архитектуре",
      "from": 1935,
      "to": 1989,
      "color": "#b06a95"
    },
    {
      "name": "Архитектура конца XX – начала XXI века",
      "from": 1990,
      "to": 2010,
      "color": "#c76f78"
    },
    {
      "name": "Современная архитектура",
      "from": 2011,
      "to": 2026,
      "color": "#d08a5f"
    }
  ],
  "unknownStyle": {
    "name": "неизвестно",
    "color": "#9aa3ad"
  },
  "ratioColors": {
    "open": "#2f9e6f",
    "moderate": "#d99a2b",
    "closed": "#cf4b4b",
    "unknown": "#9aa3ad"
  },
  "map": {
    "tileUrl": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "tileAttribution": "© участники OpenStreetMap, ODbL",
    "tileMaxZoom": 19,
    "initialZoom": 14,
    "minZoom": 11,
    "maxZoom": 19
  },
  "data": {
    "buildings": "../data/buildings.geojson",
    "referencePoints": "../data/reference_points.geojson",
    "metadata": "../data/metadata.json",
    "island": "../data/island.geojson"
  },
  "external": {
    "osmCopyright": "https://www.openstreetmap.org/copyright",
    "kontikiDataset": "https://kontikimaps.ru/how-old/cities250/datasets",
    "kontikiLicense": "https://opendatacommons.org/licenses/odbl/1-0/"
  }
};
