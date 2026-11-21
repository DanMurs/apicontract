/**
 * Главный оркестратор веб-платформы «АпиКонтракт».
 */

import {
  CLUSTER_CENTER,
  CROPS_DB,
  INITIAL_FIELDS,
  INITIAL_APIARIES,
  INITIAL_SATURN_TREATMENTS,
} from './data.js';
import { ApiGisMap, analyzeSpatialCoverage, polygonCentroid, haversineKm } from './map.js';
import {
  calculateDualEconomics,
  evaluateMeteoConditions,
  fetchClusterWeather,
  formatWindDirection,
} from './calculator.js';

const state = {
  role: 'dispatcher',
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
  },
  activePassportFieldId: null,
  lastAnalysis: null,
};

const ROLE_DESCRIPTIONS = {
  dispatcher: 'Режим диспетчера АПК: видны все поля, кочевые прицепы, 7-км зоны ФГИС «Сатурн» и снос ветром.',
  agronomist: 'Режим агронома: контролируйте дефицит опылителей на полях, считайте ROI и публикуйте заявки.',
  beekeeper: 'Режим пчеловода: выбирайте поля без пестицидного риска, ставьте прицеп на карту и оформляйте Паспорт.',
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

  updateKpis(analysis);
  renderSpatialSidebar(analysis);
  renderExchangeGrid(analysis);
  if (gisMap) {
    gisMap.render(analysis, state.treatments, state.wind);
  }
}

function updateKpis(analysis) {
  let totalHa = 0;
  let totalReq = 0;
  let totalCovered = 0;
  let totalPotentialGainRub = 0;
  let fieldHazards = 0;

  for (const rep of analysis.fieldReports) {
    totalHa += rep.field.areaHa;
    totalReq += rep.requiredHives;
    totalCovered += Math.min(rep.requiredHives, rep.effectiveHives);
    const econ = calculateDualEconomics({
      cropId: rep.field.cropId,
      areaHa: rep.field.areaHa,
      hives: rep.requiredHives,
      baseYieldTonsHa: rep.crop.baseYieldTonsHa,
      cropPriceRubTon: rep.crop.cropPriceRubTon,
      feePerHiveRub: rep.field.feePerHiveRub,
      honeyPriceRubKg: 240,
    });
    totalPotentialGainRub += econ.agroNetProfitRub;
    if (rep.saturnAlerts.length > 0) fieldHazards += 1;
  }

  const apiariesAtRisk = analysis.apiaryReports.filter((r) => r.isAtRisk).length;
  const totalHazards = fieldHazards + apiariesAtRisk;
  const coveragePct = totalReq > 0 ? Math.round((totalCovered / totalReq) * 100) : 0;

  document.getElementById('kpi-total-ha').textContent = `${totalHa.toLocaleString('ru-RU')} га`;
  document.getElementById('kpi-fields-count').textContent = `${state.fields.length} активных полей кластера`;
  document.getElementById('kpi-coverage').textContent = `${coveragePct}%`;
  document.getElementById('kpi-hives-ratio').textContent = `${totalCovered} / ${totalReq} семей в радиусе 2 км`;
  document.getElementById('kpi-yield-money').textContent = formatRub(totalPotentialGainRub);
  document.getElementById('kpi-hazards').textContent = `${totalHazards}`;
  document.getElementById('kpi-hazards-note').textContent =
    totalHazards > 0
      ? `Пасек в 7-км зоне риска: ${apiariesAtRisk} • Полей: ${fieldHazards}`
      : 'Все кочевые пасеки вне зоны сноса СЗР';
  document.getElementById('tab-lots-count').textContent = `${state.fields.length}`;
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
    const { field, crop, centroid, requiredHives, effectiveHives, coveragePct, saturnAlerts } = frep;
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
          ${field.areaHa} га • нужно ${requiredHives} сем. • сейчас в 2 км: <b>${effectiveHives}</b>
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
  const { tempC, humidityPct, source } = state.weather;
  const { directionDeg, speedMs } = state.wind;
  const evalRes = evaluateMeteoConditions(tempC, humidityPct, speedMs, directionDeg);

  document.getElementById('meteo-temp').textContent = `${tempC.toFixed(1)} °C`;
  document.getElementById('meteo-humidity').textContent = `${Math.round(humidityPct)} %`;
  document.getElementById('meteo-delta-t').textContent = `${evalRes.deltaT.toFixed(1)} °C`;

  const badge = document.getElementById('meteo-source-badge');
  badge.textContent = source === 'live' ? 'Live Open-Meteo' : 'Модель кластера';
  badge.className = `status-pill ${source === 'live' ? 'safe' : 'warn'}`;

  document.getElementById('wind-dir-label').textContent = formatWindDirection(directionDeg);
  document.getElementById('wind-speed-label').textContent = `${speedMs.toFixed(1)} м/с`;

  const flightEl = document.getElementById('meteo-flight-status');
  flightEl.innerHTML = `<span class="status-pill ${evalRes.flightLevel}" style="width:100%;justify-content:flex-start;border-radius:8px;padding:7px 10px;">${evalRes.flightText}</span>`;

  const sprayEl = document.getElementById('meteo-spray-status');
  sprayEl.innerHTML = `<span class="status-pill ${evalRes.sprayLevel}" style="width:100%;justify-content:flex-start;border-radius:8px;padding:7px 10px;">${evalRes.sprayText}</span>`;
}

async function initWeather() {
  const live = await fetchClusterWeather(CLUSTER_CENTER.lat, CLUSTER_CENTER.lon);
  state.weather = {
    tempC: live.tempC,
    humidityPct: live.humidityPct,
    source: live.source,
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
  // Переключение ролей
  document.querySelectorAll('.role-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.role = btn.dataset.role;
      document.querySelectorAll('.role-btn').forEach((b) => b.classList.toggle('active', b === btn));
      document.getElementById('role-banner-text').textContent = ROLE_DESCRIPTIONS[state.role];
    });
  });

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

  // Режим постановки кочевого прицепа кликом на карту
  const banner = document.getElementById('placement-banner');
  document.getElementById('btn-place-apiary').addEventListener('click', () => {
    banner.classList.remove('hidden');
    gisMap.setPlacementMode(true);
  });
  document.getElementById('btn-cancel-placement').addEventListener('click', () => {
    banner.classList.add('hidden');
    gisMap.setPlacementMode(false);
  });

  // Фильтры биржи
  document.getElementById('filter-crop').addEventListener('change', () => renderExchangeGrid(state.lastAnalysis));
  document.getElementById('filter-status').addEventListener('change', () => renderExchangeGrid(state.lastAnalysis));

  // Модальные окна
  const openAddField = () => document.getElementById('add-field-modal').classList.remove('hidden');
  document.getElementById('btn-open-add-field').addEventListener('click', openAddField);
  document.getElementById('btn-exchange-add-field').addEventListener('click', openAddField);

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.closeModal)?.classList.add('hidden');
    });
  });

  document.getElementById('add-field-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const cropId = document.getElementById('nf-crop').value;
    const areaHa = Number(document.getElementById('nf-area').value);
    const feePerHiveRub = Number(document.getElementById('nf-fee').value);
    const offset = (state.fields.length - 3) * 0.014;
    const baseLat = CLUSTER_CENTER.lat + 0.018 + (state.fields.length % 2 === 0 ? 0.008 : -0.012);
    const baseLon = CLUSTER_CENTER.lon + offset;

    const newField = {
      id: `fld-${Date.now()}`,
      name: document.getElementById('nf-name').value.trim(),
      farm: document.getElementById('nf-farm').value.trim(),
      agronomist: document.getElementById('nf-agronomist').value.trim(),
      phone: '+7 (910) 300-44-12',
      cadastral: document.getElementById('nf-cadastral').value.trim(),
      cropId,
      areaHa,
      bloomStart: '2026-06-12',
      bloomEnd: '2026-07-05',
      feePerHiveRub,
      pesticideSilenceConfirmed: document.getElementById('nf-silence').checked,
      nightAccessRoad: 'Полевой съезд с южной стороны лесополосы',
      polygon: [
        [baseLat, baseLon],
        [baseLat + 0.009, baseLon + 0.002],
        [baseLat + 0.008, baseLon + 0.020],
        [baseLat - 0.001, baseLon + 0.018],
      ],
    };

    state.fields.unshift(newField);
    document.getElementById('add-field-modal').classList.add('hidden');
    e.target.reset();
    refreshAll();
    const [cLat, cLon] = polygonCentroid(newField.polygon);
    switchTab('gis');
    gisMap.focusPoint(cLat, cLon, 13);
    showToast(`Заявка «${newField.name}» добавлена на карту и биржу!`);
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
    onPlaceApiary: (lat, lon) => {
      const idx = state.apiaries.length + 1;
      const newApiary = {
        id: `api-${Date.now()}`,
        name: `Новый кочевой точок №${idx}`,
        beekeeper: 'Дежурный пасечник кластера',
        phone: '+7 (915) 440-22-18',
        vetPassport: `ВП-57-0881${idx}`,
        type: 'nomadic',
        trailerType: 'Кочевая платформа (60 ульев)',
        hivesCount: 60,
        lat: Number(lat.toFixed(5)),
        lon: Number(lon.toFixed(5)),
        assignedFieldId: null,
      };
      state.apiaries.push(newApiary);

      // Проверяем, не попал ли точок сразу под обработку ФГИС «Сатурн»
      const nearestHazard = state.treatments.find((tr) => haversineKm(lat, lon, tr.lat, tr.lon) <= 7.0);
      document.getElementById('placement-banner').classList.add('hidden');
      gisMap.setPlacementMode(false);
      refreshAll();

      if (nearestHazard) {
        showToast(`⚠️ Точок поставлен, но он попал в 7-км зону обработки ФГИС «Сатурн» ${nearestHazard.saturnNumber}!`);
      } else {
        showToast(`✅ Кочевой точок №${idx} (60 ульев) поставлен! Радиусы 2 км и покрытие полей пересчитаны.`);
      }
    },
  });

  gisMap.init();
  initCalculatorControls();
  bindEvents();
  updateMeteoPanel();
  refreshAll();
  initWeather();
}

document.addEventListener('DOMContentLoaded', bootstrap);
