/**
 * Модуль двусторонних агроэкономических расчётов и метеоанализа (Open-Meteo + ΔT).
 */

import { CROPS_DB } from './data.js?v=14';

/**
 * Расчёт двусторонней экономики опыления (Выгода агронома ↔ Доход пасечника).
 */
export function calculateDualEconomics({
  cropId,
  areaHa,
  hives,
  baseYieldTonsHa,
  cropPriceRubTon,
  feePerHiveRub,
  honeyPriceRubKg,
}) {
  const crop = CROPS_DB[cropId] || CROPS_DB.sunflower;
  const safeArea = Math.max(1, Number(areaHa) || 1);
  const safeHives = Math.max(0, Number(hives) || 0);
  const safeBaseYield = Math.max(0.1, Number(baseYieldTonsHa) || crop.baseYieldTonsHa);
  const safeCropPrice = Math.max(0, Number(cropPriceRubTon) || crop.cropPriceRubTon);
  const safeFee = Math.max(0, Number(feePerHiveRub) || 0);
  const safeHoneyPrice = Math.max(0, Number(honeyPriceRubKg) || 240);

  const requiredHives = Math.ceil(safeArea * crop.normHivesPerHa);
  const rawRatio = requiredHives > 0 ? safeHives / requiredHives : 1;
  const saturationFactor = Math.min(1, rawRatio);
  const saturationPct = Math.round(rawRatio * 100);

  // Агрономический блок
  const yieldGainTons = safeArea * safeBaseYield * (crop.yieldBoostPct / 100) * saturationFactor;
  const grossGainRub = Math.round(yieldGainTons * safeCropPrice);
  const contractCostRub = Math.round(safeHives * safeFee);
  const agroNetProfitRub = grossGainRub - contractCostRub;
  const roiPct = contractCostRub > 0 ? Math.round((agroNetProfitRub / contractCostRub) * 100) : 0;

  // Пчеловодческий блок
  const nectarPoolKg = Math.round(safeArea * crop.nectarKgHa);
  const extractableHoneyKg = nectarPoolKg * crop.honeyShare;
  const marketableHoneyKg = Math.round(Math.min(extractableHoneyKg, safeHives * 38));
  const honeyPerHiveKg = safeHives > 0 ? marketableHoneyKg / safeHives : 0;
  const honeyRevenueRub = Math.round(marketableHoneyKg * safeHoneyPrice);
  const beekeeperTotalIncomeRub = contractCostRub + honeyRevenueRub;

  // Медовый лимит (порог перегрузки пасеки, при котором сбор на улей падает ниже 16 кг)
  const optimalForageMaxHives = Math.max(1, Math.floor(extractableHoneyKg / 16));
  const isForageOvercrowded = safeHives > optimalForageMaxHives && safeHives > requiredHives;

  // Подбор практической рекомендации
  let advice = '';
  if (saturationPct < 75) {
    const missing = Math.max(0, requiredHives - safeHives);
    advice = `⚠️ Недостаточное опыление (${saturationPct}%): хозяйство недополучает урожай. Докупите или привлеките ещё ${missing} пчелосемей до нормы ${requiredHives} семей — прибавка окупается в ${roiPct > 0 ? (grossGainRub / Math.max(1, contractCostRub)).toFixed(1) : '3–5'} раза.`;
  } else if (isForageOvercrowded) {
    advice = `🍯 Внимание на нектарный баланс: для опыления пчёл достаточно, но для товарного медосбора поле прокормит максимум ${optimalForageMaxHives} семей (сейчас ${safeHives}). Выход мёда снижен до ${honeyPerHiveKg.toFixed(1)} кг/улей — компенсируйте пасечнику повышенной ставкой опыления.`;
  } else {
    advice = `✅ Оптимальный баланс Win-Win: поле закрыто на ${Math.min(100, saturationPct)}%, пасека берёт ${honeyPerHiveKg.toFixed(1)} кг/улей товарного мёда без конкуренции. Рекомендуется поставить 2 точка по краям поля для равномерного встречного лёта.`;
  }

  return {
    crop,
    requiredHives,
    saturationPct,
    yieldGainTons,
    grossGainRub,
    contractCostRub,
    agroNetProfitRub,
    roiPct,
    nectarPoolKg,
    marketableHoneyKg,
    honeyPerHiveKg,
    honeyRevenueRub,
    beekeeperTotalIncomeRub,
    optimalForageMaxHives,
    isForageOvercrowded,
    advice,
  };
}

/**
 * Психрометрическая разница ΔT по формуле Сталла (2011) для влажного термометра.
 */
export function calculateDeltaT(tempC, rhPct) {
  const T = Number(tempC);
  const RH = Math.min(100, Math.max(5, Number(rhPct)));
  const tw =
    T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) +
    Math.atan(T + RH) -
    Math.atan(RH - 1.676331) +
    0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) -
    4.686035;
  return Math.max(0, T - tw);
}

/**
 * Преобразует азимут ветра (в градусах) в русскую сторону света.
 */
export function formatWindDirection(deg) {
  const dirs = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
  const norm = ((deg % 360) + 360) % 360;
  const idx = Math.round(norm / 45) % 8;
  return `${Math.round(norm)}° (${dirs[idx]})`;
}

/**
 * Оценка активности лёта пчёл и безопасности опрыскивания по метеоданным.
 */
export function evaluateMeteoConditions(tempC, humidityPct, windSpeedMs, windDirDeg) {
  const deltaT = calculateDeltaT(tempC, humidityPct);

  // Оценка лёта пчёл
  let flightLevel = 'safe';
  let flightText = '🐝 Лёт пчёл: активное опыление (оптимальные условия)';
  if (tempC < 12) {
    flightLevel = 'danger';
    flightText = '❄️ Лёт пчёл минимальный (температура ниже 12 °C, пчёлы в клубе)';
  } else if (windSpeedMs > 7.5 || tempC > 34) {
    flightLevel = 'warn';
    flightText = '💨 Лёт пчёл затруднён (сильный ветер или жара снижают работу на цветках)';
  }

  // Оценка риска сноса и испарения пестицидов
  let sprayLevel = 'safe';
  let sprayText = `💧 Индекс ΔT = ${deltaT.toFixed(1)} °C, ветер ${windSpeedMs.toFixed(1)} м/с: снос пестицидов в пределах нормы.`;
  if (windSpeedMs > 4.0) {
    sprayLevel = 'danger';
    sprayText = `🚨 Запрет опрыскивания! Ветер ${windSpeedMs.toFixed(1)} м/с уносит аэрозольный шлейф на пасеки (направление ${formatWindDirection(windDirDeg)}).`;
  } else if (deltaT > 8.5) {
    sprayLevel = 'warn';
    sprayText = `⚠️ Высокий ΔT (${deltaT.toFixed(1)} °C): мелкая капля СЗР испаряется в воздухе и дрейфует в шлейфе.`;
  } else if (deltaT < 2.0) {
    sprayLevel = 'warn';
    sprayText = `⚠️ Низкий ΔT (${deltaT.toFixed(1)} °C): высокая влажность, капля стекает с листа без эффекта.`;
  }

  return {
    deltaT,
    flightLevel,
    flightText,
    sprayLevel,
    sprayText,
  };
}

/**
 * Запрос живого метеопрогноза с Open-Meteo (с резервным оффлайн-сценарием).
 */
export async function fetchClusterWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const cur = data.current;
    if (!cur) throw new Error('Empty current weather');

    return {
      tempC: Number(cur.temperature_2m),
      humidityPct: Number(cur.relative_humidity_2m),
      windSpeedMs: Number(cur.wind_speed_10m),
      windDirectionDeg: Number(cur.wind_direction_10m),
      source: 'live',
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      tempC: 22.4,
      humidityPct: 54,
      windSpeedMs: 4.2,
      windDirectionDeg: 135,
      source: 'fallback',
      error: err.message,
    };
  }
}
