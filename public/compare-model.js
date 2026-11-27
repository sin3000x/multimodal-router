export const MODE_ORDER = ['sea', 'air', 'rail', 'road', 'local'];

export const MODE_LABELS = {
  sea: '海运',
  air: '空运',
  rail: '铁路',
  road: '公路',
  local: '本地接驳',
};

export const COMPARE_ROLE_META = {
  'baseline-affected': { label: '受阻基线', shortLabel: '基线·受阻', tone: 'danger' },
  baseline: { label: '基线方案', shortLabel: '基线', tone: 'muted' },
  detour: { label: '绕行方案', shortLabel: '绕行', tone: 'warning' },
  'land-sub': { label: '陆路替代', shortLabel: '陆路替代', tone: 'success' },
  unchanged: { label: '未受影响', shortLabel: '未受影响', tone: 'neutral' },
};

export function routeSignature(route) {
  const cps = (route.chokepoints ?? []).map((cp) => cp.id).join(',');
  return [
    route.mode ?? '',
    route.originGateway?.id ?? '',
    route.viaHub?.id ?? '',
    route.destGateway?.id ?? '',
    cps,
    (route.nodeSequence ?? []).join(','),
    route.metrics?.distanceKm ?? '',
    route.metrics?.transitDays ?? '',
  ].join('|');
}

export function formatKm(km) {
  if (km == null || !Number.isFinite(Number(km))) return '—';
  return `${Math.round(Number(km)).toLocaleString('en-US')} km`;
}

export function formatDeltaDays(delta) {
  if (delta == null || !Number.isFinite(Number(delta))) return '—';
  const raw = Number(delta);
  const norm = Math.abs(raw) < 0.05 ? 0 : +raw.toFixed(1);
  if (norm === 0) return '0 天';
  return norm > 0 ? `+${norm} 天` : `${norm} 天`;
}

export function formatDeltaKm(delta) {
  if (delta == null || !Number.isFinite(Number(delta))) return '—';
  const raw = Number(delta);
  const norm = Math.abs(raw) < 0.5 ? 0 : Math.round(raw);
  if (norm === 0) return '0 km';
  return norm > 0
    ? `+${norm.toLocaleString('en-US')} km`
    : `-${Math.abs(norm).toLocaleString('en-US')} km`;
}

export function formatCostMultiplier(mult) {
  if (mult == null || !Number.isFinite(Number(mult))) return '—';
  return `${+Number(mult).toFixed(2)}x`;
}

function sortByFastest(list) {
  return [...list].sort(
    (a, b) =>
      (a.metrics?.transitDays ?? Infinity) - (b.metrics?.transitDays ?? Infinity) ||
      (a.metrics?.costIndex ?? Infinity) - (b.metrics?.costIndex ?? Infinity) ||
      (a.metrics?.distanceKm ?? Infinity) - (b.metrics?.distanceKm ?? Infinity)
  );
}

export function buildCompareModel(compareData, avoidNameById = new Map()) {
  const avoidIds = compareData.avoid ?? [];
  const avoidSet = new Set(avoidIds);
  const hasAvoid = avoidIds.length > 0;
  const avoidNames = avoidIds.map((id) => avoidNameById.get(id) || id);

  const affectedRawIds = new Set((compareData.affected || []).map((r) => r.routeId));

  // Pool baseline + affected, deduplicating by raw routeId
  const baselinePool = [];
  const seenBaseRaw = new Set();
  for (const r of [...(compareData.baseline || []), ...(compareData.affected || [])]) {
    if (!r?.routeId || seenBaseRaw.has(r.routeId)) continue;
    seenBaseRaw.add(r.routeId);
    baselinePool.push(r);
  }

  const disruptedPool = [
    ...(compareData.alternatives || []),
    ...(compareData.landSubstitutions || []),
  ];

  const baselineRoutes = baselinePool.map((r) => {
    const isAffected = affectedRawIds.has(r.routeId);
    return {
      ...r,
      routeId: `base::${r.routeId}`,
      rawRouteId: r.routeId,
      compareGroup: 'baseline',
      isAffected,
      compareRole: isAffected ? 'baseline-affected' : 'baseline',
      signature: routeSignature(r),
      showDelta: false,
      pairedRouteId: null,
    };
  });

  // Per-mode baseline facts
  const baseByMode = new Map();
  for (const r of baselineRoutes) {
    if (!baseByMode.has(r.mode)) baseByMode.set(r.mode, []);
    baseByMode.get(r.mode).push(r);
  }

  const bestBaselineByMode = new Map();
  const affectedModes = new Set();
  const primaryAffectedModes = new Set();
  const unaffectedBaselineSigs = new Set();

  for (const [mode, list] of baseByMode.entries()) {
    const sorted = sortByFastest(list);
    if (sorted[0]) {
      bestBaselineByMode.set(mode, sorted[0]);
      if (sorted[0].isAffected) primaryAffectedModes.add(mode);
    }
    for (const r of list) {
      if (r.isAffected) affectedModes.add(mode);
      else unaffectedBaselineSigs.add(r.signature);
    }
  }

  const seaImpacted = Boolean(
    compareData.impactSummary?.seaCutOff || compareData.impactSummary?.seaDetoured
  );

  const disruptedRoutes = disruptedPool.map((r) => {
    const sig = routeSignature(r);
    let compareRole = 'unchanged';
    if (!hasAvoid) {
      compareRole = 'unchanged';
    } else if (primaryAffectedModes.has(r.mode)) {
      compareRole = 'detour';
    } else if (affectedModes.has(r.mode) && !unaffectedBaselineSigs.has(sig)) {
      compareRole = 'detour';
    } else if ((r.mode === 'rail' || r.mode === 'road') && seaImpacted) {
      compareRole = 'land-sub';
    }

    const base = bestBaselineByMode.get(r.mode) ?? null;
    const deltaDays = base
      ? +(r.metrics.transitDays - base.metrics.transitDays).toFixed(1)
      : r.deltaDays ?? null;
    const deltaKm = base
      ? +(r.metrics.distanceKm - base.metrics.distanceKm).toFixed(1)
      : null;
    const costMultiplier =
      base && base.metrics.costIndex > 0
        ? +(r.metrics.costIndex / base.metrics.costIndex).toFixed(2)
        : r.costMultiplier ?? null;

    return {
      ...r,
      routeId: `alt::${r.routeId}`,
      rawRouteId: r.routeId,
      compareGroup: 'disrupted',
      compareRole,
      signature: sig,
      baselineRef: base,
      deltaDays,
      deltaKm,
      costMultiplier,
      showDelta: compareRole === 'detour',
      pairedRouteId: null,
    };
  });

  const dispByMode = new Map();
  for (const r of disruptedRoutes) {
    if (!dispByMode.has(r.mode)) dispByMode.set(r.mode, []);
    dispByMode.get(r.mode).push(r);
  }

  const modesPresent = MODE_ORDER.filter(
    (m) => baseByMode.has(m) || dispByMode.has(m)
  );
  for (const m of new Set([...baseByMode.keys(), ...dispByMode.keys()])) {
    if (!modesPresent.includes(m)) modesPresent.push(m);
  }

  const modeSummaries = modesPresent.map((mode) => {
    const modeBase = baseByMode.get(mode) ?? [];
    const modeDisp = dispByMode.get(mode) ?? [];
    const bestBaseline = sortByFastest(modeBase)[0] ?? null;
    const bestAffectedBaseline =
      sortByFastest(modeBase.filter((r) => r.isAffected))[0] ?? null;
    const bestDisrupted = sortByFastest(modeDisp)[0] ?? null;
    const affectedCount = modeBase.filter((r) => r.isAffected).length;

    let status = 'unchanged';
    let statusLabel = '未受影响';
    let statusTone = 'neutral';
    let severityRank = 4;

    if (!hasAvoid) {
      status = 'no-avoid';
      statusLabel = '未设受阻';
      statusTone = 'muted';
      severityRank = 5;
    } else if (modeBase.length > 0 && modeDisp.length === 0) {
      status = 'cutoff';
      statusLabel = '已中断';
      statusTone = 'danger';
      severityRank = 0;
    } else if (bestBaseline?.isAffected && bestDisrupted) {
      status = 'detour';
      statusLabel = '触发绕行';
      statusTone = 'warning';
      severityRank = 1;
    } else if (affectedCount > 0 && bestDisrupted) {
      status = 'partial';
      statusLabel = `部分受阻 (${affectedCount}/${modeBase.length})`;
      statusTone = 'soft-warning';
      severityRank = 2;
    } else if ((mode === 'rail' || mode === 'road') && seaImpacted && bestDisrupted) {
      status = 'land-sub';
      statusLabel = '未受影响 · 陆路替代';
      statusTone = 'success';
      severityRank = 3;
    }

    const deltaDays =
      bestBaseline && bestDisrupted
        ? +(bestDisrupted.metrics.transitDays - bestBaseline.metrics.transitDays).toFixed(1)
        : null;
    const deltaKm =
      bestBaseline && bestDisrupted
        ? +(bestDisrupted.metrics.distanceKm - bestBaseline.metrics.distanceKm).toFixed(1)
        : null;
    const costMultiplier =
      bestBaseline && bestDisrupted && bestBaseline.metrics.costIndex > 0
        ? +(bestDisrupted.metrics.costIndex / bestBaseline.metrics.costIndex).toFixed(2)
        : null;

    const pairBaselineId =
      (bestBaseline?.isAffected ? bestBaseline.routeId : bestAffectedBaseline?.routeId) ??
      bestBaseline?.routeId ??
      null;
    const pairDisruptedId = bestDisrupted?.routeId ?? null;

    return {
      mode,
      modeLabel: MODE_LABELS[mode] || mode,
      status,
      statusLabel,
      statusTone,
      severityRank,
      affectedCount,
      baselineCount: modeBase.length,
      disruptedCount: modeDisp.length,
      bestBaseline,
      bestAffectedBaseline,
      bestDisrupted,
      deltaDays,
      deltaKm,
      costMultiplier,
      pairBaselineId,
      pairDisruptedId,
    };
  });

  modeSummaries.sort(
    (a, b) =>
      a.severityRank - b.severityRank ||
      MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode)
  );

  const summaryByMode = new Map(modeSummaries.map((s) => [s.mode, s]));

  for (const r of disruptedRoutes) {
    if (r.compareRole === 'detour') {
      r.pairedRouteId = summaryByMode.get(r.mode)?.pairBaselineId ?? null;
    }
  }
  for (const r of baselineRoutes) {
    if (r.compareRole === 'baseline-affected') {
      r.pairedRouteId = summaryByMode.get(r.mode)?.pairDisruptedId ?? null;
    }
  }

  const disruptedSigs = new Set(disruptedRoutes.map((r) => r.signature));
  const extraBaselines = baselineRoutes.filter(
    (r) => r.isAffected || !disruptedSigs.has(r.signature)
  );

  const roleOrder = {
    detour: 0,
    'baseline-affected': 1,
    'land-sub': 2,
    unchanged: 3,
    baseline: 4,
  };
  const bothRoutes = [...disruptedRoutes, ...extraBaselines].sort(
    (a, b) => (roleOrder[a.compareRole] ?? 9) - (roleOrder[b.compareRole] ?? 9)
  );

  function getRoutes(layer = 'both') {
    if (layer === 'detour') return disruptedRoutes;
    if (layer === 'baseline') return baselineRoutes;
    return bothRoutes;
  }

  function defaultRouteId(layer = 'both') {
    const list = getRoutes(layer);
    if (layer === 'detour') {
      return (
        list.find((r) => r.compareRole === 'detour')?.routeId ??
        list[0]?.routeId ??
        null
      );
    }
    if (layer === 'baseline') {
      return (
        list.find((r) => r.compareRole === 'baseline-affected')?.routeId ??
        list[0]?.routeId ??
        null
      );
    }
    return (
      list.find((r) => r.compareRole === 'detour')?.routeId ??
      list.find((r) => r.compareRole === 'baseline-affected')?.routeId ??
      list[0]?.routeId ??
      null
    );
  }

  const fastestDisrupted = sortByFastest(disruptedRoutes)[0] ?? null;
  const headline = {
    affectedCount: baselineRoutes.filter((r) => r.isAffected).length,
    totalBaselineCount: baselineRoutes.length,
    fastestDisrupted,
    affectedModes: modeSummaries
      .filter((m) => ['cutoff', 'detour', 'partial'].includes(m.status))
      .map((m) => m.modeLabel),
    hasCutoff: modeSummaries.some((m) => m.status === 'cutoff'),
  };

  return {
    avoidIds,
    avoidSet,
    hasAvoid,
    avoidNames,
    baselineRoutes,
    disruptedRoutes,
    bothRoutes,
    modeSummaries,
    headline,
    getRoutes,
    defaultRouteId,
  };
}
