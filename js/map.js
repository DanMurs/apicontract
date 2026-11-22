/**
 * Модуль интерактивной ГИС-карты (Leaflet) и пространственного анализа «АпиКонтракт».
 * Считает зоны продуктивного лёта пчёл (2 км / 3.5 км), буферные зоны ФГИС «Сатурн» (7 км)
 * и сектор ветрового сноса пестицидов.
 */

import { CROPS_DB, PESTICIDE_CLASSES, CLUSTER_CENTER } from './data.js?v=10';

const EARTH_RADIUS_KM = 6371;

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/**
 * Расстояние по формуле гаверсинуса между двумя точками (в км).
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/**
 * Начальный азимут от точки 1 к точке 2 (0–360°, 0 = север).
 */
export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Конечная точка по координате, азимуту и расстоянию (в км).
 */
export function destinationPoint(lat, lon, bearingDeg, distanceKm) {
  const angDist = distanceKm / EARTH_RADIUS_KM;
  const brng = toRad(bearingDeg);
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) + Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1),
      Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
    );

  return [toDeg(lat2), toDeg(lon2)];
}

/**
 * Центроид полигона поля.
 */
export function polygonCentroid(polygon) {
  if (!polygon || polygon.length === 0) return [CLUSTER_CENTER.lat, CLUSTER_CENTER.lon];
  let latSum = 0;
  let lonSum = 0;
  for (const [lat, lon] of polygon) {
    latSum += lat;
    lonSum += lon;
  }
  return [latSum / polygon.length, lonSum / polygon.length];
}

/**
 * Строит прямоугольный контур поля вокруг (lat, lon) пропорционально площади в гектарах.
 */
export function buildFieldPolygonFromCenter(lat, lon, areaHa) {
  const areaKm2 = Math.max(0.05, Number(areaHa) * 0.01);
  // Пропорция сторон ~ 1.45 : 1
  const heightKm = Math.sqrt(areaKm2 / 1.45);
  const widthKm = areaKm2 / heightKm;

  const dLat = (heightKm / 2) / 111.32;
  const kmPerLonDeg = 111.32 * Math.max(0.2, Math.cos(toRad(lat)));
  const dLon = (widthKm / 2) / kmPerLonDeg;

  return [
    [Number((lat - dLat).toFixed(5)), Number((lon - dLon).toFixed(5))],
    [Number((lat + dLat).toFixed(5)), Number((lon - dLon + dLon * 0.08).toFixed(5))],
    [Number((lat + dLat).toFixed(5)), Number((lon + dLon).toFixed(5))],
    [Number((lat - dLat).toFixed(5)), Number((lon + dLon - dLon * 0.08).toFixed(5))],
  ];
}

/**
 * Минимальное расстояние от точки до центра или вершин полигона (в км).
 */
export function minDistToPolygonKm(lat, lon, polygon) {
  const [cLat, cLon] = polygonCentroid(polygon);
  let minD = haversineKm(lat, lon, cLat, cLon);
  for (const [vLat, vLon] of polygon) {
    const d = haversineKm(lat, lon, vLat, vLon);
    if (d < minD) minD = d;
  }
  return minD;
}

/**
 * Длина шлейфа сноса аэрозоля (км) в зависимости от скорости ветра.
 */
export function getPlumeLengthKm(windSpeedMs) {
  return Math.min(6.0, Math.max(2.0, 2.0 + windSpeedMs * 0.42));
}

/**
 * Проверяет, попадает ли точка в сектор ветрового сноса от очага обработки.
 */
export function isPointInWindPlume(lat, lon, originLat, originLon, windDirDeg, windSpeedMs) {
  if (windSpeedMs < 0.8) return false;
  const distKm = haversineKm(originLat, originLon, lat, lon);
  const plumeLen = getPlumeLengthKm(windSpeedMs);
  if (distKm > plumeLen) return false;

  const angleToTarget = bearingDegrees(originLat, originLon, lat, lon);
  let diff = Math.abs(angleToTarget - windDirDeg);
  if (diff > 180) diff = 360 - diff;
  return diff <= 24; // сектор ±24°
}

/**
 * Генерирует координаты сектора ветрового шлейфа для отрисовки на карте.
 */
function buildWindPlumePolygon(originLat, originLon, windDirDeg, windSpeedMs) {
  const lengthKm = getPlumeLengthKm(windSpeedMs);
  const halfAngle = 24;
  const points = [[originLat, originLon]];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const angle = windDirDeg - halfAngle + (i * (halfAngle * 2)) / steps;
    points.push(destinationPoint(originLat, originLon, angle, lengthKm));
  }
  return points;
}

/**
 * Пространственный анализ всех полей, пасек и угроз ФГИС «Сатурн».
 */
export function analyzeSpatialCoverage(fields, apiaries, treatments, windState) {
  const fieldReports = fields.map((field) => {
    const crop = CROPS_DB[field.cropId];
    const [cLat, cLon] = polygonCentroid(field.polygon);
    const requiredHives = Math.ceil(field.areaHa * crop.normHivesPerHa);

    let effectiveHives = 0;
    const nearbyApiaries = [];

    for (const apiary of apiaries) {
      const distKm = minDistToPolygonKm(apiary.lat, apiary.lon, field.polygon);
      if (distKm <= 2.0) {
        effectiveHives += apiary.hivesCount;
        nearbyApiaries.push({ apiary, distKm, zone: 'productive', weight: 1.0 });
      } else if (distKm <= 3.5) {
        const contribution = Math.round(apiary.hivesCount * 0.55);
        effectiveHives += contribution;
        nearbyApiaries.push({ apiary, distKm, zone: 'extended', weight: 0.55 });
      }
    }

    const coveragePct = requiredHives > 0 ? Math.min(100, Math.round((effectiveHives / requiredHives) * 100)) : 100;
    const deficitHives = Math.max(0, requiredHives - effectiveHives);
    const needsCounterPollination = field.areaHa >= 100 && nearbyApiaries.length <= 1;

    // Проверка пересечения с 7-км буферными зонами ФГИС «Сатурн»
    const saturnAlerts = [];
    for (const tr of treatments) {
      const pInfo = PESTICIDE_CLASSES[tr.hazardClass] || PESTICIDE_CLASSES[3];
      const distKm = haversineKm(cLat, cLon, tr.lat, tr.lon);
      if (distKm <= pInfo.bufferRadiusKm) {
        const inPlume = isPointInWindPlume(
          cLat,
          cLon,
          tr.lat,
          tr.lon,
          windState.directionDeg,
          windState.speedMs
        );
        saturnAlerts.push({ treatment: tr, distKm, inPlume, hazardClass: tr.hazardClass });
      }
    }

    return {
      field,
      crop,
      centroid: [cLat, cLon],
      requiredHives,
      effectiveHives,
      coveragePct,
      deficitHives,
      nearbyApiaries,
      needsCounterPollination,
      saturnAlerts,
    };
  });

  const apiaryReports = apiaries.map((apiary) => {
    const hazards = [];
    for (const tr of treatments) {
      const pInfo = PESTICIDE_CLASSES[tr.hazardClass] || PESTICIDE_CLASSES[3];
      const distKm = haversineKm(apiary.lat, apiary.lon, tr.lat, tr.lon);
      const inPlume = isPointInWindPlume(
        apiary.lat,
        apiary.lon,
        tr.lat,
        tr.lon,
        windState.directionDeg,
        windState.speedMs
      );
      if (distKm <= pInfo.bufferRadiusKm || inPlume) {
        hazards.push({
          treatment: tr,
          distKm,
          inPlume,
          pInfo,
        });
      }
    }

    return {
      apiary,
      hazards,
      isAtRisk: hazards.length > 0,
      inWindPlume: hazards.some((h) => h.inPlume),
    };
  });

  return { fieldReports, apiaryReports };
}

/**
 * Контроллер Leaflet-карты «АпиКонтракт».
 */
export class ApiGisMap {
  constructor(containerId, callbacks = {}) {
    this.containerId = containerId;
    this.callbacks = callbacks;
    this.map = null;
    this.layers = {
      fields: null,
      flightZones: null,
      apiaries: null,
      saturnZones: null,
      windPlume: null,
    };
    this.visibility = {
      flight: true,
      saturn: true,
      plume: true,
    };
    this.placementMode = null;
  }

  init() {
    if (!window.L) {
      console.error('Leaflet не загружен.');
      return;
    }

    const russiaBounds = window.L.latLngBounds([41.0, 19.0], [78.0, 179.5]);

    this.map = window.L.map(this.containerId, {
      center: [CLUSTER_CENTER.lat, CLUSTER_CENTER.lon],
      zoom: CLUSTER_CENTER.zoom,
      minZoom: 4,
      maxZoom: 18,
      maxBounds: russiaBounds,
      maxBoundsViscosity: 1.0,
      worldCopyJump: false,
    });

    if (this.map.attributionControl) {
      this.map.attributionControl.setPrefix('АпиКонтракт ГИС');
    }

    // Слой карты OpenStreetMap + спутниковые очертания полей
    const osmLayer = window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      noWrap: true,
      bounds: russiaBounds,
      attribution: '&copy; OpenStreetMap | АпиКонтракт ГИС',
    });

    const esriSat = window.L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 18,
        noWrap: true,
        bounds: russiaBounds,
        attribution: 'Tiles &copy; Esri',
      }
    );

    osmLayer.addTo(this.map);
    window.L.control.layers({ '🗺️ Схема дорог и лесополос': osmLayer, '🛰️ Спутник полей': esriSat }).addTo(this.map);

    this.layers.fields = window.L.layerGroup().addTo(this.map);
    this.layers.flightZones = window.L.layerGroup().addTo(this.map);
    this.layers.saturnZones = window.L.layerGroup().addTo(this.map);
    this.layers.windPlume = window.L.layerGroup().addTo(this.map);
    this.layers.apiaries = window.L.layerGroup().addTo(this.map);

    this.map.on('click', (e) => {
      if (this.placementMode && typeof this.callbacks.onMapTargetClick === 'function') {
        this.callbacks.onMapTargetClick(this.placementMode, e.latlng.lat, e.latlng.lng);
      }
    });
  }

  setPlacementMode(mode) {
    this.placementMode = mode || null;
    const el = document.getElementById(this.containerId);
    if (el) {
      el.style.cursor = this.placementMode ? 'crosshair' : '';
    }
  }

  setLayerVisibility(layerKey, isVisible) {
    this.visibility[layerKey] = isVisible;
    if (!this.map) return;

    const mapObj = {
      flight: this.layers.flightZones,
      saturn: this.layers.saturnZones,
      plume: this.layers.windPlume,
    }[layerKey];

    if (!mapObj) return;
    if (isVisible) {
      mapObj.addTo(this.map);
    } else {
      this.map.removeLayer(mapObj);
    }
  }

  focusPoint(lat, lon, zoom = 13) {
    if (this.map) {
      this.map.flyTo([lat, lon], zoom, { duration: 0.65 });
    }
  }

  getCenter() {
    if (!this.map) {
      return { lat: CLUSTER_CENTER.lat, lon: CLUSTER_CENTER.lon };
    }
    const c = this.map.getCenter();
    return { lat: Number(c.lat.toFixed(4)), lon: Number(c.lng.toFixed(4)) };
  }

  render(analysis, treatments, windState) {
    if (!this.map) return;

    this.layers.fields.clearLayers();
    this.layers.flightZones.clearLayers();
    this.layers.saturnZones.clearLayers();
    this.layers.windPlume.clearLayers();
    this.layers.apiaries.clearLayers();

    // 1. Поля для опыления
    for (const rep of analysis.fieldReports) {
      const { field, crop, requiredHives, effectiveHives, coveragePct, saturnAlerts, needsCounterPollination } = rep;
      const isOptimal = coveragePct >= 80;
      const hasHazard = saturnAlerts.length > 0;

      const strokeColor = hasHazard ? '#dc2626' : isOptimal ? '#047857' : '#d97706';
      const fillColor = isOptimal ? '#10b981' : '#f59e0b';

      const poly = window.L.polygon(field.polygon, {
        color: strokeColor,
        weight: hasHazard ? 3 : 2,
        fillColor,
        fillOpacity: 0.34,
      }).addTo(this.layers.fields);

      const alertHtml = hasHazard
        ? `<div style="margin-top:6px;padding:5px 7px;background:#fee2e2;color:#991b1b;border-radius:6px;font-size:12px;">
            ⚠️ В 7-км зоне обработки ФГИС «Сатурн» (${saturnAlerts[0].treatment.saturnNumber}, ${saturnAlerts[0].distKm.toFixed(1)} км)
           </div>`
        : `<div style="margin-top:6px;padding:5px 7px;background:#d1fae5;color:#065f46;border-radius:6px;font-size:12px;">
            ✅ Пестицидная тишина подтверждена
           </div>`;

      const counterHtml = needsCounterPollination
        ? `<div style="margin-top:4px;font-size:11px;color:#b45309;">💡 Рекомендуется второй точок на противоположном краю (встречное опыление)</div>`
        : '';

      const popupContent = `
        <div style="min-width:240px;font-family:Inter,sans-serif;">
          <div style="font-weight:800;font-size:14px;margin-bottom:2px;">${crop.icon} ${field.name}</div>
          <div style="font-size:12px;color:#526358;margin-bottom:8px;">${field.farm} • Кадастр: ${field.cadastral}</div>
          <div style="font-size:12.5px;line-height:1.5;">
            <b>Культура:</b> ${crop.name} (${field.areaHa} га)<br/>
            <b>Норматив:</b> ${requiredHives} пчелосемей<br/>
            <b>В радиусе лёта:</b> ${effectiveHives} семей (<b>${coveragePct}%</b>)<br/>
            <b>Ставка:</b> ${field.feePerHiveRub.toLocaleString('ru-RU')} ₽ / улей
          </div>
          ${alertHtml}
          ${counterHtml}
          <div style="display:flex;gap:6px;margin-top:10px;">
            <button data-map-calc="${field.id}" style="flex:1;padding:6px 8px;border:none;border-radius:6px;background:#132a1e;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">
              🧮 В расчёт
            </button>
            <button data-map-passport="${field.id}" style="flex:1;padding:6px 8px;border:none;border-radius:6px;background:#f59e0b;color:#132a1e;font-size:12px;font-weight:700;cursor:pointer;">
              📄 Паспорт
            </button>
            <button data-delete-field="${field.id}" title="Удалить поле" style="padding:6px 8px;border:1px solid #fca5a5;border-radius:6px;background:#fee2e2;color:#b91c1c;font-size:12px;font-weight:700;cursor:pointer;">
              🗑️
            </button>
          </div>
        </div>
      `;

      poly.bindPopup(popupContent);
      poly.on('popupopen', () => {
        const calcBtn = document.querySelector(`[data-map-calc="${field.id}"]`);
        const passBtn = document.querySelector(`[data-map-passport="${field.id}"]`);
        const delBtn = document.querySelector(`[data-delete-field="${field.id}"]`);
        if (calcBtn && this.callbacks.onOpenInCalculator) {
          calcBtn.onclick = () => this.callbacks.onOpenInCalculator(field.id);
        }
        if (passBtn && this.callbacks.onOpenPassport) {
          passBtn.onclick = () => this.callbacks.onOpenPassport(field.id);
        }
        if (delBtn && this.callbacks.onDeleteField) {
          delBtn.onclick = () => {
            poly.closePopup();
            this.callbacks.onDeleteField(field.id);
          };
        }
      });
    }

    // 2. Зоны ФГИС «Сатурн» (7 км + ветровой шлейф)
    for (const tr of treatments) {
      const pInfo = PESTICIDE_CLASSES[tr.hazardClass] || PESTICIDE_CLASSES[3];

      // Контур обрабатываемого поля
      const trPoly = window.L.polygon(tr.polygon, {
        color: '#991b1b',
        weight: 2,
        fillColor: '#ef4444',
        fillOpacity: 0.48,
      })
        .bindPopup(
          `<div style="font-family:Inter,sans-serif;min-width:240px;">
            <div style="font-weight:800;color:#b91c1c;">☢️ ФГИС «Сатурн» №${tr.saturnNumber}</div>
            <div style="font-size:12px;margin:4px 0;"><b>${tr.farm}</b><br/>Кадастр: ${tr.cadastral}</div>
            <div style="font-size:12px;line-height:1.45;">
              <b>Культура:</b> ${tr.crop}<br/>
              <b>Препарат:</b> ${tr.pesticideName}<br/>
              <b>Опасность:</b> ${pInfo.title}<br/>
              <b>Буфер по ФЗ-490:</b> ${pInfo.bufferRadiusKm} км<br/>
              <b>Окно:</b> ${tr.dateWindow}
            </div>
            <div style="margin-top:6px;font-size:11.5px;color:#991b1b;background:#fee2e2;padding:5px;border-radius:6px;">
              ${pInfo.recommendation}
            </div>
            ${
              tr.sourceUrl
                ? `<a href="${tr.sourceUrl}" target="_blank" rel="noopener" style="display:block;text-align:center;margin-top:8px;padding:6px 10px;border-radius:6px;background:#f8fafc;border:1px solid #cbd5e1;color:#0f172a;font-size:12px;font-weight:600;text-decoration:none;">
                    🔗 Проверить оригинал на bee-saturn.ru ↗
                   </a>`
                : ''
            }
            <button data-delete-treatment="${tr.id}" style="width:100%;margin-top:6px;padding:6px 10px;border:1px solid #fca5a5;border-radius:6px;background:#fee2e2;color:#b91c1c;font-size:12px;font-weight:700;cursor:pointer;">
              🗑️ Убрать зону СЗР с карты
            </button>
          </div>`
        )
        .addTo(this.layers.saturnZones);

      trPoly.on('popupopen', () => {
        const delTrBtn = document.querySelector(`[data-delete-treatment="${tr.id}"]`);
        if (delTrBtn && this.callbacks.onDeleteTreatment) {
          delTrBtn.onclick = () => {
            trPoly.closePopup();
            this.callbacks.onDeleteTreatment(tr.id);
          };
        }
      });

      // Буферный радиус по ФЗ-490 (7 км)
      window.L.circle([tr.lat, tr.lon], {
        radius: pInfo.bufferRadiusKm * 1000,
        color: '#ef4444',
        weight: 1.8,
        dashArray: '8 6',
        fillColor: '#ef4444',
        fillOpacity: 0.05,
        interactive: false,
      }).addTo(this.layers.saturnZones);

      // Метка ФГИС
      const satIcon = window.L.divIcon({
        className: '',
        html: `<div class="saturn-pin">☢️ ${tr.saturnNumber} • ${pInfo.bufferRadiusKm} км</div>`,
        iconSize: [145, 24],
        iconAnchor: [72, 12],
      });
      window.L.marker([tr.lat, tr.lon], { icon: satIcon, interactive: false }).addTo(this.layers.saturnZones);

      // Ветровой шлейф сноса аэрозоля
      if (windState.speedMs >= 0.8) {
        const plumePoly = buildWindPlumePolygon(tr.lat, tr.lon, windState.directionDeg, windState.speedMs);
        window.L.polygon(plumePoly, {
          color: '#ea580c',
          weight: 1.5,
          dashArray: '4 4',
          fillColor: '#f97316',
          fillOpacity: 0.24,
          interactive: false,
        }).addTo(this.layers.windPlume);
      }
    }

    // 3. Пасеки и радиусы лёта 2 км / 3.5 км
    for (const rep of analysis.apiaryReports) {
      const { apiary, hazards, isAtRisk, inWindPlume } = rep;

      // Радиус продуктивного лёта 2.0 км
      window.L.circle([apiary.lat, apiary.lon], {
        radius: 2000,
        color: isAtRisk ? '#dc2626' : '#10b981',
        weight: 1.8,
        fillColor: isAtRisk ? '#fca5a5' : '#10b981',
        fillOpacity: 0.13,
        interactive: false,
      }).addTo(this.layers.flightZones);

      // Максимальный радиус 3.5 км (пунктир)
      window.L.circle([apiary.lat, apiary.lon], {
        radius: 3500,
        color: '#059669',
        weight: 1,
        dashArray: '4 6',
        fillOpacity: 0,
        interactive: false,
      }).addTo(this.layers.flightZones);

      const icon = window.L.divIcon({
        className: '',
        html: `<div class="apiary-pin ${isAtRisk ? 'danger' : ''}">${isAtRisk ? '⚠️' : '🐝'} ${apiary.hivesCount} ульев</div>`,
        iconSize: [96, 26],
        iconAnchor: [48, 13],
      });

      const hazardBlock = isAtRisk
        ? `<div style="margin-top:6px;padding:6px;background:#fee2e2;color:#991b1b;border-radius:6px;font-size:12px;">
            <b>🚨 Внимание (ФЗ-490):</b> пасека в ${hazards[0].distKm.toFixed(1)} км от обработки ${hazards[0].treatment.saturnNumber}.
            ${inWindPlume ? '<br/><b>💨 Находится прямо в секторе ветрового сноса!</b>' : ''}
            <br/>Изоляция пчёл: ${hazards[0].pInfo.isolationHours} ч.
           </div>`
        : `<div style="margin-top:6px;padding:5px 7px;background:#d1fae5;color:#065f46;border-radius:6px;font-size:12px;">
            ✅ Безопасное расположение (за пределами сноса СЗР)
           </div>`;

      const marker = window.L.marker([apiary.lat, apiary.lon], { icon, draggable: true })
        .bindPopup(
          `<div style="min-width:240px;font-family:Inter,sans-serif;">
            <div style="font-weight:800;font-size:13.5px;">🐝 ${apiary.name}</div>
            <div style="font-size:12px;color:#526358;margin-bottom:6px;">${apiary.beekeeper} • Ветпаспорт: ${apiary.vetPassport}</div>
            <div style="font-size:12.5px;line-height:1.45;">
              <b>Мощность:</b> ${apiary.hivesCount} пчелосемей<br/>
              <b>Транспорт:</b> ${apiary.trailerType}<br/>
              <b>Телефон:</b> ${apiary.phone}<br/>
              <span style="font-size:11px;color:#64748b;">💡 Метку можно перетащить мышью / пальцем по карте</span>
            </div>
            ${hazardBlock}
            <div style="display:flex;gap:6px;margin-top:9px;">
              <button data-edit-apiary="${apiary.id}" style="flex:1;padding:6px 8px;border:none;border-radius:6px;background:#f59e0b;color:#132a1e;font-size:12px;font-weight:700;cursor:pointer;">
                ✏️ Изменить
              </button>
              <button data-delete-apiary="${apiary.id}" style="padding:6px 10px;border:1px solid #fca5a5;border-radius:6px;background:#fee2e2;color:#b91c1c;font-size:12px;font-weight:700;cursor:pointer;">
                🗑️ Удалить
              </button>
            </div>
          </div>`
        )
        .addTo(this.layers.apiaries);

      marker.on('dragend', (e) => {
        const pos = e.target.getLatLng();
        if (typeof this.callbacks.onMoveApiary === 'function') {
          this.callbacks.onMoveApiary(apiary.id, pos.lat, pos.lng);
        }
      });

      marker.on('popupopen', () => {
        const editBtn = document.querySelector(`[data-edit-apiary="${apiary.id}"]`);
        const delBtn = document.querySelector(`[data-delete-apiary="${apiary.id}"]`);
        if (editBtn && this.callbacks.onEditApiary) {
          editBtn.onclick = () => {
            marker.closePopup();
            this.callbacks.onEditApiary(apiary.id);
          };
        }
        if (delBtn && this.callbacks.onDeleteApiary) {
          delBtn.onclick = () => {
            marker.closePopup();
            this.callbacks.onDeleteApiary(apiary.id);
          };
        }
      });
    }
  }
}
