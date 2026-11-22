/**
 * Главный оркестратор веб-платформы «АпиКонтракт».
 */

import {
  CLUSTER_CENTER,
  CROPS_DB,
  PESTICIDE_CLASSES,
  INITIAL_FIELDS,
  INITIAL_APIARIES,
  INITIAL_SATURN_TREATMENTS,
} from './data.js?v=13';
import {
  ApiGisMap,
  analyzeSpatialCoverage,
  buildFieldPolygonFromCenter,
  datesOverlap,
  polygonCentroid,
  haversineKm,
  isPointInWindPlume,
} from './map.js?v=13';
import {
  calculateDualEconomics,
  evaluateMeteoConditions,
  fetchClusterWeather,
  formatWindDirection,
} from './calculator.js?v=13';

const state = {
  activeTab: 'gis',
  fields: structuredClone(INITIAL_FIELDS),
  apiaries: structuredClone(INITIAL_APIARIES),
  treatments: structuredClone(INITIAL_SATURN_TREATMENTS),
  signedContracts: new Set(['fld-1', 'fld-2']),
  wind: {
    directionDeg: 135,
    speedMs: 4.2,
  },
  weather: {
    tempC: 22.4,
    humidityPct: 54,
    source: 'fallback',
    lat: CLUSTER_CENTER.lat,
    lon: CLUSTER_CENTER.lon,
  },
  activePassportFieldId: null,
  lastAnalysis: null,
};

let gisMap = null;

function formatRub(num) {
  return `${Math.round(num).toLocaleString('ru-RU')} ₽`;
}

function showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4500);
}

/**
 * Генерирует детерминированный SVG QR-код (матрица 21x21 с позиционными метками)
 * для верификации Паспорта кочёвки.
 */
function generateQrSvg(payload) {
  const size = 21;
  const grid = Array.from({ length: size }, () => Array(size).fill(false));

  const placeFinder = (r0, c0) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[r0 + r][c0 + c] = border || inner;
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Полосы синхронизации
  for (let i = 8; i < size - 8; i++) {
    grid[6][i] = i % 2 === 0;
    grid[i][6] = i % 2 === 0;
  }

  // Детерминированное заполнение ячеек данных на базе хэша строки
  let hash = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const inTopLeft = r < 8 && c < 8;
      const inTopRight = r < 8 && c >= size - 8;
      const inBottomLeft = r >= size - 8 && c < 8;
      const onTiming = r === 6 || c === 6;
      if (inTopLeft || inTopRight || inBottomLeft || onTiming) continue;

      hash ^= (r * 31 + c * 17) & 0xff;
      hash = Math.imul(hash, 16777619) >>> 0;
      grid[r][c] = (hash & 1) === 1;
    }
  }

  const cellSize = 5;
  const padding = 10;
  const totalPx = size * cellSize + padding * 2;
  let rects = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c]) {
        rects += `<rect x="${padding + c * cellSize}" y="${padding + r * cellSize}" width="${cellSize}" height="${cellSize}" fill="#111827"/>`;
      }
    }
  }

  return `<svg width="116" height="116" viewBox="0 0 ${totalPx} ${totalPx}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR-код паспорта кочёвки">
    <rect width="${totalPx}" height="${totalPx}" fill="#ffffff"/>
    ${rects}
  </svg>`;
}

/**
 * Пересчитывает пространственную аналитику и обновляет всю систему.
 */
function refreshAll() {
  const analysis = analyzeSpatialCoverage(state.fields, state.apiaries, state.treatments, state.wind);
  state.lastAnalysis = analysis;

  const lotsBadge = document.getElementById('tab-lots-count');
  if (lotsBadge) lotsBadge.textContent = `${state.fields.length}`;

  renderSpatialSidebar(analysis);
  renderExchangeGrid(analysis);
  if (gisMap) {
    gisMap.render(analysis, state.treatments, state.wind);
  }
}

function renderSpatialSidebar(analysis) {
  const container = document.getElementById('spatial-analysis-list');
  if (!container) return;

  const parts = [];

  // Сначала выводим пасеки в зоне риска ФГИС «Сатурн»
  for (const arep of analysis.apiaryReports) {
    if (!arep.isAtRisk) continue;
    const h = arep.hazards[0];
    parts.push(`
      <div class="spatial-item hazard" data-focus-lat="${arep.apiary.lat}" data-focus-lon="${arep.apiary.lon}">
        <div class="spatial-item-top">
          <span>🚨 ${arep.apiary.name}</span>
          <span class="status-pill danger">${h.distKm.toFixed(1)} км до СЗР</span>
        </div>
        <div style="color:#991b1b;font-size:0.79rem;">
          Попадает в буфер ${h.pInfo.bufferRadiusKm} км обработки <b>${h.treatment.saturnNumber}</b>.
          ${arep.inWindPlume ? '<b>Прямой ветровой снос!</b>' : 'Изоляция ульев: ' + h.pInfo.isolationHours + ' ч.'}
        </div>
      </div>
    `);
  }

  // Далее — покрытие полей опылением
  for (const frep of analysis.fieldReports) {
    const {
      field,
      crop,
      centroid,
      requiredHives,
      effectiveHives,
      coveragePct,
      saturnAlerts,
      nonOverlappingSaturn,
      hasCompetition,
    } = frep;
    const isOptimal = coveragePct >= 80;
    const fillColor = isOptimal ? '#10b981' : '#f59e0b';
    const badgeClass = saturnAlerts.length > 0 ? 'danger' : isOptimal ? 'safe' : 'warn';
    const badgeText = saturnAlerts.length > 0 ? '⚠️ Риск 7 км' : `${coveragePct}% опылено`;

    parts.push(`
      <div class="spatial-item" data-focus-lat="${centroid[0]}" data-focus-lon="${centroid[1]}">
        <div class="spatial-item-top">
          <span>${crop.icon} ${field.name}</span>
          <span class="status-pill ${badgeClass}">${badgeText}</span>
        </div>
        <div style="font-size:0.78rem;color:var(--text-muted);">
          ${field.areaHa} га • нужно ${requiredHives} сем. • долетает: <b>${effectiveHives}</b>
          ${hasCompetition ? ' <span title="Конкуренция: пасека делится между цветущими полями">⚖️</span>' : ''}
          ${saturnAlerts.length === 0 && nonOverlappingSaturn.length > 0 ? ' <span title="СЗР рядом вне сроков цветения">📅✓</span>' : ''}
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" style="width:${coveragePct}%;background:${fillColor};"></div>
        </div>
      </div>
    `);
  }

  container.innerHTML = parts.join('');
  container.querySelectorAll('[data-focus-lat]').forEach((el) => {
    el.addEventListener('click', () => {
      const lat = Number(el.dataset.focusLat);
      const lon = Number(el.dataset.focusLon);
      gisMap?.focusPoint(lat, lon, 13);
    });
  });
}

function updateMeteoPanel() {
  const { tempC, humidityPct, source, lat, lon } = state.weather;
  const { directionDeg, speedMs } = state.wind;
  const evalRes = evaluateMeteoConditions(tempC, humidityPct, speedMs, directionDeg);

  document.getElementById('meteo-temp').textContent = `${tempC.toFixed(1)} °C`;
  document.getElementById('meteo-humidity').textContent = `${Math.round(humidityPct)} %`;
  document.getElementById('meteo-delta-t').textContent = `${evalRes.deltaT.toFixed(1)} °C`;

  const coordText = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  const badge = document.getElementById('meteo-source-badge');
  badge.textContent = source === 'live' ? `Live (${coordText})` : `Модель (${coordText})`;
  badge.className = `status-pill ${source === 'live' ? 'safe' : 'warn'}`;

  document.getElementById('wind-dir-label').textContent = formatWindDirection(directionDeg);
  document.getElementById('wind-speed-label').textContent = `${speedMs.toFixed(1)} м/с`;

  const flightEl = document.getElementById('meteo-flight-status');
  flightEl.innerHTML = `<span class="status-pill ${evalRes.flightLevel}" style="width:100%;justify-content:flex-start;border-radius:8px;padding:7px 10px;">${evalRes.flightText}</span>`;

  const sprayEl = document.getElementById('meteo-spray-status');
  sprayEl.innerHTML = `<span class="status-pill ${evalRes.sprayLevel}" style="width:100%;justify-content:flex-start;border-radius:8px;padding:7px 10px;">${evalRes.sprayText}</span>`;
}

async function loadWeatherAt(lat, lon, notify = false) {
  const btn = document.getElementById('btn-refresh-weather');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Загрузка...';
  }

  const live = await fetchClusterWeather(lat, lon);
  state.weather = {
    tempC: live.tempC,
    humidityPct: live.humidityPct,
    source: live.source,
    lat: Number(lat),
    lon: Number(lon),
  };
  state.wind = {
    directionDeg: Math.round(live.windDirectionDeg / 5) * 5,
    speedMs: Math.min(12, Math.round(live.windSpeedMs * 2) / 2),
  };

  const dirSlider = document.getElementById('wind-dir-slider');
  const spdSlider = document.getElementById('wind-speed-slider');
  if (dirSlider) dirSlider.value = String(state.wind.directionDeg);
  if (spdSlider) spdSlider.value = String(state.wind.speedMs);

  updateMeteoPanel();
  refreshAll();

  if (btn) {
    btn.disabled = false;
    btn.textContent = '🔄 Погода здесь';
  }

  if (notify) {
    showToast(
      live.source === 'live'
        ? `🌤️ Погода для (${lat.toFixed(2)}, ${lon.toFixed(2)}): ${live.tempC.toFixed(1)} °C, влажность ${Math.round(live.humidityPct)}%, ветер ${live.windSpeedMs.toFixed(1)} м/с`
        : `⚠️ Нет связи с Open-Meteo — показана резервная модель для (${lat.toFixed(2)}, ${lon.toFixed(2)}).`
    );
  }
}

/* ==================== КАЛЬКУЛЯТОР ==================== */

function initCalculatorControls() {
  const cropSel = document.getElementById('calc-crop');
  const filterCrop = document.getElementById('filter-crop');
  const nfCrop = document.getElementById('nf-crop');

  Object.values(CROPS_DB).forEach((crop) => {
    const opt1 = new Option(`${crop.icon} ${crop.name} (${crop.normHivesPerHa} сем/га)`, crop.id);
    const opt2 = new Option(`${crop.icon} ${crop.shortName}`, crop.id);
    const opt3 = new Option(`${crop.icon} ${crop.name}`, crop.id);
    cropSel.appendChild(opt1);
    filterCrop.appendChild(opt2);
    nfCrop.appendChild(opt3);
  });

  const applyCropDefaults = () => {
    const crop = CROPS_DB[cropSel.value] || CROPS_DB.sunflower;
    const area = Number(document.getElementById('calc-area').value);
    document.getElementById('calc-base-yield').value = crop.baseYieldTonsHa;
    document.getElementById('calc-crop-price').value = crop.cropPriceRubTon;
    document.getElementById('calc-fee').value = crop.recommendedFeeRub;
    document.getElementById('calc-hives').value = Math.ceil(area * crop.normHivesPerHa);
    recalcCalculator();
  };

  cropSel.addEventListener('change', applyCropDefaults);
  document.getElementById('btn-calc-reset').addEventListener('click', applyCropDefaults);

  ['calc-area', 'calc-hives', 'calc-base-yield', 'calc-crop-price', 'calc-fee', 'calc-honey-price'].forEach((id) => {
    document.getElementById(id).addEventListener('input', recalcCalculator);
  });

  applyCropDefaults();
}

function recalcCalculator() {
  const cropId = document.getElementById('calc-crop').value;
  const areaHa = Number(document.getElementById('calc-area').value);
  const hives = Number(document.getElementById('calc-hives').value);
  const baseYieldTonsHa = Number(document.getElementById('calc-base-yield').value);
  const cropPriceRubTon = Number(document.getElementById('calc-crop-price').value);
  const feePerHiveRub = Number(document.getElementById('calc-fee').value);
  const honeyPriceRubKg = Number(document.getElementById('calc-honey-price').value);

  document.getElementById('calc-area-val').textContent = `${areaHa} га`;
  document.getElementById('calc-hives-val').textContent = `${hives} семей`;

  const res = calculateDualEconomics({
    cropId,
    areaHa,
    hives,
    baseYieldTonsHa,
    cropPriceRubTon,
    feePerHiveRub,
    honeyPriceRubKg,
  });

  document.getElementById('res-req-hives').textContent = `${res.requiredHives} семей`;
  document.getElementById('res-sat-pct').textContent = `${res.saturationPct}%`;
  document.getElementById('res-yield-gain').textContent = `+${res.yieldGainTons.toFixed(1)} т`;
  document.getElementById('res-gross-gain').textContent = formatRub(res.grossGainRub);
  document.getElementById('res-contract-cost').textContent = formatRub(res.contractCostRub);
  document.getElementById('res-roi').textContent = `${res.roiPct}%`;
  document.getElementById('res-agro-net').textContent =
    `${res.agroNetProfitRub >= 0 ? '+' : ''}${formatRub(res.agroNetProfitRub)}`;

  document.getElementById('res-nectar-pool').textContent = `${res.nectarPoolKg.toLocaleString('ru-RU')} кг`;
  document.getElementById('res-honey-total').textContent = `${res.marketableHoneyKg.toLocaleString('ru-RU')} кг`;
  document.getElementById('res-honey-per-hive').textContent = `${res.honeyPerHiveKg.toFixed(1)} кг/улей`;
  document.getElementById('res-honey-rev').textContent = formatRub(res.honeyRevenueRub);
  document.getElementById('res-fee-rev').textContent = formatRub(res.contractCostRub);
  document.getElementById('res-bee-total').textContent = `+${formatRub(res.beekeeperTotalIncomeRub)}`;

  const satBadge = document.getElementById('calc-saturation-badge');
  satBadge.textContent = `Насыщение: ${res.saturationPct}%`;
  satBadge.className = `status-pill ${res.saturationPct >= 80 ? 'safe' : res.saturationPct >= 50 ? 'warn' : 'danger'}`;

  document.getElementById('calc-advice-box').textContent = res.advice;
}

function openFieldInCalculator(fieldId) {
  const field = state.fields.find((f) => f.id === fieldId);
  if (!field) return;
  const crop = CROPS_DB[field.cropId];
  const reqHives = Math.ceil(field.areaHa * crop.normHivesPerHa);

  document.getElementById('calc-crop').value = field.cropId;
  document.getElementById('calc-area').value = field.areaHa;
  document.getElementById('calc-base-yield').value = crop.baseYieldTonsHa;
  document.getElementById('calc-crop-price').value = crop.cropPriceRubTon;
  document.getElementById('calc-fee').value = field.feePerHiveRub;
  document.getElementById('calc-hives').value = reqHives;

  recalcCalculator();
  switchTab('calculator');
  showToast(`В калькулятор загружено поле «${field.name}» (${field.areaHa} га)`);
}

/* ==================== БИРЖА КОНТРАКТОВ ==================== */

function renderExchangeGrid(analysis) {
  const grid = document.getElementById('contracts-grid');
  if (!grid || !analysis) return;

  const cropFilter = document.getElementById('filter-crop').value;
  const statusFilter = document.getElementById('filter-status').value;

  const filtered = analysis.fieldReports.filter((rep) => {
    if (cropFilter !== 'all' && rep.field.cropId !== cropFilter) return false;
    if (statusFilter === 'deficit' && rep.coveragePct >= 80) return false;
    if (statusFilter === 'covered' && rep.coveragePct < 80) return false;
    if (statusFilter === 'safe-only' && (!rep.field.pesticideSilenceConfirmed || rep.saturnAlerts.length > 0)) {
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="panel-card" style="padding:24px;grid-column:1/-1;text-align:center;color:var(--text-muted);">
      По выбранным фильтрам заявок на опыление не найдено.
    </div>`;
    return;
  }

  grid.innerHTML = filtered
    .map((rep) => {
      const { field, crop, centroid, requiredHives, effectiveHives, coveragePct, deficitHives, saturnAlerts } = rep;
      const isSigned = state.signedContracts.has(field.id);
      const econ = calculateDualEconomics({
        cropId: field.cropId,
        areaHa: field.areaHa,
        hives: requiredHives,
        baseYieldTonsHa: crop.baseYieldTonsHa,
        cropPriceRubTon: crop.cropPriceRubTon,
        feePerHiveRub: field.feePerHiveRub,
        honeyPriceRubKg: 240,
      });

      const safetyBadge =
        saturnAlerts.length > 0
          ? `<span class="status-pill danger">⚠️ ФГИС «Сатурн» (${saturnAlerts[0].distKm.toFixed(1)} км)</span>`
          : field.pesticideSilenceConfirmed
            ? `<span class="status-pill safe">🛡️ Пестицидная тишина</span>`
            : `<span class="status-pill warn">⏳ Тишина не подтверждена</span>`;

      const contractBadge = isSigned
        ? `<span class="status-pill safe">✅ Контракт оформлен</span>`
        : `<span class="status-pill warn">Дефицит: ${deficitHives} сем.</span>`;

      return `
        <article class="lot-card">
          <div>
            <div class="lot-card-head">
              <span class="lot-crop-tag">${crop.icon} ${crop.shortName} • ${field.areaHa} га</span>
              ${safetyBadge}
            </div>
            <h4 style="margin:10px 0 3px;font-size:1.05rem;">${field.name}</h4>
            <div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:10px;">
              ${field.farm} • Кадастр ${field.cadastral}
            </div>

            <div class="lot-meta-grid">
              <div><span>Цветение</span><b>${field.bloomStart} — ${field.bloomEnd}</b></div>
              <div><span>Оплата за улей</span><b>${formatRub(field.feePerHiveRub)}</b></div>
              <div><span>Потребность / в 2 км</span><b>${requiredHives} / ${effectiveHives} сем. (${coveragePct}%)</b></div>
              <div><span>Доход пасеки (мёд+контракт)</span><b>${formatRub(econ.beekeeperTotalIncomeRub)}</b></div>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;font-size:0.8rem;">
              <span>Прогноз прибавки агроному: <b>+${econ.yieldGainTons.toFixed(1)} т</b></span>
              ${contractBadge}
            </div>
          </div>

          <div class="lot-actions">
            <button class="btn btn-amber btn-sm" data-passport="${field.id}" type="button">
              📄 Паспорт кочёвки
            </button>
            ${
              deficitHives > 0
                ? `<button class="btn btn-emerald btn-sm" data-assign-brigade="${field.id}" type="button">
                    🚛 Поставить пасеку
                   </button>`
                : ''
            }
            <button class="btn btn-outline btn-sm" data-focus-field="${centroid[0]},${centroid[1]}" type="button">
              🗺️ Карта
            </button>
            <button class="btn btn-outline btn-sm" data-calc-field="${field.id}" type="button">
              🧮
            </button>
          </div>
        </article>
      `;
    })
    .join('');

  grid.querySelectorAll('[data-passport]').forEach((btn) => {
    btn.addEventListener('click', () => openPassportModal(btn.dataset.passport));
  });
  grid.querySelectorAll('[data-calc-field]').forEach((btn) => {
    btn.addEventListener('click', () => openFieldInCalculator(btn.dataset.calcField));
  });
  grid.querySelectorAll('[data-focus-field]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [lat, lon] = btn.dataset.focusField.split(',').map(Number);
      switchTab('gis');
      setTimeout(() => gisMap?.focusPoint(lat, lon, 13), 120);
    });
  });
  grid.querySelectorAll('[data-assign-brigade]').forEach((btn) => {
    btn.addEventListener('click', () => deployNomadicTrailerToField(btn.dataset.assignBrigade));
  });
}

function deployNomadicTrailerToField(fieldId) {
  const field = state.fields.find((f) => f.id === fieldId);
  if (!field) return;
  const edgePoint = field.polygon[0];
  const standLat = Number((edgePoint[0] - 0.0012).toFixed(5));
  const standLon = Number((edgePoint[1] + 0.0015).toFixed(5));

  // Перемещаем свободную бригаду api-5 или создаём новый кочевой прицеп
  const freeBrigade = state.apiaries.find((a) => !a.assignedFieldId);
  if (freeBrigade) {
    freeBrigade.lat = standLat;
    freeBrigade.lon = standLon;
    freeBrigade.assignedFieldId = field.id;
    showToast(`Кочевая бригада «${freeBrigade.name}» (${freeBrigade.hivesCount} ульев) переброшена к полю «${field.name}»!`);
  } else {
    const nextNum = state.apiaries.length + 1;
    state.apiaries.push({
      id: `api-${Date.now()}`,
      name: `Кочевой отряд №${nextNum} «АпиСервис»`,
      beekeeper: 'Соколов И.В.',
      phone: '+7 (910) 552-18-04',
      vetPassport: `ВП-57-04910${nextNum}`,
      type: 'nomadic',
      trailerType: 'Мобильный павильон (80 ульев Дадан)',
      hivesCount: 80,
      lat: standLat,
      lon: standLon,
      assignedFieldId: field.id,
    });
    showToast(`На кромку поля «${field.name}» поставлен новый кочевой прицеп на 80 ульев!`);
  }

  state.signedContracts.add(field.id);
  refreshAll();
}

/* ==================== ПАСПОРТ КОЧЁВКИ ==================== */

function openPassportModal(fieldId) {
  const rep = state.lastAnalysis?.fieldReports.find((r) => r.field.id === fieldId);
  if (!rep) return;

  state.activePassportFieldId = fieldId;
  const { field, crop, centroid, requiredHives, nearbyApiaries, saturnAlerts } = rep;

  // Ищем закреплённую или ближайшую пасеку
  let assignedApiary = state.apiaries.find((a) => a.assignedFieldId === field.id) || nearbyApiaries[0]?.apiary;
  if (!assignedApiary) {
    assignedApiary = state.apiaries.find((a) => !a.assignedFieldId) || state.apiaries[0];
  }

  const econ = calculateDualEconomics({
    cropId: field.cropId,
    areaHa: field.areaHa,
    hives: Math.min(requiredHives, assignedApiary.hivesCount),
    baseYieldTonsHa: crop.baseYieldTonsHa,
    cropPriceRubTon: crop.cropPriceRubTon,
    feePerHiveRub: field.feePerHiveRub,
    honeyPriceRubKg: 240,
  });

  const contractCode = `АПК-2026-${field.id.toUpperCase()}-${assignedApiary.id.toUpperCase()}`;
  const isSigned = state.signedContracts.has(field.id);
  const standCoord = `${(centroid[0] - 0.002).toFixed(5)}, ${(centroid[1] + 0.002).toFixed(5)}`;
  const qrPayload = `${contractCode}|CAD:${field.cadastral}|GPS:${standCoord}|HIVES:${assignedApiary.hivesCount}`;
  const qrSvg = generateQrSvg(qrPayload);

  const saturnProtocol =
    saturnAlerts.length > 0
      ? `<span style="color:#b91c1c;font-weight:700;">⚠️ Обнаружена плановая обработка ФГИС «Сатурн» №${saturnAlerts[0].treatment.saturnNumber} в ${saturnAlerts[0].distKm.toFixed(1)} км (${saturnAlerts[0].treatment.dateWindow}). Требуется согласование окна изоляции!</span>`
      : `<span style="color:#047857;font-weight:700;">✅ В радиусе 7 км (ФЗ-490) на период ${field.bloomStart} — ${field.bloomEnd} опасных обработок 1–2 класса во ФГИС «Сатурн» не выявлено.</span>`;

  document.getElementById('passport-content').innerHTML = `
    <div class="passport-sheet">
      <div class="passport-top">
        <div>
          <div style="font-size:0.78rem;color:#475569;text-transform:uppercase;font-weight:700;">
            Платформа координации АПК «АпиКонтракт»
          </div>
          <h2 style="margin:4px 0 6px;font-size:1.25rem;">ПАСПОРТ-ДОГОВОР КОЧЁВКИ И ОПЫЛЕНИЯ № ${contractCode}</h2>
          <div style="font-size:0.84rem;">
            Статус: <b>${isSigned ? '✅ Подписан и зафиксирован в ГИС-реестре' : '📝 Проект контракта (ожидает фиксации)'}</b>
          </div>
        </div>
        <div class="passport-qr-box">
          ${qrSvg}
          <div style="font-size:0.68rem;color:#475569;margin-top:2px;">Проверка в реестре</div>
        </div>
      </div>

      <table class="passport-table">
        <tr>
          <th>Сельхозпроизводитель (Заказчик)</th>
          <td><b>${field.farm}</b> • Агроном: ${field.agronomist} (${field.phone})</td>
        </tr>
        <tr>
          <th>Участок и кадастровый номер</th>
          <td>${field.name} • Кадастр <b>${field.cadastral}</b> • ${crop.name} (${field.areaHa} га)</td>
        </tr>
        <tr>
          <th>Пасека (Исполнитель)</th>
          <td><b>${assignedApiary.name}</b> • ${assignedApiary.beekeeper} (${assignedApiary.phone})<br/>Ветеринарный паспорт пасеки: <b>${assignedApiary.vetPassport}</b></td>
        </tr>
        <tr>
          <th>Мощность опыления и расчёт</th>
          <td>Заявлено ульев: <b>${assignedApiary.hivesCount} пчелосемей</b> (норматив поля: ${requiredHives})<br/>Оплата услуги: ${formatRub(field.feePerHiveRub)}/семья (Итого: <b>${formatRub(econ.contractCostRub)}</b>) • Ожидаемая прибавка урожая: <b>+${econ.yieldGainTons.toFixed(1)} т</b></td>
        </tr>
        <tr>
          <th>GPS точка разгрузки прицепа</th>
          <td><b>${standCoord}</b> (лесополоса у кромки поля)<br/>Подъезд: ${field.nightAccessRoad}</td>
        </tr>
        <tr>
          <th>Окно ночного заезда и сроки</th>
          <td>Заезд строго в тёмное время суток: <b>22:00 – 04:00</b> • Период цветения: <b>${field.bloomStart} — ${field.bloomEnd}</b></td>
        </tr>
        <tr>
          <th>Протокол проверки ФГИС «Сатурн» (ФЗ-490)</th>
          <td>${saturnProtocol}</td>
        </tr>
      </table>

      <div style="font-size:0.78rem;color:#475569;margin-top:12px;">
        Хозяйство-заказчик обязуется соблюдать режим «пестицидной тишины» в период цветения культуры, а при вынужденном применении СЗР 3–4 класса уведомлять пчеловода через систему минимум за 5 суток до выезда опрыскивателя.
      </div>
    </div>
  `;

  document.getElementById('passport-modal').classList.remove('hidden');
}

/* ==================== УПРАВЛЕНИЕ ПАСЕКАМИ, ПОЛЯМИ И СЗР ==================== */

const PLACEMENT_HINTS = {
  apiary: '🎯 Прицел пасеки: кликните в любое место карты, где хотите разместить ульи.',
  field: '🎯 Прицел поля: кликните на карте центр нового поля, которое нужно опылить.',
  treatment: '🎯 Прицел СЗР: кликните точку очага химобработки, чтобы увидеть зону 7 км и ветровой шлейф.',
};

function startPlacementMode(mode) {
  const banner = document.getElementById('placement-banner');
  const textEl = document.getElementById('placement-banner-text');

  if (!mode) {
    banner.classList.add('hidden');
    gisMap?.setPlacementMode(null);
    return;
  }

  if (state.activeTab !== 'gis') {
    switchTab('gis');
  }
  textEl.textContent = PLACEMENT_HINTS[mode] || '🎯 Кликните на карту.';
  banner.classList.remove('hidden');
  gisMap?.setPlacementMode(mode);
}

function populateApiaryFieldSelect() {
  const sel = document.getElementById('ap-field');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Авто (все поля в радиусе 2 км)</option>';
  state.fields.forEach((f) => {
    const crop = CROPS_DB[f.cropId];
    sel.appendChild(new Option(`${crop.icon} ${f.name} (${f.areaHa} га)`, f.id));
  });
  if (current) sel.value = current;
}

function updateApiarySafetyPreview(lat, lon) {
  const previewEl = document.getElementById('ap-safety-preview');
  if (!previewEl) return;

  const numLat = Number(lat);
  const numLon = Number(lon);
  if (!Number.isFinite(numLat) || !Number.isFinite(numLon)) {
    previewEl.innerHTML = '';
    return;
  }

  const assignedFieldId = document.getElementById('ap-field')?.value;
  const assignedField = assignedFieldId ? state.fields.find((f) => f.id === assignedFieldId) : null;
  const trailerVal = document.getElementById('ap-trailer')?.value || '';
  const isStationary = trailerVal.toLowerCase().includes('стационар');
  const activeStart = !isStationary && assignedField ? assignedField.bloomStart : '0000-01-01';
  const activeEnd = !isStationary && assignedField ? assignedField.bloomEnd : '9999-12-31';

  const hits = [];
  for (const tr of state.treatments) {
    const pInfo = PESTICIDE_CLASSES[tr.hazardClass] || PESTICIDE_CLASSES[3];
    const distKm = haversineKm(numLat, numLon, tr.lat, tr.lon);
    const inPlume = isPointInWindPlume(
      numLat,
      numLon,
      tr.lat,
      tr.lon,
      state.wind.directionDeg,
      state.wind.speedMs
    );
    if ((distKm <= pInfo.bufferRadiusKm || inPlume) && datesOverlap(activeStart, activeEnd, tr.startDate, tr.endDate)) {
      hits.push({ tr, pInfo, distKm, inPlume });
    }
  }

  if (hits.length > 0) {
    const h = hits[0];
    previewEl.innerHTML = `<span class="status-pill danger" style="width:100%;justify-content:flex-start;border-radius:8px;padding:8px 10px;">
      🚨 Точка в ${h.distKm.toFixed(1)} км от обработки ${h.tr.saturnNumber}${h.inPlume ? ' + прямо в ветровом шлейфе!' : ' (радиус 7 км).'}
    </span>`;
  } else {
    previewEl.innerHTML = `<span class="status-pill safe" style="width:100%;justify-content:flex-start;border-radius:8px;padding:8px 10px;">
      ✅ Безопасная точка стоянки (вне 7-км зон СЗР и ветрового сноса).
    </span>`;
  }
}

function openApiaryModal({ apiary = null, lat = null, lon = null } = {}) {
  populateApiaryFieldSelect();
  const isEdit = Boolean(apiary);
  const idx = state.apiaries.length + 1;

  document.getElementById('apiary-modal-title').textContent = isEdit
    ? `✏️ Изменить пасеку: ${apiary.name}`
    : '🐝 Добавить пасеку (ульи) на карту';

  document.getElementById('ap-id').value = isEdit ? apiary.id : '';
  document.getElementById('ap-name').value = isEdit ? apiary.name : `Пасека №${idx}`;
  document.getElementById('ap-beekeeper').value = isEdit ? apiary.beekeeper : 'Пасечник кластера';
  document.getElementById('ap-hives').value = isEdit ? apiary.hivesCount : 60;
  document.getElementById('ap-trailer').value = isEdit
    ? apiary.trailerType
    : 'Кочевая пасека (ульи Дадан)';
  document.getElementById('ap-field').value = isEdit && apiary.assignedFieldId ? apiary.assignedFieldId : '';
  document.getElementById('ap-vet').value = isEdit ? apiary.vetPassport : `ВП-57-0881${idx}`;
  document.getElementById('ap-phone').value = isEdit ? apiary.phone : '+7 (915) 440-22-18';

  const targetLat = Number((isEdit ? apiary.lat : (lat ?? CLUSTER_CENTER.lat)).toFixed(4));
  const targetLon = Number((isEdit ? apiary.lon : (lon ?? CLUSTER_CENTER.lon)).toFixed(4));
  document.getElementById('ap-lat').value = targetLat;
  document.getElementById('ap-lon').value = targetLon;

  const delBtn = document.getElementById('btn-delete-apiary-modal');
  delBtn.classList.toggle('hidden', !isEdit);
  document.getElementById('btn-save-apiary').textContent = isEdit
    ? 'Сохранить изменения'
    : 'Поставить на карту';

  updateApiarySafetyPreview(targetLat, targetLon);
  document.getElementById('apiary-modal').classList.remove('hidden');
}

function openFieldModal(lat, lon) {
  const idx = state.fields.length + 1;
  document.getElementById('nf-name').value = `Поле №${idx} «Новое»`;
  document.getElementById('nf-farm').value = 'КФХ «Урожай»';
  document.getElementById('nf-lat').value = Number((lat ?? CLUSTER_CENTER.lat).toFixed(4));
  document.getElementById('nf-lon').value = Number((lon ?? CLUSTER_CENTER.lon).toFixed(4));
  document.getElementById('add-field-modal').classList.remove('hidden');
}

function openTreatmentModal(lat, lon) {
  document.getElementById('tr-lat').value = Number((lat ?? CLUSTER_CENTER.lat).toFixed(4));
  document.getElementById('tr-lon').value = Number((lon ?? CLUSTER_CENTER.lon).toFixed(4));
  document.getElementById('treatment-modal').classList.remove('hidden');
}

function deleteApiaryById(apiaryId) {
  const target = state.apiaries.find((a) => a.id === apiaryId);
  if (!target) return;
  state.apiaries = state.apiaries.filter((a) => a.id !== apiaryId);
  document.getElementById('apiary-modal').classList.add('hidden');
  refreshAll();
  showToast(`Пасека «${target.name}» удалена с карты, покрытие полей пересчитано.`);
}

function deleteFieldById(fieldId) {
  const target = state.fields.find((f) => f.id === fieldId);
  if (!target) return;
  state.fields = state.fields.filter((f) => f.id !== fieldId);
  state.signedContracts.delete(fieldId);
  populateApiaryFieldSelect();
  refreshAll();
  showToast(`Поле «${target.name}» удалено с карты.`);
}

function deleteTreatmentById(trId) {
  const target = state.treatments.find((t) => t.id === trId);
  if (!target) return;
  state.treatments = state.treatments.filter((t) => t.id !== trId);
  refreshAll();
  showToast(`Зона химобработки ${target.saturnNumber} убрана с карты.`);
}

function resetDemoScenario() {
  state.fields = structuredClone(INITIAL_FIELDS);
  state.apiaries = structuredClone(INITIAL_APIARIES);
  state.treatments = structuredClone(INITIAL_SATURN_TREATMENTS);
  state.signedContracts = new Set(['fld-1', 'fld-2']);
  startPlacementMode(null);
  populateApiaryFieldSelect();
  refreshAll();
  gisMap?.focusPoint(CLUSTER_CENTER.lat, CLUSTER_CENTER.lon, CLUSTER_CENTER.zoom);
  showToast('🔄 Демо-сценарий кластера восстановлен к исходному состоянию.');
}

/* ==================== НАВИГАЦИЯ И СОБЫТИЯ ==================== */

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.view-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${tabName}`);
  });
  if (tabName === 'gis' && gisMap?.map) {
    setTimeout(() => gisMap.map.invalidateSize(), 60);
  }
}

function bindEvents() {
  // Вкладки
  document.querySelectorAll('.view-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Слои ГИС-карты
  document.getElementById('layer-flight').addEventListener('change', (e) => {
    gisMap.setLayerVisibility('flight', e.target.checked);
  });
  document.getElementById('layer-saturn').addEventListener('change', (e) => {
    gisMap.setLayerVisibility('saturn', e.target.checked);
  });
  document.getElementById('layer-plume').addEventListener('change', (e) => {
    gisMap.setLayerVisibility('plume', e.target.checked);
  });

  // Симулятор ветра
  document.getElementById('wind-dir-slider').addEventListener('input', (e) => {
    state.wind.directionDeg = Number(e.target.value);
    updateMeteoPanel();
    refreshAll();
  });
  document.getElementById('wind-speed-slider').addEventListener('input', (e) => {
    state.wind.speedMs = Number(e.target.value);
    updateMeteoPanel();
    refreshAll();
  });

  // Кнопка обновления погоды по центру видимой области карты
  document.getElementById('btn-refresh-weather').addEventListener('click', () => {
    const center = gisMap ? gisMap.getCenter() : { lat: CLUSTER_CENTER.lat, lon: CLUSTER_CENTER.lon };
    loadWeatherAt(center.lat, center.lon, true);
  });

  // Прицел на карту: пасека, поле, зона химобработки
  document.getElementById('btn-place-apiary').addEventListener('click', () => startPlacementMode('apiary'));
  document.getElementById('btn-open-add-field').addEventListener('click', () => startPlacementMode('field'));
  document.getElementById('btn-exchange-add-field').addEventListener('click', () => startPlacementMode('field'));
  document.getElementById('btn-place-treatment').addEventListener('click', () => startPlacementMode('treatment'));
  document.getElementById('btn-cancel-placement').addEventListener('click', () => startPlacementMode(null));
  document.getElementById('btn-reset-demo').addEventListener('click', resetDemoScenario);

  // Фильтры биржи
  document.getElementById('filter-crop').addEventListener('change', () => renderExchangeGrid(state.lastAnalysis));
  document.getElementById('filter-status').addEventListener('change', () => renderExchangeGrid(state.lastAnalysis));

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.closeModal)?.classList.add('hidden');
    });
  });

  document.getElementById('add-field-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const cropId = document.getElementById('nf-crop').value;
    const areaHa = Math.max(5, Number(document.getElementById('nf-area').value));
    const feePerHiveRub = Number(document.getElementById('nf-fee').value);
    const centerLat = Number(Number(document.getElementById('nf-lat').value).toFixed(4));
    const centerLon = Number(Number(document.getElementById('nf-lon').value).toFixed(4));

    const newField = {
      id: `fld-${Date.now()}`,
      name: document.getElementById('nf-name').value.trim(),
      farm: document.getElementById('nf-farm').value.trim(),
      agronomist: document.getElementById('nf-agronomist').value.trim(),
      phone: '+7 (910) 300-44-12',
      cadastral: document.getElementById('nf-cadastral').value.trim(),
      cropId,
      areaHa,
      bloomStart: document.getElementById('nf-bloom-start').value || '2026-06-12',
      bloomEnd: document.getElementById('nf-bloom-end').value || '2026-07-05',
      feePerHiveRub,
      pesticideSilenceConfirmed: document.getElementById('nf-silence').checked,
      nightAccessRoad: 'Полевой съезд с южной стороны лесополосы',
      polygon: buildFieldPolygonFromCenter(centerLat, centerLon, areaHa),
    };

    state.fields.unshift(newField);
    populateApiaryFieldSelect();
    document.getElementById('add-field-modal').classList.add('hidden');
    e.target.reset();
    refreshAll();
    const [cLat, cLon] = polygonCentroid(newField.polygon);
    switchTab('gis');
    gisMap.focusPoint(cLat, cLon, 13);
    showToast(`🌾 Поле «${newField.name}» (${areaHa} га) размещено на карте и бирже!`);
  });

  // Добавление новой зоны химобработки (ФГИС Сатурн)
  document.getElementById('treatment-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const lat = Number(Number(document.getElementById('tr-lat').value).toFixed(4));
    const lon = Number(Number(document.getElementById('tr-lon').value).toFixed(4));
    const hazardClass = Number(document.getElementById('tr-hazard').value);
    const num = Math.floor(100 + Math.random() * 899);

    const startDate = document.getElementById('tr-start').value || '2026-06-18';
    const endDate = document.getElementById('tr-end').value || '2026-06-22';

    const tr = {
      id: `sat-${Date.now()}`,
      saturnNumber: `SAT-57-${num}`,
      farm: document.getElementById('tr-farm').value.trim(),
      cadastral: `57:20:0060102:${num}`,
      crop: 'Зерновые / технические культуры',
      pesticideName: document.getElementById('tr-pesticide').value.trim(),
      hazardClass,
      startDate,
      endDate,
      dateWindow: `${startDate} — ${endDate} (22:00–04:00)`,
      lat,
      lon,
      polygon: buildFieldPolygonFromCenter(lat, lon, 110),
    };

    state.treatments.push(tr);
    document.getElementById('treatment-modal').classList.add('hidden');
    refreshAll();
    gisMap?.focusPoint(lat, lon, 12);
    showToast(`☢️ Зона СЗР ${tr.saturnNumber} добавлена! Пересчитаны 7-км буфер и ветровой снос.`);
  });

  // Форма добавления/редактирования пасеки
  ['ap-lat', 'ap-lon', 'ap-field', 'ap-trailer'].forEach((id) => {
    const evt = id === 'ap-field' ? 'change' : 'input';
    document.getElementById(id).addEventListener(evt, () => {
      updateApiarySafetyPreview(
        document.getElementById('ap-lat').value,
        document.getElementById('ap-lon').value
      );
    });
  });

  document.getElementById('btn-delete-apiary-modal').addEventListener('click', () => {
    const id = document.getElementById('ap-id').value;
    if (id) deleteApiaryById(id);
  });

  document.getElementById('apiary-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const existingId = document.getElementById('ap-id').value;
    const lat = Number(Number(document.getElementById('ap-lat').value).toFixed(5));
    const lon = Number(Number(document.getElementById('ap-lon').value).toFixed(5));
    const hivesCount = Math.max(1, Number(document.getElementById('ap-hives').value));
    const trailerType = document.getElementById('ap-trailer').value.trim();
    const payload = {
      name: document.getElementById('ap-name').value.trim(),
      beekeeper: document.getElementById('ap-beekeeper').value.trim(),
      phone: document.getElementById('ap-phone').value.trim(),
      vetPassport: document.getElementById('ap-vet').value.trim(),
      type: trailerType.toLowerCase().includes('стационар') ? 'stationary' : 'nomadic',
      trailerType,
      hivesCount,
      lat,
      lon,
      assignedFieldId: document.getElementById('ap-field').value || null,
    };

    if (existingId) {
      const idx = state.apiaries.findIndex((a) => a.id === existingId);
      if (idx !== -1) {
        state.apiaries[idx] = { ...state.apiaries[idx], ...payload };
      }
      showToast(`✅ Данные пасеки «${payload.name}» (${hivesCount} ульев) обновлены!`);
    } else {
      state.apiaries.push({
        id: `api-${Date.now()}`,
        ...payload,
      });
      const nearestHazard = state.treatments.find((tr) => haversineKm(lat, lon, tr.lat, tr.lon) <= 7.0);
      if (nearestHazard) {
        showToast(
          `⚠️ Точок «${payload.name}» поставлен, но попадает в 7-км зону ФГИС «Сатурн» ${nearestHazard.saturnNumber}!`
        );
      } else {
        showToast(`✅ Кочевой точок «${payload.name}» (${hivesCount} ульев) поставлен! Радиус 2 км пересчитан.`);
      }
    }

    document.getElementById('apiary-modal').classList.add('hidden');
    refreshAll();
    gisMap?.focusPoint(lat, lon, 13);
  });

  // Кнопки паспорта
  document.getElementById('btn-print-passport').addEventListener('click', () => window.print());
  document.getElementById('btn-confirm-contract').addEventListener('click', () => {
    if (!state.activePassportFieldId) return;
    state.signedContracts.add(state.activePassportFieldId);
    document.getElementById('passport-modal').classList.add('hidden');
    refreshAll();
    showToast('Контракт опыления зафиксирован и синхронизирован с картой!');
  });
}

function bootstrap() {
  gisMap = new ApiGisMap('gis-map', {
    onOpenInCalculator: openFieldInCalculator,
    onOpenPassport: openPassportModal,
    onMapTargetClick: (mode, lat, lon) => {
      startPlacementMode(null);
      if (mode === 'apiary') {
        openApiaryModal({ lat, lon });
      } else if (mode === 'field') {
        openFieldModal(lat, lon);
      } else if (mode === 'treatment') {
        openTreatmentModal(lat, lon);
      }
    },
    onEditApiary: (apiaryId) => {
      const apiary = state.apiaries.find((a) => a.id === apiaryId);
      if (apiary) openApiaryModal({ apiary });
    },
    onDeleteApiary: (apiaryId) => {
      deleteApiaryById(apiaryId);
    },
    onDeleteField: (fieldId) => {
      deleteFieldById(fieldId);
    },
    onDeleteTreatment: (trId) => {
      deleteTreatmentById(trId);
    },
    onMoveApiary: (apiaryId, lat, lon) => {
      const apiary = state.apiaries.find((a) => a.id === apiaryId);
      if (!apiary) return;
      apiary.lat = Number(lat.toFixed(4));
      apiary.lon = Number(lon.toFixed(4));
      refreshAll();
      const hazard = state.treatments.find((tr) => haversineKm(apiary.lat, apiary.lon, tr.lat, tr.lon) <= 7.0);
      if (hazard) {
        showToast(`⚠️ «${apiary.name}» перемещена в 7-км зону обработки ${hazard.saturnNumber}!`);
      } else {
        showToast(`📍 Позиция «${apiary.name}» обновлена — радиусы 2 км пересчитаны.`);
      }
    },
  });

  gisMap.init();
  initCalculatorControls();
  populateApiaryFieldSelect();
  bindEvents();
  updateMeteoPanel();
  refreshAll();
  loadWeatherAt(CLUSTER_CENTER.lat, CLUSTER_CENTER.lon, false);
}

document.addEventListener('DOMContentLoaded', bootstrap);
