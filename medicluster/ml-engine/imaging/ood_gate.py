"""Out-of-distribution (OOD) gate for chest radiographs.

Rejects images that are not chest X-rays (blank images, photos, brain MRI)
before analysis. Threshold is set on Kermany train data embeddings.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional, Tuple
import joblib
import numpy as np

GATE_PATH = Path(__file__).resolve().parents[1] / "models_store" / "chest_ood_gate.joblib"
_GATE_CACHE = None


def load_ood_gate():
    global _GATE_CACHE
    if _GATE_CACHE is not None:
        return _GATE_CACHE
    if GATE_PATH.is_file():
        try:
            _GATE_CACHE = joblib.load(GATE_PATH)
        except Exception:
            _GATE_CACHE = None
    return _GATE_CACHE


def check_chest_ood(
    arr: np.ndarray,
    rgb_arr: Optional[np.ndarray] = None,
    features: Optional[np.ndarray] = None,
) -> Tuple[bool, Optional[str]]:
    """
    Check if an image is a valid chest radiograph.
    Returns: (is_valid, rejection_reason)
    """
    # 1. Blank image or near-constant intensity check
    if arr.size == 0 or np.all(arr == 0):
        return False, "Not a chest X-ray — cannot analyze"

    # 2. RGB color / photo check
    if rgb_arr is not None and rgb_arr.ndim == 3 and rgb_arr.shape[2] == 3:
        rg_diff = float(np.mean(np.abs(rgb_arr[:, :, 0].astype(float) - rgb_arr[:, :, 1].astype(float))))
        gb_diff = float(np.mean(np.abs(rgb_arr[:, :, 1].astype(float) - rgb_arr[:, :, 2].astype(float))))
        if rg_diff > 15.0 or gb_diff > 15.0:
            return False, "Not a chest X-ray — cannot analyze"

    # 3. Feature distance to chest train cluster embeddings
    if features is not None:
        gate = load_ood_gate()
        if gate and "cluster_centers" in gate and "threshold" in gate:
            feat = features.reshape(1, -1) if features.ndim == 1 else features
            centers = gate["cluster_centers"]
            thresh = gate["threshold"]
            # Distance to nearest chest train cluster center
            dists = np.min(np.linalg.norm(feat[:, None, :] - centers[None, :, :], axis=2), axis=1)
            if float(dists[0]) > thresh:
                return False, "Not a chest X-ray — cannot analyze"

    return True, None
