// Yield curve math shared by the pipeline and the app (the app vendors this file
// with a pinned sha256). Yields are percent; tenors are years.

// Linear interpolation on a par curve, flat beyond the ends.
export function yieldAt(points, tenor) {
  if (!points?.length) throw new RangeError('Empty curve');
  if (tenor <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i += 1) {
    const [t1, y1] = points[i];
    if (tenor <= t1) {
      const [t0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (tenor - t0)) / (t1 - t0);
    }
  }
  return points[points.length - 1][1];
}

// Modified duration of a semiannual par bond: (1 - (1 + y/2)^(-2T)) / y.
export function parDuration(tenor, yieldPct) {
  const y = Math.max(yieldPct, 0.01) / 100;
  return (1 - (1 + y / 2) ** (-2 * tenor)) / y;
}

// Shift every point of a curve by a per-tenor change table [[tenor, change]].
export function shiftCurve(points, changes) {
  return points.map(([t, y]) => [t, Math.max(0, y + yieldAt(changes, t))]);
}

export const parallel = (points, change) => points.map(([t, y]) => [t, Math.max(0, y + change)]);
