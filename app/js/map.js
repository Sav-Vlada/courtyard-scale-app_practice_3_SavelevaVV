/* Карта Leaflet: здания, опорные точки, буфер и сценарные контуры. */
(function (global) {
  "use strict";

  const L = global.L;
  const CONFIG = global.COURTYARD_CONFIG;
  const geo = global.CourtyardGeo;

  class CourtyardMap {
    constructor(element, handlers) {
      this.element = element;
      this.handlers = handlers || {};
      this.buildings = [];
      this.buildingLayer = null;
      this.referenceLayer = null;
      this.referenceVisible = true;
      this.selectionLayer = null;
      this.scenarioLayer = null;
      this.scenarioActive = false;
      this.offlineNotified = false;
    }

    init(islandGeo) {
      this.map = L.map(this.element, {
        center: [59.9364, 30.2427],
        zoom: CONFIG.map.initialZoom,
        minZoom: CONFIG.map.minZoom,
        maxZoom: CONFIG.map.maxZoom,
        preferCanvas: true,
        zoomControl: true,
      });

      this.renderer = L.canvas({ padding: 0.4 });
      this.tileLayer = L.tileLayer(CONFIG.map.tileUrl, {
        attribution: CONFIG.map.tileAttribution,
        maxZoom: CONFIG.map.tileMaxZoom,
      }).addTo(this.map);

      this.tileLayer.on("tileerror", () => {
        if (this.offlineNotified) return;
        this.offlineNotified = true;
        if (typeof this.handlers.onTileError === "function") {
          this.handlers.onTileError();
        }
      });

      if (islandGeo) {
        L.geoJSON(islandGeo, {
          interactive: false,
          style: {
            color: "#6f5c48",
            weight: 1.5,
            dashArray: "6 5",
            fillOpacity: 0.02,
          },
        }).addTo(this.map);
      }

      this.map.on("click", (event) => {
        if (typeof this.handlers.onMapClick === "function") {
          this.handlers.onMapClick(event.latlng.lng, event.latlng.lat);
        }
      });

      this.fitIsland();
      return this;
    }

    fitIsland() {
      const [west, south, east, north] = CONFIG.studyArea.bbox;
      this.map.fitBounds(
        [[south, west], [north, east]],
        { padding: [18, 18], animate: false }
      );
    }

    setBuildings(buildings) {
      this.buildings = buildings;
      if (this.buildingLayer) {
        this.map.removeLayer(this.buildingLayer);
      }
      const features = buildings.map((b) => ({
        type: "Feature",
        properties: b.props,
        geometry: b.geometry,
      }));
      this.buildingLayer = L.geoJSON(
        { type: "FeatureCollection", features },
        {
          renderer: this.renderer,
          interactive: false,
          style: (feature) => {
            const ratio = feature.properties.ratio;
            const color = geo.ratioColor(ratio);
            return {
              color: "rgba(255,255,255,0.55)",
              weight: 0.35,
              opacity: 0.75,
              fillColor: color,
              fillOpacity: 0.62,
            };
          },
        }
      ).addTo(this.map);
    }

    setReferencePoints(points) {
      if (this.referenceLayer) {
        this.map.removeLayer(this.referenceLayer);
        this.referenceLayer = null;
      }
      const group = L.layerGroup();
      points.forEach((rp) => {
        const classInfo = geo.classInfo(rp.properties.class_id);
        const marker = L.circleMarker([rp.lat, rp.lon], {
          renderer: this.renderer,
          radius: 2.7,
          weight: 0.8,
          color: "#ffffff",
          opacity: 0.9,
          fillColor: classInfo.color,
          fillOpacity: 0.9,
        });
        marker.bindTooltip(
          `${rp.properties.id} · ratio ${geo.formatNumber(rp.properties.ratio, 2)}`,
          { direction: "top", opacity: 0.9 }
        );
        marker.on("click", (event) => {
          if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
          if (typeof this.handlers.onReferenceClick === "function") {
            this.handlers.onReferenceClick(rp);
          }
        });
        group.addLayer(marker);
      });
      this.referenceLayer = group;
      if (this.referenceVisible) group.addTo(this.map);
    }

    setReferenceVisibility(visible) {
      this.referenceVisible = Boolean(visible);
      if (!this.referenceLayer) return;
      if (visible) {
        this.referenceLayer.addTo(this.map);
      } else {
        this.map.removeLayer(this.referenceLayer);
      }
    }

    clearSelection() {
      if (this.selectionLayer) {
        this.map.removeLayer(this.selectionLayer);
        this.selectionLayer = null;
      }
      this.setScenario(null, false);
    }

    select(lon, lat, options) {
      const opts = options || {};
      this.clearSelection();
      const group = L.layerGroup();
      const buffer = global.turf.circle(
        [lon, lat],
        CONFIG.bufferMeters / 1000,
        { steps: 64, units: "kilometers" }
      );
      L.geoJSON(buffer, {
        interactive: false,
        style: {
          color: "#1f4e5a",
          weight: 1.8,
          opacity: 0.85,
          dashArray: "5 4",
          fillColor: "#5aa0a8",
          fillOpacity: 0.08,
        },
      }).addTo(group);

      L.circleMarker([lat, lon], {
        renderer: this.renderer,
        radius: 7,
        weight: 2,
        color: "#ffffff",
        fillColor: "#c4553b",
        fillOpacity: 1,
      }).addTo(group);

      group.addTo(this.map);
      this.selectionLayer = group;
      if (!opts.skipPan) {
        this.map.panTo([lat, lon], { animate: true, duration: 0.35 });
      }
      return group;
    }

    highlightReference(lon, lat) {
      if (!this._highlight) {
        this._highlight = L.circleMarker([lat, lon], {
          renderer: this.renderer,
          radius: 12,
          weight: 2,
          color: "#c4553b",
          opacity: 0.9,
          fillOpacity: 0,
          dashArray: "3 3",
        }).addTo(this.map);
      } else {
        this._highlight.setLatLng([lat, lon]);
      }
    }

    clearHighlight() {
      if (this._highlight) {
        this.map.removeLayer(this._highlight);
        this._highlight = null;
      }
    }

    setScenario(indices, active) {
      this.scenarioActive = Boolean(active);
      if (this.scenarioLayer) {
        this.map.removeLayer(this.scenarioLayer);
        this.scenarioLayer = null;
      }
      if (this.buildingLayer) {
        this.buildingLayer.setStyle((feature) => {
          const color = geo.ratioColor(feature.properties.ratio);
          return {
            color: "rgba(255,255,255,0.55)",
            weight: 0.35,
            opacity: this.scenarioActive ? 0.25 : 0.75,
            fillColor: color,
            fillOpacity: this.scenarioActive ? 0.18 : 0.62,
          };
        });
      }
      if (!this.scenarioActive || !indices || !indices.length) return;

      const features = indices.map((i) => ({
        type: "Feature",
        properties: this.buildings[i].props,
        geometry: this.buildings[i].geometry,
      }));
      this.scenarioLayer = L.geoJSON(
        { type: "FeatureCollection", features },
        {
          renderer: this.renderer,
          interactive: false,
          style: {
            color: "#0e6f78",
            weight: 2.2,
            opacity: 1,
            dashArray: "6 4",
            fillColor: "#2f9e9a",
            fillOpacity: 0.06,
          },
        }
      ).addTo(this.map);
    }

    panTo(lon, lat, zoom) {
      const targetZoom = zoom || Math.max(this.map.getZoom(), 16);
      this.map.flyTo([lat, lon], targetZoom, { duration: 0.55 });
    }
  }

  global.CourtyardMap = CourtyardMap;
})(window);
