"""Brain MRI inference service for MediCluster (BRAIN_MRI_URL, default port 8001).

Serves the Brain_health_monitor MobileNetV2 TFLite classifier imported by CORTIA
(models/mri/brain_tumor_model.tflite, preprocessing "legacy_rgb_0_1": RGB, 224x224, /255).
Optional linear probe (probe.joblib) trained on top of the model's pooled features, mirroring
the chest X-ray approach; used only when present and reported in the response.

Contract (medicluster/backend/services/brainMri.js):
  POST /api/predict  multipart field "file"
  -> {success, label, is_tumor, probabilities{Glioma,Meningioma,No Tumor,Pituitary} (percent, sum 100),
      explanation{available}, model}
"""
from __future__ import annotations

import base64
import io
import os
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

MODEL_DIR = Path(os.getenv("BRAIN_MODEL_DIR", Path(__file__).with_name("models") / "mri"))
MODEL_PATH = MODEL_DIR / "brain_tumor_model.tflite"
PROBE_PATH = Path(os.getenv("BRAIN_PROBE_PATH", Path(__file__).with_name("probe_figshare.joblib")))
# Tumor-type confidence below this (10% least-confident TRAIN images, out-of-fold) -> refer to radiologist.
UNCERTAIN_BELOW = float(os.getenv("BRAIN_UNCERTAIN_BELOW", "0.772"))
NO_TUMOR_GATE = float(os.getenv("BRAIN_NO_TUMOR_GATE", "0.5"))
KEYS = ["Glioma", "Meningioma", "No Tumor", "Pituitary"]  # class_indices.json order 0..3
LABELS = {"Glioma": "Glioma Tumor", "Meningioma": "Meningioma Tumor", "No Tumor": "No Tumor", "Pituitary": "Pituitary Tumor"}
MAX_BYTES = 20 * 1024 * 1024

_interp = None
_probe = None


def interpreter():
    global _interp
    if _interp is None:
        from ai_edge_litert.interpreter import Interpreter

        _interp = Interpreter(model_path=str(MODEL_PATH), experimental_preserve_all_tensors=True)
        _interp.allocate_tensors()
    return _interp


def probe():
    global _probe
    if _probe is None and PROBE_PATH.exists():
        import joblib

        _probe = joblib.load(PROBE_PATH)
    return _probe


def preprocess(data: bytes) -> np.ndarray:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(422, "Invalid brain MRI image") from exc
    img = img.convert("RGB").resize((224, 224), Image.BILINEAR)
    return (np.asarray(img, dtype=np.float32) / 255.0)[None]


def feature_tensor_index(it) -> int | None:
    """Index of the pooled feature vector feeding the dense head (rank-2, widest, not the output)."""
    out_idx = it.get_output_details()[0]["index"]
    best = None
    for d in it.get_tensor_details():
        shp = d["shape"]
        if d["index"] != out_idx and len(shp) == 2 and shp[0] == 1 and shp[1] >= 256:
            if best is None or shp[1] > best[1]:
                best = (d["index"], shp[1])
    return best[0] if best else None


def run(batch: np.ndarray) -> tuple[np.ndarray, np.ndarray | None]:
    it = interpreter()
    it.set_tensor(it.get_input_details()[0]["index"], batch)
    it.invoke()
    probs = it.get_tensor(it.get_output_details()[0]["index"])[0].astype(np.float64)
    fi = feature_tensor_index(it)
    feats = it.get_tensor(fi)[0].astype(np.float64) if fi is not None else None
    return probs, feats


def _class_score(batch: np.ndarray, key: str) -> float:
    probs, feats = run(batch)
    p = probe()
    if p is not None and feats is not None and key != "No Tumor":
        t = p["model"].predict_proba(feats[None])[0]
        return float(t[["Glioma", "Meningioma", "Pituitary"].index(key)])
    probs = np.clip(probs, 0, None)
    return float(probs[KEYS.index(key)] / max(probs.sum(), 1e-9))


def _jet(v: np.ndarray) -> np.ndarray:
    r = np.clip(1.5 - np.abs(4 * v - 3), 0, 1)
    g = np.clip(1.5 - np.abs(4 * v - 2), 0, 1)
    b = np.clip(1.5 - np.abs(4 * v - 1), 0, 1)
    return np.stack([r, g, b], -1)


def occlusion_heatmap(data: bytes, key: str, grid: int = 14) -> str | None:
    """Slide a grey patch over the slice; the drop in the predicted class score is the importance."""
    try:
        x = preprocess(data)
        base = _class_score(x, key)
        size = 224 // grid
        heat = np.zeros((grid, grid), np.float32)
        for i in range(grid):
            for j in range(grid):
                occ = x.copy()
                occ[0, i * size:(i + 1) * size, j * size:(j + 1) * size, :] = 0.5
                heat[i, j] = max(0.0, base - _class_score(occ, key))
        if heat.max() <= 1e-6:
            return None
        heat = heat / heat.max()
        hm = np.asarray(Image.fromarray((heat * 255).astype(np.uint8)).resize((224, 224), Image.BICUBIC), np.float32) / 255
        rgb = (x[0] * 255).astype(np.float32)
        alpha = (0.55 * hm)[..., None]
        out = (rgb * (1 - alpha) + _jet(hm) * 255 * alpha).clip(0, 255).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(out).save(buf, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except HTTPException:
        raise
    except Exception:
        return None


def classify(data: bytes) -> dict:
    """Original model decides tumor vs no tumor; the probe (trained on Figshare TRAIN) decides tumor type."""
    probs, feats = run(preprocess(data))
    probs = np.clip(probs, 0, None)
    probs = probs / probs.sum() if probs.sum() > 0 else np.full(4, 0.25)
    source, uncertain, type_conf = "tflite", False, None
    p = probe()
    if p is not None and feats is not None:
        t = p["model"].predict_proba(feats[None])[0]  # glioma, meningioma, pituitary
        type_conf = float(t.max())
        p_no = float(probs[2])
        probs = np.array([(1 - p_no) * t[0], (1 - p_no) * t[1], p_no, (1 - p_no) * t[2]])
        source = "tflite-no-tumor-gate+figshare-probe"
        uncertain = p_no <= NO_TUMOR_GATE and type_conf < UNCERTAIN_BELOW
    pct = np.round(probs * 100, 4)
    pct[int(np.argmax(pct))] += round(100 - float(pct.sum()), 4)
    key = "No Tumor" if probs[2] > NO_TUMOR_GATE else KEYS[int(np.argmax(probs))]
    heat = occlusion_heatmap(data, key) if os.getenv("BRAIN_HEATMAP", "1") != "0" else None
    return {
        "success": True,
        "label": LABELS[key],
        "is_tumor": key != "No Tumor",
        "probabilities": {k: float(v) for k, v in zip(KEYS, pct)},
        "uncertain": uncertain,
        "tumor_type_confidence": type_conf,
        "explanation": (
            {"available": True, "method": "occlusion", "reason": "Occlusion sensitivity: regions whose masking most lowers the predicted class. Model attention, not tumour boundaries."}
            if heat else {"available": False, "reason": "Heatmap unavailable for this image"}
        ),
        **({"heatmap_b64": heat} if heat else {}),
        "model": source,
    }


app = FastAPI(title="MediCluster Brain MRI service")


@app.get("/health")
def health():
    return {"status": "ok", "model": str(MODEL_PATH.name), "probe": PROBE_PATH.exists()}


@app.post("/api/predict")
async def predict(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Upload too large")
    if file.content_type and not file.content_type.startswith(("image/", "application/dicom", "application/octet-stream")):
        raise HTTPException(415, "Unsupported media type")
    return classify(data)
