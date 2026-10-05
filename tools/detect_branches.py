"""
TestGrove — branch detection tool (offline; run once per tree image).

Finds the real glass-branch geometry in a tree PNG so leaves attach to
actual branches instead of hand-guessed coordinates.

Why a white top-hat:
  The glass twigs are thin bright structures. A white top-hat with a disk
  of radius r keeps bright features NARROWER than ~2r and discards wide bright
  regions (moon, sunlit clouds, sky gradients). That makes detection work on
  all four moods even though their skies differ completely.

Pipeline:
  1. white_tophat(gray, disk(r))       -> thin bright structures
  2. threshold (percentile over canopy) + canopy region mask
  3. clean + skeletonize                -> 1-px branch centrelines
  4. endpoints (1 neighbour)            -> branch TIPS (primary leaf slots)
  5. sample along outer skeleton        -> TWIG slots (secondary leaf slots)

Output JSON (normalized 0..1 coordinates):
  { width, height, tips:[{x,y,angle,kind}], twigSlots:[...] }

Usage:
  python3 tools/detect_branches.py <tree.png> <out.json> [debug.png]
"""
import sys
import json
import math

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from skimage import morphology

TOPHAT_RADIUS = 9          # px — twigs up to ~18px wide survive
THRESH_PERCENTILE = 88     # of top-hat response inside canopy
CANOPY_BOTTOM = 0.52       # fraction of height; below this is trunk/ground
TIP_MIN_SPACING = 11       # px between distinct tips
TWIG_SLOT_SPACING = 7      # px between twig slots (dense: placement picks from these)
MAX_TWIG_SLOTS = 1200
MIN_SEGMENT_PX = 45       # skeleton components shorter than this are noise
BRIGHT_PERCENTILE = 62    # glass must be brighter than this canopy percentile


def _direction(skel, y, x, H, W):
    """Direction (degrees, math convention: 0=right, 90=up) the branch points at (y,x)."""
    y0, y1 = max(0, y - 14), min(H, y + 15)
    x0, x1 = max(0, x - 14), min(W, x + 15)
    ys, xs = np.nonzero(skel[y0:y1, x0:x1])
    if len(ys) < 3:
        return None
    cy, cx = ys.mean() + y0, xs.mean() + x0
    return math.degrees(math.atan2(-(y - cy), (x - cx)))



def _underside(mask, y, x, H, max_steps=30):
    """Walk straight down from a centre-line point to the branch's lower edge.
    Leaves hang from the underside of a branch, not from its middle."""
    yy = y
    while yy + 1 < H and yy - y < max_steps and mask[yy + 1, x]:
        yy += 1
    return yy


def detect(path, debug_out=None):
    img = Image.open(path).convert('RGB')
    W, H = img.size
    rgb = np.asarray(img).astype(np.float32) / 255.0
    gray = rgb.mean(axis=2)

    yy, xx = np.mgrid[0:H, 0:W]
    canopy = yy < H * CANOPY_BOTTOM

    tophat = morphology.white_tophat(gray, morphology.disk(TOPHAT_RADIUS))
    thr = np.percentile(tophat[canopy], THRESH_PERCENTILE)
    mask = (tophat > thr) & canopy

    mask = morphology.opening(mask, morphology.disk(1))
    mask = morphology.remove_small_objects(mask, max_size=60)
    mask = morphology.closing(mask, morphology.disk(2))

    thickness = ndi.distance_transform_edt(mask) * 2   # local branch width in px
    skel = morphology.skeletonize(mask)
    skel = morphology.remove_small_objects(skel, max_size=20, connectivity=2)

    # Keep only skeleton segments long enough to be real branches (drops
    # stray sky specks) and only on pixels bright in the ORIGINAL image
    # (drops bark-texture highlights, which are darker than lit glass).
    labels, n = ndi.label(skel, structure=np.ones((3, 3)))
    sizes = ndi.sum(skel, labels, index=np.arange(1, n + 1))
    long_ids = np.nonzero(sizes >= MIN_SEGMENT_PX)[0] + 1
    skel = np.isin(labels, long_ids)
    bright = ndi.uniform_filter(gray, 5) >= np.percentile(gray[canopy], BRIGHT_PERCENTILE)
    skel = skel & bright

    # --- Endpoints = tips
    k = np.array([[1, 1, 1], [1, 10, 1], [1, 1, 1]])
    nb = ndi.convolve(skel.astype(np.uint8), k, mode='constant')
    endpoints = np.argwhere(nb == 11)

    trunk_x = W / 2
    tips = []
    for (y, x) in endpoints:
        # reject bark-texture noise over the trunk core
        if abs(x - trunk_x) < W * 0.07 and y > H * 0.25:
            continue
        ang = _direction(skel, y, x, H, W)
        if ang is None:
            continue
        ye = _underside(mask, y, x, H)
        tips.append({'x': round(x / W, 4), 'y': round(ye / H, 4),
                     'angle': round(ang, 1), 'kind': 'tip', 'w': round(float(thickness[y, x]), 1)})

    dedup = []
    for t in sorted(tips, key=lambda t: (t['y'], t['x'])):
        if all(math.hypot((t['x'] - d['x']) * W, (t['y'] - d['y']) * H) > TIP_MIN_SPACING
               for d in dedup):
            dedup.append(t)
    tips = dedup

    # --- Twig slots along outer skeleton (away from trunk axis)
    dist = np.hypot((xx - trunk_x) / W, (yy - H * 0.45) / H)
    pts = np.argwhere(skel & (dist > 0.16))
    rng = np.random.default_rng(7)        # deterministic
    rng.shuffle(pts)
    taken = [(t['x'] * W, t['y'] * H) for t in tips]
    twigs = []
    for (y, x) in pts:
        if all(math.hypot(x - a, y - b) > TWIG_SLOT_SPACING for (a, b) in taken):
            ang = _direction(skel, y, x, H, W)
            if ang is None:
                continue
            ye = _underside(mask, y, x, H)
            twigs.append({'x': round(x / W, 4), 'y': round(ye / H, 4),
                          'angle': round(ang, 1), 'kind': 'twig', 'w': round(float(thickness[y, x]), 1)})
            taken.append((x, y))
        if len(twigs) >= MAX_TWIG_SLOTS:
            break

    if debug_out:
        dbg = np.asarray(img).copy()
        dbg[skel] = [0, 255, 255]
        di = Image.fromarray(dbg)
        d = ImageDraw.Draw(di)
        for t in tips:
            d.ellipse([t['x'] * W - 4, t['y'] * H - 4, t['x'] * W + 4, t['y'] * H + 4],
                      outline=(255, 0, 0), width=2)
        for t in twigs:
            d.ellipse([t['x'] * W - 2, t['y'] * H - 2, t['x'] * W + 2, t['y'] * H + 2],
                      fill=(255, 255, 0))
        di.save(debug_out)

    return {'width': W, 'height': H, 'tips': tips, 'twigSlots': twigs, '_twig_mask': mask}


if __name__ == '__main__':
    src, out_json = sys.argv[1], sys.argv[2]
    dbg = sys.argv[3] if len(sys.argv) > 3 else None
    r = detect(src, dbg)
    with open(out_json, 'w') as f:
        json.dump(r, f, indent=1)
    print(f"{src}: {len(r['tips'])} tips, {len(r['twigSlots'])} twig slots")
