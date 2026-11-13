"""Tests for OOD gate, calibrated probe threshold selection, and abstention math."""
import io
import json
from pathlib import Path
import numpy as np
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
from imaging.ood_gate import check_chest_ood, load_ood_gate
from imaging.analyzer import analyze_image, _get_probe


def test_ood_gate_loaded():
    gate = load_ood_gate()
    assert gate is not None
    assert "cluster_centers" in gate
    assert "threshold" in gate
    assert gate["threshold"] > 0


def test_ood_gate_rejects_blank():
    # Constant blank image
    blank_im = Image.new("L", (224, 224), color=0)
    buf = io.BytesIO()
    blank_im.save(buf, format="PNG")
    res = analyze_image(buf.getvalue(), filename="blank.png")
    assert res["status"] == "out_of_distribution"
    assert "Not a chest X-ray" in res["message"]
    assert res["findings"] == []
    assert res["confidence"] == 0.0


def test_ood_gate_rejects_photos():
    # Synthetic RGB color photo with non-gray channels
    rgb = np.zeros((224, 224, 3), dtype=np.uint8)
    rgb[:, :, 0] = 200  # Red
    rgb[:, :, 1] = 50   # Green
    rgb[:, :, 2] = 20   # Blue
    photo = Image.fromarray(rgb)
    buf = io.BytesIO()
    photo.save(buf, format="JPEG")
    res = analyze_image(buf.getvalue(), filename="photo.jpg")
    assert res["status"] == "out_of_distribution"
    assert "Not a chest X-ray" in res["message"]


def test_ood_gate_rejects_brain_mri():
    brain_dir = ROOT / "datasets" / "imaging" / "brain-mri-tumor"
    brain_files = list(brain_dir.rglob("*.jpg"))
    if brain_files:
        sample_brain = brain_files[0]
        res = analyze_image(sample_brain.read_bytes(), filename=sample_brain.name)
        assert res["status"] == "out_of_distribution"
        assert "Not a chest X-ray" in res["message"]


def test_threshold_selection_protocol_uses_train_only():
    split_file = ROOT / "datasets" / "imaging" / "identifiable_split.json"
    assert split_file.is_file(), "identifiable_split.json must exist"
    data = json.loads(split_file.read_text())
    assert "protocol" in data
    assert "TRAIN only" in data["protocol"]
    assert data["threshold"] == 0.4738
    assert data["uncertain_band_logit"] == 2.6952
    assert "train" in data["images"]
    assert "test" in data["images"]


def test_calibrated_probe_status_ok_and_uncertain():
    split_file = ROOT / "datasets" / "imaging" / "identifiable_split.json"
    data = json.loads(split_file.read_text())
    test_imgs = data["images"]["test"]

    # Test an identifiable image
    ident_keys = [k for k, v in test_imgs.items() if v["identifiable"]]
    assert len(ident_keys) > 0
    p_ident = ROOT / "datasets" / "imaging" / "chest-xray-pneumonia" / ident_keys[0]
    res_ident = analyze_image(p_ident.read_bytes(), filename=p_ident.name)
    assert res_ident["status"] == "ok"
    assert res_ident["threshold"] == 0.4738
    assert res_ident["confidence"] > 0

    # Test a referred / uncertain image
    unident_keys = [k for k, v in test_imgs.items() if not v["identifiable"]]
    assert len(unident_keys) == 107
    p_unident = ROOT / "datasets" / "imaging" / "chest-xray-pneumonia" / unident_keys[0]
    res_unident = analyze_image(p_unident.read_bytes(), filename=p_unident.name)
    assert res_unident["status"] == "uncertain"
    assert res_unident["findings"][0]["label"] == "Uncertain — refer to radiologist"
