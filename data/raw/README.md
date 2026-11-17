# Сырые данные

Эта папка содержит кэш, который не коммитится в репозиторий:

- `overpass_chunk_*.json` — ответы Overpass API по частям bbox. Повторный запуск
  `scripts/prepare_data.py` использует кэш и не обращается к сети, если не указан
  `--refresh-osm`.
- `kontiki_buildings.geojson` — извлечённый из GeoPackage kontikimaps поднабор
  зданий в границах острова. Содержит годы постройки и координаты; лицензия ODbL,
  атрибуция «© how-old-is-this.house / Кон-Тики (kontikimaps.ru), ODbL».
- `HOITH_database_231118.gpkg` — исходная выгрузка kontikimaps (около 1.8 ГБ),
  если вы её скачали. Не коммитится.

Готовые файлы для приложения лежат на уровень выше: `buildings.geojson`,
`reference_points.geojson`, `metadata.json`, `control_buildings.json`.
