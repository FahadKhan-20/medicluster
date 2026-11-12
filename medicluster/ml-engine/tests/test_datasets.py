"""
tests/test_datasets.py
Unit tests for imaging datasets library:
- Manifest loading and dataset listing
- Sample querying and filtering
- Image and thumbnail endpoints
- Benchmark metrics calculation (confusion matrix, precision, recall, F1, AUROC)
- Benchmark disk caching
"""

import json
from pathlib import Path
import numpy as np
import pytest
from PIL import Image
from flask import Flask

from datasets.service import (
    datasets_bp,
    load_manifest,
    find_sample_in_dataset,
    run_benchmark_computation,
)


@pytest.fixture
def mock_dataset_env(tmp_path, monkeypatch):
    """Create isolated mock dataset manifest and tiny fixture images."""
    imaging_dir = tmp_path / "imaging"
    benchmarks_dir = imaging_dir / "benchmarks"
    thumbnails_dir = imaging_dir / "thumbnails"
    imaging_dir.mkdir(parents=True)
    benchmarks_dir.mkdir(parents=True)
    thumbnails_dir.mkdir(parents=True)

    # Create dummy images
    cxr_dir = imaging_dir / "chest-xray-pneumonia"
    norm_dir = cxr_dir / "normal"
    pneu_dir = cxr_dir / "pneumonia"
    norm_dir.mkdir(parents=True)
    pneu_dir.mkdir(parents=True)

    files = []
    # 3 Normal images
    for i in range(3):
        f_id = f"norm_{i+1:03d}"
        fn = f"{f_id}.jpg"
        p = norm_dir / fn
        # 128x128 grayscale fixture
        img = Image.fromarray(np.full((128, 128), 100, dtype=np.uint8))
        img.save(p, format="JPEG")
        files.append({
            "id": f_id,
            "filename": fn,
            "relPath": f"chest-xray-pneumonia/normal/{fn}",
            "class": "Normal",
            "bytes": p.stat().st_size,
            "width": 128,
            "height": 128,
        })

    # 3 Pneumonia images
    for i in range(3):
        f_id = f"pneu_{i+1:03d}"
        fn = f"{f_id}.jpg"
        p = pneu_dir / fn
        img = Image.fromarray(np.full((128, 128), 150, dtype=np.uint8))
        img.save(p, format="JPEG")
        files.append({
            "id": f_id,
            "filename": fn,
            "relPath": f"chest-xray-pneumonia/pneumonia/{fn}",
            "class": "Pneumonia",
            "bytes": p.stat().st_size,
            "width": 128,
            "height": 128,
        })

    manifest = {
        "version": "1.0.0",
        "datasets": {
            "chest-xray-pneumonia": {
                "name": "chest-xray-pneumonia",
                "displayName": "Chest X-ray · Pediatric Pneumonia",
                "modality": "chest-xray",
                "classes": ["Normal", "Pneumonia"],
                "classMap": {"0": "Normal", "1": "Pneumonia"},
                "license": "CC BY 4.0",
                "sourceUrl": "https://example.com/chest-xray",
                "citation": "Kermany et al. 2018",
                "compatibleModels": ["densenet121-res224-chex"],
                "counts": {"Normal": 3, "Pneumonia": 3, "total": 6},
                "files": files,
            }
        }
    }

    manifest_file = imaging_dir / "manifest.json"
    manifest_file.write_text(json.dumps(manifest))

    import datasets.service as svc
    monkeypatch.setattr(svc, "BASE_DIR", tmp_path)
    monkeypatch.setattr(svc, "MANIFEST_PATH", manifest_file)
    monkeypatch.setattr(svc, "BENCHMARKS_DIR", benchmarks_dir)
    monkeypatch.setattr(svc, "THUMBNAILS_DIR", thumbnails_dir)

    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(datasets_bp)
    client = app.test_client()

    return {
        "client": client,
        "manifest": manifest,
        "imaging_dir": imaging_dir,
        "benchmarks_dir": benchmarks_dir,
    }


def test_list_datasets(mock_dataset_env):
    client = mock_dataset_env["client"]
    res = client.get("/datasets")
    assert res.status_code == 200
    data = res.get_json()
    assert "datasets" in data
    assert len(data["datasets"]) == 1
    ds = data["datasets"][0]
    assert ds["name"] == "chest-xray-pneumonia"
    assert ds["modality"] == "chest-xray"
    assert ds["license"] == "CC BY 4.0"
    assert ds["classes"] == ["Normal", "Pneumonia"]
    assert ds["counts"]["total"] == 6


def test_get_samples_with_filters(mock_dataset_env):
    client = mock_dataset_env["client"]

    # All samples
    res = client.get("/datasets/chest-xray-pneumonia/samples")
    assert res.status_code == 200
    data = res.get_json()
    assert data["total"] == 6
    assert len(data["samples"]) == 6

    # Filter by class
    res_norm = client.get("/datasets/chest-xray-pneumonia/samples?class=Normal")
    assert res_norm.status_code == 200
    data_norm = res_norm.get_json()
    assert data_norm["filtered"] == 3
    assert all(s["class"] == "Normal" for s in data_norm["samples"])

    # Limit
    res_lim = client.get("/datasets/chest-xray-pneumonia/samples?limit=2")
    assert len(res_lim.get_json()["samples"]) == 2

    # Unknown dataset
    res_err = client.get("/datasets/nonexistent/samples")
    assert res_err.status_code == 404


def test_get_image_and_thumbnail(mock_dataset_env):
    client = mock_dataset_env["client"]

    # Valid image
    res = client.get("/datasets/chest-xray-pneumonia/image/norm_001")
    assert res.status_code == 200
    assert res.mimetype == "image/jpeg"
    assert len(res.data) > 0

    # Valid thumbnail
    res_thumb = client.get("/datasets/chest-xray-pneumonia/thumbnail/norm_001")
    assert res_thumb.status_code == 200
    assert res_thumb.mimetype == "image/jpeg"

    # 404 for unknown sample
    res_missing = client.get("/datasets/chest-xray-pneumonia/image/unknown_id")
    assert res_missing.status_code == 404


def test_benchmark_metrics_math(mock_dataset_env, monkeypatch):
    import datasets.service as svc

    # Mock evaluate_chest_sample to return deterministic values
    def mock_evaluate(img_bytes, filename, model_name):
        if "pneu" in filename:
            return "Pneumonia", 0.90
        return "Normal", 0.10

    monkeypatch.setattr(svc, "evaluate_chest_sample", mock_evaluate)

    ds = mock_dataset_env["manifest"]["datasets"]["chest-xray-pneumonia"]
    result = run_benchmark_computation(ds, "densenet121-res224-chex", limit_per_class=3)

    assert result["dataset"] == "chest-xray-pneumonia"
    assert result["model"] == "densenet121-res224-chex"
    assert result["n"] == 6

    metrics = result["metrics"]
    assert metrics["accuracy"] == 1.0
    assert metrics["macro_f1"] == 1.0
    assert metrics["auroc"] == 1.0
    assert metrics["per_class"]["Normal"]["precision"] == 1.0
    assert metrics["per_class"]["Normal"]["recall"] == 1.0
    assert metrics["per_class"]["Pneumonia"]["precision"] == 1.0
    assert metrics["per_class"]["Pneumonia"]["recall"] == 1.0

    cm = result["confusion_matrix"]
    assert cm["matrix"] == [[3, 0], [0, 3]]


def test_benchmark_endpoint_and_disk_cache(mock_dataset_env, monkeypatch):
    client = mock_dataset_env["client"]
    import datasets.service as svc

    eval_calls = 0
    def counting_eval(img_bytes, filename, model_name):
        nonlocal eval_calls
        eval_calls += 1
        return "Normal", 0.05

    monkeypatch.setattr(svc, "evaluate_chest_sample", counting_eval)

    # First call runs evaluation and writes cache
    res1 = client.post("/datasets/chest-xray-pneumonia/benchmark", json={"model": "densenet121-res224-chex"})
    assert res1.status_code == 200
    data1 = res1.get_json()
    assert data1["cached"] is False
    assert eval_calls == 6

    # Second call returns cached result without re-evaluating
    res2 = client.post("/datasets/chest-xray-pneumonia/benchmark", json={"model": "densenet121-res224-chex"})
    assert res2.status_code == 200
    data2 = res2.get_json()
    assert data2["cached"] is True
    assert eval_calls == 6  # No extra calls

    # Force call re-runs evaluation
    res3 = client.post("/datasets/chest-xray-pneumonia/benchmark", json={"model": "densenet121-res224-chex", "force": True})
    assert res3.status_code == 200
    assert res3.get_json()["cached"] is False
    assert eval_calls == 12


def test_analyze_sample_endpoint(mock_dataset_env, monkeypatch):
    client = mock_dataset_env["client"]
    import datasets.service as svc

    monkeypatch.setattr(svc, "evaluate_chest_sample", lambda b, f, m: ("Pneumonia", 0.92))

    res = client.post("/datasets/chest-xray-pneumonia/analyze/pneu_001", json={"model": "densenet121-res224-chex"})
    assert res.status_code == 200
    data = res.get_json()
    assert data["id"] == "pneu_001"
    assert data["groundTruth"] == "Pneumonia"
    assert data["predicted"] == "Pneumonia"
    assert data["matches"] is True
    assert data["score"] == 0.92

    # Test 404 for non-existent sample
    res_404 = client.post("/datasets/chest-xray-pneumonia/analyze/nonexistent")
    assert res_404.status_code == 404
