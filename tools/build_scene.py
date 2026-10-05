"""
TestGrove — scene layers for the renderer (offline; re-run when a painting changes).

For every mood painting this writes two files next to it:

  assets/scene-{mood}.jpg   The painting with a real depth of field: the tree
                            in sharp focus; the world behind it lens-blurred
                            (point lights turn into bokeh), darkened and
                            slightly desaturated so the tree and the UI lead.
                            The glass branches' painted amber glow fades to a
                            pale cream: status light is added live by the
                            renderer, and amber would read as "flaky".

  assets/glass-{mood}.png   8-bit mask of the glass: white where a branch is
                            glass and carries light, black on bark and sky.
                            The renderer confines status light to it, so light
                            stays INSIDE the branches and follows their curves.

How glass is found
  A per-painting pixel classifier (glass / bark / sky), trained on seeds the
  painting itself gives with certainty: thin glass twigs (white top-hat
  skeleton), the bark of the trunk core, and sky far from the tree. Features
  are colour plus local texture, contrast and ridge (tube) responses, so a
  sun-lit cloud between two branches reads as sky even though it is bright.
  Per-painting art-direction overrides (OVERRIDES) remove the few things no
  classifier should have to know about, like the moon.

Usage:  python3 tools/build_scene.py            (all moods)
        python3 tools/build_scene.py stormy     (one mood)
"""
import json
import os
import sys
import time

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from skimage import color, filters, morphology
from sklearn.ensemble import HistGradientBoostingClassifier

sys.path.insert(0, os.path.dirname(__file__))
from detect_branches import detect  # noqa: E402
from tree_body import tree_body  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), '..', 'prototype')
MOODS = ['peaceful', 'unsettled', 'stormy', 'eerie']

# ── Look ─────────────────────────────────────────────────────────────
MAX_BLUR = 6.0          # px, lens radius for the far world (painting is 1376 px wide)
BG_DARKEN = 0.30        # the far world loses this much light
BG_DESAT = 0.18         # … and this much colour
VIGNETTE = 0.22         # extra darkening in the corners
GLASS_DESAT = 0.62      # the painted amber glow fades to pale cream: unlit glass must
                        # not read as "flaky"; live status light colours it again
GLASS_COOL = np.array([0.985, 1.0, 1.03], np.float32)
THICK_MAX = 30          # px half-width: no glass limb is thicker than this; the trunk is

# Art direction: regions that are never glass, per painting (circles: x, y, r).
OVERRIDES = {
    'eerie': {'not_glass_circles': [(408, 172, 64)]},     # the moon
}


# ── Masks ────────────────────────────────────────────────────────────
def body_mask(path, twig):
    """Same tree body the layout uses (tools/build_anatomy.py)."""
    body = tree_body(path) | morphology.dilation(twig, morphology.disk(2))
    return morphology.remove_small_holes(body, max_size=900)


def features(rgb):
    lab = color.rgb2lab(rgb).astype(np.float32)
    L = lab[..., 0] / 100.0
    F = [L, lab[..., 1] / 50, lab[..., 2] / 50]
    for s in (2, 6, 15):
        mu = ndi.gaussian_filter(L, s)
        sq = ndi.gaussian_filter(L * L, s)
        F += [mu, np.sqrt(np.maximum(sq - mu * mu, 0)), L - mu]
    for r in (4, 9, 18, 30):
        F.append(morphology.white_tophat(L, morphology.disk(r)))
    for sig in ([1, 2], [3, 5], [7, 11]):
        F.append(filters.sato(L, sigmas=sig, black_ridges=False))
    for s in (1, 3):
        F.append(filters.sobel(ndi.gaussian_filter(L, s)))
    F.append(L - ndi.gaussian_filter(L, 30))
    return np.stack(F, -1).astype(np.float32)


def classify(rgb, body, twig):
    """P(glass), P(bark), P(sky) for every pixel near the tree."""
    H, W, _ = rgb.shape
    X = features(rgb).reshape(H * W, -1)
    yy = np.mgrid[0:H, 0:W][0]
    canopy = yy < H * 0.60
    cx = W // 2
    glass_seed = morphology.erosion(twig, morphology.disk(1)) & body & canopy
    bark_seed = np.zeros((H, W), bool)
    bark_seed[int(H * .36):int(H * .66), cx - int(W * .05):cx + int(W * .05)] = True
    bark_seed &= body
    sky_seed = ~ndi.binary_dilation(body, iterations=14) & canopy
    rng = np.random.default_rng(1)

    def pick(mask, n):
        idx = np.flatnonzero(mask.ravel())
        return rng.choice(idx, size=min(n, len(idx)), replace=False)
    gi, bi, si = pick(glass_seed, 25000), pick(bark_seed, 15000), pick(sky_seed, 30000)
    clf = HistGradientBoostingClassifier(max_iter=150, learning_rate=0.1, max_leaf_nodes=31, random_state=0)
    clf.fit(np.concatenate([X[gi], X[bi], X[si]]),
            np.concatenate([np.ones(len(gi)), np.zeros(len(bi)), np.full(len(si), 2)]))
    region = (ndi.binary_dilation(body, iterations=3) & (yy < H * 0.72)).ravel()
    P = np.zeros((H * W, 3), np.float32)
    P[:, 2] = 1.0                                      # far from the tree: sky
    P[region] = clf.predict_proba(X[region])           # columns: bark, glass, sky
    P = P.reshape(H, W, 3)
    return P[..., 1], P[..., 0], P[..., 2]


def regional(p, support, sigma):
    """Average of p over nearby `support` pixels only (normalised convolution)."""
    s = support.astype(np.float32)
    return ndi.gaussian_filter(p * s, sigma) / np.maximum(ndi.gaussian_filter(s, sigma), 1e-4)


def glass_mask(p_glass, p_sky, body, mood, shape, limit_thickness=True, solid=None):
    """SOFT glass mask (0..1) from a regional classifier vote. Where the painter
    blended bark into glass, the mask blends too — a hard edge there would cut
    a limb in half. Specks and art-direction overrides are removed."""
    H, W = shape
    support = ndi.binary_dilation(body, iterations=2)
    g = regional(p_glass, support, 2.5)
    s = regional(p_sky, support, 1.5)
    soft = np.clip((g - 0.22) / 0.45, 0, 1) * np.clip((0.65 - s) / 0.3, 0, 1) * support
    # Wood that is thicker than any glass limb is trunk: sun-lit bark at the
    # crown can look glassy, but glass only begins where a limb leaves the trunk.
    if limit_thickness:   # on the SOLID silhouette: the bark mask is patchy low on the trunk
        trunk = trunk_wood(body if solid is None else solid)
        soft *= 1 - np.clip(ndi.gaussian_filter(trunk.astype(np.float32), 3) * 1.6, 0, 1)
    yy, xx = np.ogrid[0:H, 0:W]
    for (x, y, r) in OVERRIDES.get(mood, {}).get('not_glass_circles', []):
        soft[(xx - x) ** 2 + (yy - y) ** 2 <= r * r] = 0
    # Keep only glass that belongs to a branch of meaningful size (no specks)
    hard = morphology.closing(soft > 0.5, morphology.disk(2)) & support
    lab, n = ndi.label(hard, structure=np.ones((3, 3)))
    sizes = ndi.sum(hard, lab, index=np.arange(1, n + 1))
    keep = np.isin(lab, np.nonzero(sizes >= 220)[0] + 1)
    soft = soft * ndi.binary_dilation(keep, iterations=3)
    return np.clip(ndi.gaussian_filter(soft, 0.6), 0, 1)


def trunk_wood(solid):
    """Wood too thick to be any glass limb: every pixel a disc of THICK_MAX
    radius can cover while staying inside the tree (a morphological opening —
    it includes the trunk's EDGES, unlike a medial-axis estimate)."""
    d = 2 * THICK_MAX + 1
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (d, d))
    thick = cv2.morphologyEx(solid.astype(np.uint8), cv2.MORPH_OPEN, k).astype(bool)
    # only the trunk itself: the thick region rooted at the trunk base (limbs that
    # merely fuse in the mask high in the crown are glass, not trunk)
    H, W = thick.shape
    lab, _ = ndi.label(thick)
    base = lab[int(H * 0.55):, int(W * 0.40):int(W * 0.60)]
    keep = np.unique(base[base > 0])
    return np.isin(lab, keep)


def local_thickness(body):
    """Half-width of the branch each pixel belongs to: the radius of the
    medial-axis disc nearest to it."""
    sm = morphology.opening(body, morphology.disk(2))
    dt = ndi.distance_transform_edt(sm)
    skel = morphology.skeletonize(sm)
    _, (iy, ix) = ndi.distance_transform_edt(~skel, return_indices=True)
    return dt[iy, ix] * sm


def sky_in_body(p_sky, body):
    """Sky the body mask swallowed (pockets between branches), at least 5 px
    across — thin twigs, whose pixels mix with sky, are never removed."""
    support = ndi.binary_dilation(body, iterations=2)
    s = regional(p_sky, support, 1.0)
    return morphology.opening(body & (s > 0.6), morphology.disk(2))


def lower_trunk(bgr, body):
    """Trunk, roots and the ground they stand on (below the canopy) — GrabCut."""
    H, W, _ = bgr.shape
    cx = W // 2
    mask = np.full((H, W), cv2.GC_PR_BGD, np.uint8)
    yy, xx = np.mgrid[0:H, 0:W]
    mask[ndi.binary_dilation(body, iterations=6)] = cv2.GC_PR_FGD
    mask[(~ndi.binary_dilation(body, iterations=28)) & (yy < H * 0.74)] = cv2.GC_BGD
    lower = yy > H * 0.66
    mask[lower & (np.abs(xx - cx) < W * 0.20)] = cv2.GC_PR_FGD
    mask[lower & (np.abs(xx - cx) > W * 0.36) & (yy < H * 0.80)] = cv2.GC_BGD
    mask[int(H * 0.30):int(H * 0.88), cx - int(W * 0.035):cx + int(W * 0.035)] = cv2.GC_FGD
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    cv2.grabCut(bgr, mask, None, bgd, fgd, 5, cv2.GC_INIT_WITH_MASK)
    fg = (mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD)
    lab, _ = ndi.label(fg)
    keep = np.unique(lab[int(H * 0.5):int(H * 0.7), cx - 20:cx + 20])
    fg = np.isin(lab, keep[keep > 0])
    # trunk and roots only — distant ground at the horizon stays in the blur
    return fg & (yy > H * 0.55) & ((np.abs(xx - cx) < W * 0.15) | (yy > H * 0.84))


def faint_twigs(rgb, body):
    """Thin, pale twig ends the body mask stops short of. They belong to the
    tree, so they stay in focus: bright thin ridges attached to the body."""
    H, W, _ = rgb.shape
    L = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    ridge = filters.sato(L, sigmas=[1, 2], black_ridges=False)
    canopy = np.zeros((H, W), bool)
    canopy[:int(H * 0.62)] = True
    cand = (ridge > np.percentile(ridge[canopy], 93)) & canopy
    cand = morphology.remove_small_objects(cand, max_size=30)
    lab, _ = ndi.label(cand | body, structure=np.ones((3, 3)))
    attached = np.unique(lab[body])
    return np.isin(lab, attached[attached > 0]) & cand


# ── Depth of field ───────────────────────────────────────────────────
def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def disc(r):
    n = int(np.ceil(r)) + 1
    yy, xx = np.mgrid[-n:n + 1, -n:n + 1]
    k = np.clip(r + 0.5 - np.hypot(xx, yy), 0, 1).astype(np.float32)
    return k / k.sum()


def lens_blur(rgb, keep, radius_map):
    """Variable-radius disc blur in linear light. Only `keep` pixels contribute
    (normalised convolution), so the sharp tree never bleeds into the blur."""
    lin = srgb_to_lin(rgb)
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    point = np.clip((lum - ndi.gaussian_filter(lum, 6) - 0.08) / 0.2, 0, 1)   # small bright lights
    lin = lin * (1 + 2.5 * point[..., None])                                  # → luminous bokeh
    radii = [0, 1.5, 3.0, 4.5, 6.0]
    w = keep.astype(np.float32)
    levels = []
    for r in radii:
        if r == 0:
            levels.append(lin)
            continue
        k = disc(r)
        num = cv2.filter2D(lin * w[..., None], -1, k, borderType=cv2.BORDER_REFLECT)
        den = cv2.filter2D(w, -1, k, borderType=cv2.BORDER_REFLECT)
        levels.append(num / np.maximum(den, 1e-4)[..., None])
    idx = np.clip(radius_map / 1.5, 0, len(radii) - 1 - 1e-6)
    lo = np.floor(idx).astype(int)
    t = (idx - lo)[..., None]
    stack = np.stack(levels, 0)
    H, W = radius_map.shape
    jj, ii = np.mgrid[0:H, 0:W]
    out = stack[lo, jj, ii] * (1 - t) + stack[lo + 1, jj, ii] * t
    return lin_to_srgb(out)


def build(mood):
    t0 = time.time()
    path = os.path.join(ROOT, 'assets', f'tree-{mood}.png')
    bgr = cv2.imread(path)
    rgb = bgr[..., ::-1].astype(np.float32) / 255
    H, W, _ = rgb.shape
    twig = detect(path)['_twig_mask']
    body = body_mask(path, twig)
    p_glass, p_bark, p_sky = classify(rgb, body, twig)

    # What is in focus: the tree (minus sky the body mask swallowed), its
    # lower trunk and roots, the faint twig ends, and the near ground.
    tree = (body & ~sky_in_body(p_sky, body)) | lower_trunk(bgr, body) | faint_twigs(rgb, body)
    # no islands of sharp sky: keep what is solidly attached to the tree
    core = morphology.remove_small_objects(morphology.opening(tree, morphology.disk(1)), max_size=600)
    tree = tree & ndi.binary_dilation(core, iterations=2)
    tree = ndi.binary_dilation(tree, iterations=1)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    ground = np.clip((yy - H * 0.80) / (H * 0.16), 0, 1) ** 0.8          # near ground → sharp
    focus = np.maximum(tree.astype(np.float32), ground)
    bg = lens_blur(rgb, ~tree, MAX_BLUR * (1 - focus))
    t = ndi.gaussian_filter(tree.astype(np.float32), 0.7)[..., None]
    out = rgb * t + bg * (1 - t)

    # Recede the world: darker, less colour, a soft vignette. Weighted by how
    # much a pixel is WORLD — including sky slivers inside the tree mask, so
    # no bright halo is left hugging the branches.
    sky_near = (regional(p_sky, ndi.binary_dilation(body, iterations=2), 0.8) * (yy < H * 0.72)).clip(0, 1)
    world = np.maximum(1 - focus, sky_near * (1 - ground))[..., None]
    lum = (out @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
    out = out * (1 - BG_DESAT * world) + lum * BG_DESAT * world
    r2 = ((xx - W / 2) / (W / 2)) ** 2 + ((yy - H * 0.45) / (H * 0.75)) ** 2
    out = out * (1 - BG_DARKEN * world) * (1 - VIGNETTE * np.clip(r2 - 0.25, 0, 1)[..., None])

    # Unlit glass: pale, cool cream instead of the painted amber. Every glassy
    # pixel gets it — including glass limbs where they merge into the trunk —
    # weighted by brightness, so sun-lit bark stays bark.
    solid = morphology.remove_small_holes(tree | body, max_size=400)
    g = glass_mask(p_glass, p_sky, body, mood, (H, W), solid=solid)          # where light may live
    g_all = glass_mask(p_glass, p_sky, body, mood, (H, W), limit_thickness=False)
    lum = (out @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
    cream = np.clip(lum * GLASS_COOL, 0, 1)
    bright = np.clip((lum[..., 0] - 0.42) / 0.26, 0, 1)
    k = (GLASS_DESAT * np.maximum(g, g_all * bright))[..., None]
    out = out * (1 - k) + cream * k

    Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)).save(
        os.path.join(ROOT, 'assets', f'scene-{mood}.jpg'), quality=90, optimize=True, progressive=True)
    Image.fromarray((np.clip(g, 0, 1) * 255 + 0.5).astype(np.uint8), 'L').save(
        os.path.join(ROOT, 'assets', f'glass-{mood}.png'), optimize=True)
    print(f'{mood}: scene + glass mask ({time.time() - t0:.0f}s, glass {100 * (g > 0.5).mean():.1f}% of frame)')


def write_manifest():
    """prototype/tree-scene.js — tells the renderer which layers exist (works from file://)."""
    moods = {}
    for m in MOODS:
        if os.path.exists(os.path.join(ROOT, 'assets', f'scene-{m}.jpg')):
            moods[m] = {'scene': f'./assets/scene-{m}.jpg', 'glass': f'./assets/glass-{m}.png'}
    js = ('/* AUTO-GENERATED by tools/build_scene.py — do not edit by hand. */\n'
          'window.TREE_SCENE = ' + json.dumps({'moods': moods}, separators=(',', ':')) + ';\n')
    with open(os.path.join(ROOT, 'tree-scene.js'), 'w') as f:
        f.write(js)
    print('wrote prototype/tree-scene.js')


if __name__ == '__main__':
    for m in (sys.argv[1:] or MOODS):
        build(m)
    write_manifest()
