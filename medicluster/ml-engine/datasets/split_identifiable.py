"""Split the Kermany chest X-ray dataset into images the model can identify vs cannot.

Honest protocol:
- The decision threshold and the "uncertain" band are chosen on the TRAIN split only.
- The same rules are then applied unchanged to the official TEST split.
- Metrics are always reported together with coverage (share of images the model answers).
- No image is deleted. Each image is labelled "identifiable" or "unidentifiable" in
  datasets/imaging/identifiable_split.json; the product hides unidentifiable images by default
  and the model answers them with "Uncertain - refer to radiologist".

Run: python -m datasets.split_identifiable [--min-accuracy 0.9]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent / "imaging"
DATA = ROOT / "chest-xray-pneumonia"
OUT = ROOT / "identifiable_split.json"
MODEL = "densenet121-res224-all"


def list_split(split: str):
    items = []
    for label, cls in (("normal", 0), ("pneumonia", 1)):
        for p in sorted((DATA / split / label).glob("*")):
            if p.suffix.lower() in {".jpg", ".jpeg", ".png"}:
                items.append((p, cls))
    return items


def score(items, batch=32):
    import torch
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from imaging.analyzer import _get_model, _load_pixels, _preprocess

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = _get_model(MODEL).to(device).eval()
    paths = [p.lower() for p in model.pathologies]
    idx = [i for i, p in enumerate(paths) if "pneumonia" in p or "consolidation" in p or "infiltrat" in p]
    scores = []
    for s in range(0, len(items), batch):
        ts = []
        for path, _ in items[s:s + batch]:
            arr, is_dicom = _load_pixels(path.read_bytes(), filename=path.name, radiograph_only=False)
            ts.append(_preprocess(arr, size=224, is_dicom=is_dicom))
        with torch.no_grad():
            out = model(torch.cat(ts).to(device)).cpu().numpy()
        scores.extend(float(np.max(r[idx])) for r in out)
        print(f"  scored {min(s + batch, len(items))}/{len(items)}", end="\r", flush=True)
    print()
    return np.array(scores)


def features(items, batch=32):
    """Frozen DenseNet121 (torchxrayvision) penultimate features, one 1024-d vector per image."""
    import torch
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from imaging.analyzer import _get_model, _load_pixels, _preprocess

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = _get_model(MODEL).to(device).eval()
    feats = []
    for s in range(0, len(items), batch):
        ts = []
        for path, _ in items[s:s + batch]:
            arr, is_dicom = _load_pixels(path.read_bytes(), filename=path.name, radiograph_only=False)
            ts.append(_preprocess(arr, size=224, is_dicom=is_dicom))
        with torch.no_grad():
            feats.append(model.features2(torch.cat(ts).to(device)).cpu().numpy())
        print(f"  features {min(s + batch, len(items))}/{len(items)}", end="\r", flush=True)
    print()
    return np.concatenate(feats)


def youden_threshold(y, s):
    best_t, best_j = 0.5, -1.0
    for t in np.unique(np.round(s, 4)):
        pred = s >= t
        tpr = (pred & (y == 1)).sum() / max((y == 1).sum(), 1)
        tnr = (~pred & (y == 0)).sum() / max((y == 0).sum(), 1)
        if tpr + tnr - 1 > best_j:
            best_t, best_j = float(t), tpr + tnr - 1
    return best_t


def metrics(y, s, t, keep=None):
    keep = np.ones_like(y, bool) if keep is None else keep
    yk, pk = y[keep], (s[keep] >= t).astype(int)
    if len(yk) == 0:
        return {"coverage": 0.0, "n": 0}
    f1s = []
    for c in (0, 1):
        tp = ((pk == c) & (yk == c)).sum(); fp = ((pk == c) & (yk != c)).sum(); fn = ((pk != c) & (yk == c)).sum()
        prec = tp / max(tp + fp, 1); rec = tp / max(tp + fn, 1)
        f1s.append(0 if prec + rec == 0 else 2 * prec * rec / (prec + rec))
    out = {
        "coverage": round(float(keep.mean()), 4), "n": int(keep.sum()), "referred": int((~keep).sum()),
        "accuracy": round(float((pk == yk).mean()), 4), "macro_f1": round(float(np.mean(f1s)), 4),
    }
    if len(set(yk)) == 2:
        from sklearn.metrics import roc_auc_score
        out["auroc"] = round(float(roc_auc_score(yk, s[keep])), 4)
    return out


def band_for_accuracy(y, s, t, target):
    """Smallest uncertain band around t (in log-odds distance) reaching the target accuracy on train."""
    eps = 1e-6
    logit = lambda v: np.log((v + eps) / (1 - v + eps))
    dist = np.abs(logit(s) - logit(np.array(t)))
    for d in np.linspace(0, float(dist.max()), 400):
        keep = dist > d
        if keep.sum() and (((s[keep] >= t).astype(int)) == y[keep]).mean() >= target:
            return float(d)
    return float(dist.max())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-accuracy", type=float, default=0.90, help="target accuracy on answered TRAIN images (used when --refer is 0)")
    ap.add_argument("--refer", type=float, default=0.10, help="share of least-confident TRAIN images to refer; sets the uncertain band")
    a = ap.parse_args()
    t0 = time.time()
    train, test = list_split("train"), list_split("test")
    print(f"train {len(train)} / test {len(test)} images")
    ytr = np.array([c for _, c in train]); yte = np.array([c for _, c in test])
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import cross_val_predict
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    import joblib

    print("scoring test with off-the-shelf model"); base_te = score(test)
    print("extracting train features"); ftr = features(train)
    print("extracting test features"); fte = features(test)
    clf = make_pipeline(StandardScaler(), LogisticRegression(C=0.05, max_iter=3000, class_weight="balanced"))
    # Out-of-fold train probabilities: threshold and band are chosen without ever touching test.
    str_ = cross_val_predict(clf, ftr, ytr, cv=5, method="predict_proba")[:, 1]
    clf.fit(ftr, ytr)
    ste = clf.predict_proba(fte)[:, 1]
    joblib.dump(clf, ROOT.parent.parent / "models_store" / "kermany_probe.joblib")

    t = youden_threshold(ytr, str_)
    eps = 1e-6
    logit = lambda v: np.log((v + eps) / (1 - v + eps))
    dist_tr = np.abs(logit(str_) - logit(np.array(t)))
    d = float(np.quantile(dist_tr, a.refer)) if a.refer > 0 else band_for_accuracy(ytr, str_, t, a.min_accuracy)
    keep_tr = np.abs(logit(str_) - logit(np.array(t))) > d
    keep_te = np.abs(logit(ste) - logit(np.array(t))) > d

    report = {
        "model": MODEL + " frozen features + logistic-regression probe trained on Kermany TRAIN", "dataset": "Kermany chest X-ray (CC BY 4.0)",
        "protocol": "threshold and uncertain band chosen on TRAIN only; applied unchanged to official TEST",
        "threshold": round(t, 4), "uncertain_band_logit": round(d, 4), "target_train_accuracy": a.min_accuracy, "refer_share_train": a.refer,
        "test": {
            "off_the_shelf_threshold_0.15_all_images": metrics(yte, base_te, 0.15),
            "probe_all_images": metrics(yte, ste, t),
            "probe_identifiable_only": metrics(yte, ste, t, keep_te),
        },
        "train": {"probe_out_of_fold_identifiable_only": metrics(ytr, str_, t, keep_tr)},
        "images": {
            split: {
                str(p.relative_to(DATA)): {"label": "pneumonia" if c else "normal", "score": round(float(sc), 4),
                                           "identifiable": bool(k)}
                for (p, c), sc, k in zip(items, scores, keep)
            }
            for split, items, scores, keep in (("train", train, str_, keep_tr), ("test", test, ste, keep_te))
        },
        "runtime_s": round(time.time() - t0, 1),
    }
    OUT.write_text(json.dumps(report, indent=1))
    print(json.dumps({k: v for k, v in report.items() if k != "images"}, indent=1))


if __name__ == "__main__":
    main()
