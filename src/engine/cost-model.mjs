export const MODE_PROFILES = {
  sea: {
    label: '海运',
    speedKmh: 35, // ~19 knots average container service speed
    fixedDwellDays: 3.5, // origin + destination port handling & customs
    costPer1000Km: 1.0,
    baseCost: 1.5,
    reliabilityBase: 0.88,
  },
  air: {
    label: '空运',
    speedKmh: 820,
    fixedDwellDays: 1.2,
    transferDwellDays: 0.6,
    costPer1000Km: 14.0,
    baseCost: 4.0,
    transferCost: 2.5,
    reliabilityBase: 0.93,
  },
  rail: {
    label: '铁路',
    speedKmh: 45, // block speed incl. border customs & gauge breaks
    fixedDwellDays: 2.5,
    costPer1000Km: 3.2,
    baseCost: 2.0,
    reliabilityBase: 0.82,
  },
  road: {
    label: '公路',
    speedKmh: 55,
    fixedDwellDays: 0.35,
    costPer1000Km: 4.5,
    baseCost: 0.4,
    reliabilityBase: 0.90,
  },
  local: {
    label: '本地',
    speedKmh: 40,
    fixedDwellDays: 0.3,
    costPer1000Km: 2.0,
    baseCost: 0.3,
    reliabilityBase: 0.97,
  },
};

export const GCC_COUNTRIES = new Set(['AE', 'SA', 'QA', 'KW', 'BH', 'OM']);

export function borderPenalty(fromCountry, toCountry) {
  if (!fromCountry || !toCountry || fromCountry === toCountry) {
    return { days: 0, cost: 0, reliabilityDrop: 0 };
  }
  if (
    (fromCountry === 'CN' && toCountry === 'HK') ||
    (fromCountry === 'HK' && toCountry === 'CN')
  ) {
    return { days: 0.35, cost: 0.4, reliabilityDrop: 0.01 };
  }
  if (GCC_COUNTRIES.has(fromCountry) && GCC_COUNTRIES.has(toCountry)) {
    return { days: 0.65, cost: 0.85, reliabilityDrop: 0.02 };
  }
  return { days: 1.15, cost: 1.45, reliabilityDrop: 0.035 };
}

export function estimateLegMetrics(
  leg,
  {
    isTransfer = false,
    isRemoteAlternate = false,
    isSecondaryPort = false,
    originPortTier = 1,
    destPortTier = null,
    isOriginHomePort = true,
    isDestHomePort = true,
    borderDays = 0,
    borderCost = 0,
  } = {}
) {
  const mode = leg.mode || 'road';
  const profile = MODE_PROFILES[mode] ?? MODE_PROFILES.road;
  const dist = Math.max(0, Number(leg.distanceKm) || 0);

  // Drayage legs on sea/rail routes: differentiate rail corridors, cross-region alternate ports, and local home-port drayage
  if (leg.kind === 'drayage') {
    if (leg.mode === 'rail') {
      const days = dist / 50 / 24 + 0.35 + borderDays;
      const cost = (dist / 1000) * 3.8 + 0.35 + borderCost;
      return {
        distanceKm: +dist.toFixed(1),
        transitDays: +days.toFixed(2),
        costIndex: +cost.toFixed(2),
      };
    }
    if (isRemoteAlternate) {
      const days = dist / 43 / 24 + 0.85 + borderDays;
      const cost =
        (Math.min(dist, 60) / 1000) * 8.0 +
        (Math.max(0, dist - 60) / 1000) * 15.5 +
        1.1 +
        borderCost;
      return {
        distanceKm: +dist.toFixed(1),
        transitDays: +days.toFixed(2),
        costIndex: +cost.toFixed(2),
      };
    }
    const days = dist / 50 / 24 + 0.25 + borderDays;
    const cost = (dist / 1000) * 8.0 + 0.35 + borderCost;
    return {
      distanceKm: +dist.toFixed(1),
      transitDays: +days.toFixed(2),
      costIndex: +cost.toFixed(2),
    };
  }

  let dwellDays = isTransfer && profile.transferDwellDays != null
    ? profile.transferDwellDays
    : profile.fixedDwellDays;

  if (mode === 'rail' && leg.hasFerry) {
    dwellDays += 0.8; // Caspian Sea Ro-Ro ferry transfer overhead
  }

  let baseCost = isTransfer && profile.transferCost != null ? profile.transferCost : profile.baseCost;

  if (mode === 'sea') {
    const dTier = destPortTier ?? (isSecondaryPort ? 3 : 1);
    if (dTier === 2) {
      dwellDays += isDestHomePort ? 0.2 : 0.55;
      baseCost += isDestHomePort ? 0.15 : 0.45;
    } else if (dTier >= 3 || isSecondaryPort) {
      dwellDays += 1.0;
      baseCost += 0.8;
    }

    if (originPortTier === 2 && !isOriginHomePort) {
      dwellDays += 0.3;
      baseCost += 0.25;
    } else if (originPortTier >= 3 && !isOriginHomePort) {
      dwellDays += 0.6;
      baseCost += 0.5;
    }
  }

  const days = dist / profile.speedKmh / 24 + dwellDays + (mode === 'road' ? borderDays : 0);
  const cost = (dist / 1000) * profile.costPer1000Km + baseCost + (mode === 'road' ? borderCost : 0);

  return {
    distanceKm: +dist.toFixed(1),
    transitDays: +days.toFixed(2),
    costIndex: +cost.toFixed(2),
  };
}

export function scoreRoute(primaryMode, legs, { chokepointCount = 0, legOptions = [] } = {}) {
  const profile = MODE_PROFILES[primaryMode] ?? MODE_PROFILES.road;
  let totalDist = 0;
  let totalDays = 0;
  let totalCost = 0;
  let mainLegIndex = 0;
  let extraReliabilityDrop = 0;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const isMain = leg.kind !== 'drayage';
    const isTransfer = isMain && mainLegIndex > 0;
    if (isMain) mainLegIndex++;
    const opts = legOptions[i] ?? {};
    extraReliabilityDrop += opts.reliabilityDrop ?? 0;
    const m = estimateLegMetrics(leg, { isTransfer, ...opts });
    totalDist += m.distanceKm;
    totalDays += m.transitDays;
    totalCost += m.costIndex;
  }

  const transferCount = Math.max(0, legs.length - 1);
  const reliability = Math.max(
    0.4,
    Math.min(
      0.99,
      profile.reliabilityBase - transferCount * 0.025 - chokepointCount * 0.015 - extraReliabilityDrop
    )
  );

  return {
    distanceKm: +totalDist.toFixed(1),
    transitDays: +totalDays.toFixed(1),
    costIndex: +totalCost.toFixed(2),
    transferCount,
    reliabilityScore: +reliability.toFixed(2),
  };
}
