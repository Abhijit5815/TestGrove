"""
TestGrove — whole-tree body mask (trunk + limbs of every width).

The tree is ONE connected object rooted at the trunk; clouds are not.
Bright glass at several widths (white top-hat) + dark textured bark in the
central band, keeping only components connected to the trunk base.
Used to keep leaf blades in open air instead of lying across limbs.
"""
import numpy as np, cv2, sys
from PIL import Image
from scipy import ndimage as ndi
from skimage import morphology
def tree_body(path):
    rgb=np.asarray(Image.open(path).convert('RGB')).astype(np.float32)/255
    H,W,_=rgb.shape; g=rgb.mean(2)
    canopy=np.zeros((H,W),bool); canopy[:int(H*.70)]=True
    # bright glass at several widths
    glass=np.zeros((H,W),bool)
    for r,pct in [(6,86),(14,85),(28,86)]:
        th=morphology.white_tophat(g, morphology.disk(r))
        glass |= th > np.percentile(th[canopy], pct)
    glass &= canopy
    glass=morphology.opening(glass, morphology.disk(1))
    glass=morphology.closing(glass, morphology.disk(3))
    # trunk core: dark textured bark in the central band, connected below
    mu=cv2.blur(g,(9,9)); sd=np.sqrt(np.maximum(cv2.blur(g*g,(9,9))-mu*mu,0))
    band=np.zeros((H,W),bool); band[int(H*.05):int(H*.70), int(W*.36):int(W*.62)]=True
    bark=band & (sd>np.percentile(sd[band],45)) & (g<np.percentile(g[band],60))
    bark=morphology.closing(bark, morphology.disk(5))
    seed=np.zeros((H,W),bool); seed[int(H*.55):int(H*.70), int(W*.44):int(W*.56)]=True
    body=glass|bark|seed
    lab,n=ndi.label(body)
    keep=np.unique(lab[seed]); keep=keep[keep>0]
    body=np.isin(lab,keep)
    body=morphology.closing(body, morphology.disk(2))
    return body
if __name__=='__main__':
    out=[]
    for m in ['peaceful','unsettled','stormy','eerie']:
        p=f'prototype/assets/tree-{m}.png'; b=tree_body(p)
        vis=(np.asarray(Image.open(p).convert('RGB'))*0.55).astype(np.uint8)
        vis[b]=(vis[b]*0.4+np.array([255,0,180])*0.6).astype(np.uint8); out.append(vis)
        print(m, round(b[:int(b.shape[0]*.66)].mean(),3))
    Image.fromarray(np.vstack([np.hstack(out[:2]),np.hstack(out[2:])])).resize((1376,768)).save(sys.argv[1])
