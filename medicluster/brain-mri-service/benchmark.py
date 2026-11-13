"""Benchmark the Brain_health_monitor TFLite model on the Figshare (Cheng) brain tumor dataset.

Protocol (same as the chest X-ray work):
- Fixed seeded, stratified 80/20 train/test split, recorded in the output.
- Baseline: original TFLite model, no changes.
- Probe: logistic regression on the model's pooled features, trained on TRAIN only
  (out-of-fold train predictions pick the uncertain band), evaluated once on TEST.
- Figshare has no "no tumor" images, so this measures tumor-type accuracy only.

Run: .venv/bin/python benchmark.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import server  # noqa: E402

DATA = Path(__file__).resolve().parents[1] / "ml-engine/datasets/imaging/brain-mri-tumor/images"
CLASSES = ["glioma", "meningioma", "pituitary"]  # Figshare classes
MODEL_INDEX = {"glioma": 0, "meningioma": 1, "pituitary": 3}  # TFLite class_indices
SEED = 1337
OUT = Path(__file__).with_name("benchmark_results.json")


def macro_f1(y, p, labels):
    f = []
    for c in labels:
        tp = np.sum((p == c) & (y == c)); fp = np.sum((p == c) & (y != c)); fn = np.sum((p != c) & (y == c))
        pr = tp / max(tp + fp, 1); rc = tp / max(tp + fn, 1)
        f.append(0.0 if pr + rc == 0 else 2 * pr * rc / (pr + rc))
    return float(np.mean(f))


def main():
    t0 = time.time()
    files, y = [], []
    for ci, c in enumerate(CLASSES):
        for p in sorted((DATA / c).iterdir()):
            if p.suffix.lower() in {".png", ".jpg", ".jpeg"}:
                files.append(p); y.append(ci)
    y = np.array(y)
    rng = np.random.default_rng(SEED)
    test_mask = np.zeros(len(y), bool)
    for ci in range(len(CLASSES)):
        idx = np.where(y == ci)[0]
        test_mask[rng.choice(idx, size=round(len(idx) * 0.2), replace=False)] = True

    probs, feats = [], []
    for i, f in enumerate(files):
        pr, ft = server.run(server.preprocess(f.read_bytes()))
        probs.append(pr); feats.append(ft)
        if i % 200 == 0:
            print(f"  {i}/{len(files)}", flush=True)
    probs = np.array(probs); feats = np.array(feats)

    # Baseline: original 4-class output. Predicting "no tumor" on a tumor image counts as wrong.
    model_to_ours = {0: 0, 1: 1, 3: 2}
    base_pred = np.array([model_to_ours.get(int(np.argmax(r)), -1) for r in probs])
    yt = y[test_mask]; bt = base_pred[test_mask]
    baseline = {
        "n": int(test_mask.sum()), "accuracy": round(float((bt == yt).mean()), 4),
        "macro_f1": round(macro_f1(yt, bt, range(3)), 4),
        "predicted_no_tumor": int((bt == -1).sum()),
        "per_class_recall": {c: round(float((bt[yt == i] == i).mean()), 4) for i, c in enumerate(CLASSES)},
    }

    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import cross_val_predict
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    Xtr, ytr, Xte = feats[~test_mask], y[~test_mask], feats[test_mask]
    clf = make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=5000, class_weight="balanced"))
    oof = cross_val_predict(clf, Xtr, ytr, cv=5, method="predict_proba")
    clf.fit(Xtr, ytr)
    pte = clf.predict_proba(Xte)
    pred = pte.argmax(1)
    probe = {
        "n": int(len(yt)), "accuracy": round(float((pred == yt).mean()), 4),
        "macro_f1": round(macro_f1(yt, pred, range(3)), 4),
        "per_class_recall": {c: round(float((pred[yt == i] == i).mean()), 4) for i, c in enumerate(CLASSES)},
    }
    # Hybrid used by the live service: original model's "no tumor" gate + probe for tumor type.
    p_no = probs[test_mask][:, 2]
    hyb = np.where(p_no > 0.5, -1, pred)
    hybrid = {
        "n": int(len(yt)), "accuracy": round(float((hyb == yt).mean()), 4),
        "macro_f1": round(macro_f1(yt, hyb, range(3)), 4), "predicted_no_tumor": int((hyb == -1).sum()),
        "note": "no-tumor gate cannot be validated on Figshare (no healthy scans); every no-tumor call here is wrong",
    }
    # Selective prediction: confidence = top probability; cut-offs from out-of-fold TRAIN confidence.
    conf_tr, conf_te = oof.max(1), pte.max(1)
    coverage = []
    for refer in (0.0, 0.05, 0.10, 0.20):
        cut = float(np.quantile(conf_tr, refer)) if refer else -1.0
        k = conf_te > cut
        coverage.append({
            "refer_share_train": refer, "test_coverage": round(float(k.mean()), 4), "answered": int(k.sum()),
            "referred": int((~k).sum()), "accuracy": round(float((pred[k] == yt[k]).mean()), 4),
            "macro_f1": round(macro_f1(yt[k], pred[k], range(3)), 4), "confidence_cutoff": round(cut, 4),
        })

    import joblib
    joblib.dump({"model": clf, "classes": CLASSES}, Path(__file__).with_name("probe_figshare.joblib"))
    result = {
        "dataset": "Figshare brain tumor (Cheng), CC BY 4.0 — glioma/meningioma/pituitary, no 'no tumor' class",
        "split": f"stratified 80/20, numpy seed {SEED}", "train": int((~test_mask).sum()), "test": int(test_mask.sum()),
        "feature_dim": int(feats.shape[1]),
        "baseline_original_tflite": baseline, "probe_on_tflite_features": probe, "hybrid_live_service": hybrid, "probe_selective": coverage,
        "runtime_s": round(time.time() - t0, 1),
    }
    OUT.write_text(json.dumps(result, indent=1))
    print(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()
