"""Multi-model chest radiograph and single-frame DICOM analysis."""

import io
from pathlib import Path
import json
import joblib
import numpy as np
import torch
import torchxrayvision as xrv
from PIL import Image

from clinical_knowledge import get_clinical_info
from imaging.ood_gate import check_chest_ood

# ── Model registry ────────────────────────────────────────────────────────────

XRV_MODELS = {
    "densenet121-res224-chex": {
        "label": "CheXNet · CheXpert (recommended)",
        "desc":  "Best calibrated — trained on Stanford CheXpert (224k expert-labeled chest X-rays)",
        "loader": lambda: xrv.models.DenseNet(weights="densenet121-res224-chex"),
        "size":  224,
    },
    "densenet121-res224-all": {
        "label": "DenseNet121 · All datasets",
        "desc":  "General purpose — trained on CheXpert + NIH + MIMIC + PadChest",
        "loader": lambda: xrv.models.DenseNet(weights="densenet121-res224-all"),
        "size":  224,
    },
    "resnet50-res512-all": {
        "label": "ResNet50 · High-res (512px)",
        "desc":  "Higher resolution input — more detail, same dataset coverage",
        "loader": lambda: xrv.models.ResNet(weights="resnet50-res512-all"),
        "size":  512,
    },
    "densenet121-res224-nih": {
        "label": "DenseNet121 · NIH ChestX-ray14",
        "desc":  "Trained on NIH ChestX-ray14 — most widely validated benchmark",
        "loader": lambda: xrv.models.DenseNet(weights="densenet121-res224-nih"),
        "size":  224,
    },
    "densenet121-res224-pc": {
        "label": "DenseNet121 · PadChest",
        "desc":  "Trained on PadChest — detects the widest range of pathologies",
        "loader": lambda: xrv.models.DenseNet(weights="densenet121-res224-pc"),
        "size":  224,
    },
}

DEFAULT_MODEL = "densenet121-res224-chex"
_cache: dict = {}

CONFIDENCE_THRESHOLD = 0.15

PROBE_PATH = Path(__file__).resolve().parents[1] / "models_store" / "kermany_probe.joblib"
SPLIT_PATH = Path(__file__).resolve().parents[1] / "datasets" / "imaging" / "identifiable_split.json"
_PROBE_CACHE = None


def _get_probe():
    global _PROBE_CACHE
    if _PROBE_CACHE is not None:
        return _PROBE_CACHE
    if PROBE_PATH.is_file():
        try:
            probe = joblib.load(PROBE_PATH)
            threshold = 0.4738
            band = 2.6952
            if SPLIT_PATH.is_file():
                try:
                    split_info = json.loads(SPLIT_PATH.read_text())
                    threshold = float(split_info.get("threshold", threshold))
                    band = float(split_info.get("uncertain_band_logit", band))
                except Exception:
                    pass
            _PROBE_CACHE = (probe, threshold, band)
        except Exception:
            _PROBE_CACHE = None
    return _PROBE_CACHE


def _is_medical_scan(arr: np.ndarray) -> str | None:
    """
    Returns a warning string if the image is probably not a medical scan,
    or None if it looks like one.
    Checks: near-grayscale colour channels and minimum size.
    """
    if arr.shape[0] < 128 or arr.shape[1] < 128:
        return "Image may not be a medical scan — resolution too low (min 128×128 px)"

    if arr.ndim == 3 and arr.shape[2] == 3:
        rg_diff = float(np.mean(np.abs(arr[:, :, 0].astype(float) - arr[:, :, 1].astype(float))))
        gb_diff = float(np.mean(np.abs(arr[:, :, 1].astype(float) - arr[:, :, 2].astype(float))))
        if rg_diff > 15 or gb_diff > 15:
            return "Image may not be a medical scan — results may be unreliable"

    return None


def _attach_clinical_info(findings: list[dict], threshold: float = CONFIDENCE_THRESHOLD) -> list[dict]:
    """
    Filter findings below threshold, attach clinical info, sort by confidence desc.
    """
    filtered = [f for f in findings if f.get("confidence", 0) >= threshold]
    filtered.sort(key=lambda f: f["confidence"], reverse=True)
    for f in filtered:
        info = get_clinical_info(f["label"])
        f["cause"]        = info["cause"]
        f["medications"]  = info["medications"]
        f["prevention"]   = info["prevention"]
        f["severity"]     = info["severity"]
    return filtered


def list_models() -> list:
    return [
        {"id": k, "label": v["label"], "desc": v["desc"], "size": v["size"]}
        for k, v in XRV_MODELS.items()
    ]


def _get_model(model_name: str):
    if model_name not in XRV_MODELS:
        raise ValueError(f"Unknown model: {model_name}")
    if model_name not in _cache:
        m = XRV_MODELS[model_name]["loader"]()
        m.eval()
        _cache[model_name] = m
    return _cache[model_name]


# ── Preprocessing ─────────────────────────────────────────────────────────────

def _load_pixels(image_bytes: bytes, filename: str = "", radiograph_only: bool = True) -> tuple[np.ndarray, bool]:
    """
    Returns (arr, is_dicom).
    - Regular images: float32 [0, 255] grayscale.
    - DICOM: float32 display intensities [0,255], respecting VOI and polarity.
    """
    ext = filename.lower()
    if ext.endswith(".dcm") or ext.endswith(".dicom"):
        import pydicom
        ds = pydicom.dcmread(io.BytesIO(image_bytes))
        from pydicom.pixels import apply_modality_lut, apply_voi_lut
        if int(getattr(ds,'Rows',0))*int(getattr(ds,'Columns',0))>40_000_000:raise ValueError('Image exceeds 40 million pixels')
        if int(getattr(ds, 'NumberOfFrames', 1)) != 1 or int(getattr(ds, 'SamplesPerPixel', 1)) != 1:
            raise ValueError('Expected a single-frame monochrome chest radiograph')
        if radiograph_only and str(getattr(ds, 'Modality', '')).upper() in ('MR', 'CT'):
            raise ValueError('Expected chest radiograph DICOM, not MRI or CT')
        arr = np.asarray(apply_voi_lut(apply_modality_lut(ds.pixel_array, ds), ds), dtype=np.float32)
        if arr.ndim != 2 or not np.isfinite(arr).all():
            raise ValueError('Expected a finite single-frame chest radiograph')
        low, high = float(arr.min()), float(arr.max())
        arr = (arr-low) * (255.0/(high-low)) if high > low else np.zeros_like(arr)
        if str(getattr(ds, 'PhotometricInterpretation', '')).upper() == 'MONOCHROME1':
            arr = 255.0-arr
        return np.clip(arr, 0, 255), True

    img = Image.open(io.BytesIO(image_bytes))
    if img.width*img.height>40_000_000:raise ValueError("Image exceeds 40 million pixels")
    img = img.convert("L")
    return np.array(img, dtype=np.float32), False


def _apply_clahe(arr: np.ndarray) -> np.ndarray:
    """CLAHE contrast enhancement — bridges gap between stock images and DICOM."""
    import cv2
    uint8 = np.clip(arr, 0, 255).astype(np.uint8)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return clahe.apply(uint8).astype(np.float32)


def _preprocess(arr: np.ndarray, size: int, is_dicom: bool) -> torch.Tensor:
    """
    Use torchxrayvision's own normaliser and transforms — exactly matching
    the preprocessing used during training.
    """
    if not is_dicom:
        arr = _apply_clahe(arr)

    # xrv.datasets.normalize: float32 path → maps input to [-1024, 1024]
    arr = xrv.datasets.normalize(arr, 255)

    # Add channel dim → (1, H, W)
    if arr.ndim == 2:
        arr = arr[None, ...]

    # torchxrayvision's own center-crop + resizer (same as training pipeline)
    import torchvision.transforms as T
    transform = T.Compose([
        xrv.datasets.XRayCenterCrop(),
        xrv.datasets.XRayResizer(size),
    ])
    arr = transform(arr)

    return torch.from_numpy(arr).unsqueeze(0)  # (1, 1, H, W)


# ── Main entry ────────────────────────────────────────────────────────────────

def analyze_image(
    image_bytes: bytes,
    model_name: str = DEFAULT_MODEL,
    filename: str = "",
) -> dict:
    cfg = XRV_MODELS.get(model_name)
    if cfg is None:
        raise ValueError(f"Unknown model: {model_name}")

    arr, is_dicom = _load_pixels(image_bytes, filename)

    # Validate image looks like a medical scan (inspect original colour channels if present)
    scan_warning = None
    rgb_arr = None
    if not is_dicom:
        try:
            raw_im = Image.open(io.BytesIO(image_bytes))
            if raw_im.mode in ("RGB", "RGBA"):
                rgb_arr = np.array(raw_im.convert("RGB"), dtype=np.uint8)
                scan_warning = _is_medical_scan(rgb_arr)
        except Exception:
            rgb_arr = None

    model  = _get_model(model_name)
    is_real_model = hasattr(model, "features2") or any(p in model_name for p in ("densenet", "resnet"))

    # Initial OOD check for blank or non-medical photo scans
    if is_real_model:
        valid_initial, ood_reason = check_chest_ood(arr, rgb_arr=rgb_arr if not is_dicom else None)
        if not valid_initial:
            return {
                "status": "out_of_distribution",
                "message": ood_reason or "Not a chest X-ray — cannot analyze",
                "error": ood_reason or "Not a chest X-ray — cannot analyze",
                "findings": [],
                "model": model_name,
                "model_label": cfg["label"],
                "confidence": 0.0,
                "threshold": 0.4738,
                "scan_warning": scan_warning or ood_reason,
            }
    tensor = _preprocess(arr, cfg["size"], is_dicom)

    # Penultimate features check for OOD and calibrated probe
    features = None
    if model_name == "densenet121-res224-all" and hasattr(model, "features2"):
        with torch.no_grad():
            features = model.features2(tensor).cpu().numpy()
    elif "densenet121-res224-all" in XRV_MODELS:
        try:
            feat_model = _get_model("densenet121-res224-all")
            feat_tensor = _preprocess(arr, 224, is_dicom)
            with torch.no_grad():
                features = feat_model.features2(feat_tensor).cpu().numpy()
        except Exception:
            features = None

    # Feature-based OOD check (e.g. Brain MRI rejection)
    if features is not None:
        valid_features, feat_ood_reason = check_chest_ood(arr, features=features)
        if not valid_features:
            return {
                "status": "out_of_distribution",
                "message": feat_ood_reason or "Not a chest X-ray — cannot analyze",
                "error": feat_ood_reason or "Not a chest X-ray — cannot analyze",
                "findings": [],
                "model": model_name,
                "model_label": cfg["label"],
                "confidence": 0.0,
                "threshold": 0.4738,
                "scan_warning": feat_ood_reason,
            }

    with torch.no_grad():
        output = model(tensor)

    # Pretrained TorchXRayVision models already apply sigmoid and operating-point normalization.
    probs = output.squeeze(0).cpu().numpy()

    raw_findings = [
        {"label": label, "confidence": round(float(prob), 4)}
        for label, prob in zip(model.pathologies, probs)
        if label
    ]

    probe_info = _get_probe()
    if probe_info is not None and features is not None:
        probe, threshold, band = probe_info
        pneu_prob = float(probe.predict_proba(features)[0, 1])
        eps = 1e-6
        logit_s = np.log((pneu_prob + eps) / (1.0 - pneu_prob + eps))
        logit_t = np.log((threshold + eps) / (1.0 - threshold + eps))
        dist = abs(logit_s - logit_t)

        if dist <= band:
            status = "uncertain"
            confidence = round(pneu_prob, 4)
            findings = [
                {
                    "label": "Uncertain — refer to radiologist",
                    "confidence": confidence,
                    "cause": "The image appearance is close to the decision threshold. Expert radiologist review is required.",
                    "severity": "moderate",
                    "medications": [],
                    "prevention": [],
                }
            ]
        else:
            status = "ok"
            is_pneumonia = pneu_prob >= threshold
            confidence = round(pneu_prob if is_pneumonia else (1.0 - pneu_prob), 4)

            # Update pneumonia confidence in raw findings with probe's calibrated probability
            pneu_found = False
            for f in raw_findings:
                if f["label"].lower() in {"pneumonia", "consolidation", "infiltration"}:
                    f["confidence"] = round(pneu_prob, 4)
                    pneu_found = True
            if not pneu_found and is_pneumonia:
                raw_findings.append({"label": "Pneumonia", "confidence": round(pneu_prob, 4)})

            findings = _attach_clinical_info(raw_findings, threshold=threshold)
            if not findings and not is_pneumonia:
                findings = []
    else:
        status = "ok"
        threshold = CONFIDENCE_THRESHOLD
        findings = _attach_clinical_info(raw_findings, threshold=threshold)
        confidence = float(findings[0]["confidence"]) if findings else 0.0

    result = {
        "status":      status,
        "threshold":   round(threshold, 4),
        "confidence":  round(confidence, 4),
        "findings":    findings,
        "model":       model_name,
        "model_label": cfg["label"],
    }
    if scan_warning:
        result["scan_warning"] = scan_warning

    return result
