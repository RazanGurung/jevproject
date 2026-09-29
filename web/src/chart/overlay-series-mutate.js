function overlayTimeScale(getChart) {
  try {
    return getChart?.()?.timeScale?.() || null;
  } catch {
    return null;
  }
}

function restoreLogicalRange(timeScale, range) {
  if (!range || typeof timeScale?.setVisibleLogicalRange !== 'function') return;
  const from = Number(range.from);
  const to = Number(range.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return;
  try { timeScale.setVisibleLogicalRange({ from, to }); } catch {}
}

/**
 * Live overlay mutate: update() in place, and on LC 5.2.1
 * "Value is null" rebuild with setData + restore the visible range.
 */
function mutateOverlaySeries(series, point, { rebuild, getChart } = {}) {
  if (!series || !point) return false;
  const chart = typeof getChart === 'function' ? getChart() : null;
  try {
    series.update(point);
    return true;
  } catch (err) {
    const data = typeof rebuild === 'function' ? rebuild() : null;
    if (!Array.isArray(data) || data.length === 0) {
      console.warn('[chart] overlay series.update() failed:', err);
      return false;
    }
    const timeScale = overlayTimeScale(getChart);
    const range = timeScale?.getVisibleLogicalRange?.() || null;
    try {
      try { chart?.clearCrosshairPosition?.(); } catch {}
      series.setData(data);
      restoreLogicalRange(timeScale, range);
      return true;
    } catch {
      console.warn('[chart] overlay series.update() failed:', err);
      return false;
    }
  }
}

export {
  mutateOverlaySeries,
};
