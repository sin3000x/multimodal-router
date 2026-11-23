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

export function estimateLegMetrics(leg, { isTransfer = false } = {}) {
  const mode = leg.mode || 'road';
  const profile = MODE_PROFILES[mode] ?? MODE_PROFILES.road;
  const dist = Math.max(0, Number(leg.distanceKm) || 0);

  // Drayage legs on sea/rail routes add minimal border/terminal overhead (sea/rail main leg holds port dwell)
  if (leg.kind === 'drayage') {
    const days = dist / 55 / 24 + 0.25;
    const cost = (dist / 1000) * 4.5 + 0.3;
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

  const days = dist / profile.speedKmh / 24 + dwellDays;
  const baseCost = isTransfer && profile.transferCost != null ? profile.transferCost : profile.baseCost;
  const cost = (dist / 1000) * profile.costPer1000Km + baseCost;

  return {
    distanceKm: +dist.toFixed(1),
    transitDays: +days.toFixed(2),
    costIndex: +cost.toFixed(2),
  };
}

export function scoreRoute(primaryMode, legs, { chokepointCount = 0 } = {}) {
  const profile = MODE_PROFILES[primaryMode] ?? MODE_PROFILES.road;
  let totalDist = 0;
  let totalDays = 0;
  let totalCost = 0;
  let mainLegIndex = 0;

  for (const leg of legs) {
    const isMain = leg.kind !== 'drayage';
    const isTransfer = isMain && mainLegIndex > 0;
    if (isMain) mainLegIndex++;
    const m = estimateLegMetrics(leg, { isTransfer });
    totalDist += m.distanceKm;
    totalDays += m.transitDays;
    totalCost += m.costIndex;
  }

  const transferCount = Math.max(0, legs.length - 1);
  const reliability = Math.max(
    0.4,
    Math.min(
      0.99,
      profile.reliabilityBase - transferCount * 0.025 - chokepointCount * 0.015
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
