/**
 * TestGrove — Geometry helpers (L3)
 *
 * Pure math utilities. No dependencies. No state.
 */

/** Convert polar (r, θ) to cartesian (x, y). θ in radians, 0 = +x, π/2 = +y. */
export function polar(r: number, theta: number): { x: number; y: number } {
  return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
}

/**
 * Seeded PRNG — mulberry32.
 * Deterministic. Same seed → same sequence. Fast.
 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return function () {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Clamp x to [min, max]. */
export function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
