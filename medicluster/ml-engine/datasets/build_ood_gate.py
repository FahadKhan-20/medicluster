"""Rebuild the chest X-ray out-of-distribution gate (models_store/chest_ood_gate.joblib).

Method (fitted on the Kermany TRAIN split only):
- frozen torchxrayvision DenseNet121 `features2` embeddings of every train image,
- 32-cluster MiniBatchKMeans (seed 1337),
- accept threshold = 1.25 x the 99.5th percentile of train nearest-centroid distances.
Images farther than the threshold from every chest cluster are rejected as "Not a chest X-ray".

Run: python -m datasets.build_ood_gate
"""
from __future__ import annotations

from pathlib import Path

import joblib
import numpy as np

from datasets.split_identifiable import features, list_split

OUT = Path(__file__).resolve().parents[1] / "models_store" / "chest_ood_gate.joblib"


def main():
    from sklearn.cluster import MiniBatchKMeans

    train = list_split("train")
    print(f"extracting features for {len(train)} train images")
    f = features(train)
    km = MiniBatchKMeans(n_clusters=32, random_state=1337, batch_size=1024, n_init=3).fit(f)
    d = np.min(np.linalg.norm(f[:, None, :] - km.cluster_centers_[None, :, :], axis=2), axis=1)
    threshold = float(1.25 * np.percentile(d, 99.5))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"cluster_centers": km.cluster_centers_, "threshold": threshold, "n_train": len(train),
                 "method": "MiniBatchKMeans(32) on densenet121-res224-all features2, 1.25 x p99.5"}, OUT)
    print(f"saved {OUT} threshold={threshold:.4f}")


if __name__ == "__main__":
    main()
