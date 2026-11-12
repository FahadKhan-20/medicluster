"""
tests/test_sepsis.py
Tests for PhysioNet 2019 Sepsis scoring model and Flask endpoint POST /sepsis/score.
"""

import pytest
import os
import sys

# Ensure ml-engine root is in python path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app
from risk.sepsis_model import score_sepsis, normalize_input_keys, compute_patient_features


@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


def test_normalize_input_keys():
    raw = {
        "heart_rate": "88",
        "O2Sat": 99,
        "systolic_bp": 120,
        "resp": 16,
        "invalid": "not-a-number",
        "null_val": None,
    }
    norm = normalize_input_keys(raw)
    assert norm["HR"] == 88.0
    assert norm["O2Sat"] == 99.0
    assert norm["SBP"] == 120.0
    assert norm["Resp"] == 16.0
    assert "invalid" not in norm
    assert "null_val" not in norm


def test_score_sepsis_low_risk_synthetic():
    hours = [
        {"HR": 72, "O2Sat": 99, "Temp": 36.8, "SBP": 120, "MAP": 82, "DBP": 70, "Resp": 16, "Age": 45},
        {"HR": 74, "O2Sat": 98, "Temp": 36.9, "SBP": 118, "MAP": 80, "DBP": 68, "Resp": 16, "Age": 45},
        {"HR": 71, "O2Sat": 99, "Temp": 36.7, "SBP": 122, "MAP": 84, "DBP": 72, "Resp": 15, "Age": 45},
    ]
    res = score_sepsis(hours)
    assert 0.0 <= res["risk"] <= 1.0
    assert res["band"] == "low"
    assert res["model"] == "sepsis2019-hgb-v1"
    assert isinstance(res["top_factors"], list)


def test_score_sepsis_high_risk_synthetic():
    hours = [
        {"HR": 102, "O2Sat": 94, "Temp": 38.2, "SBP": 100, "MAP": 72, "DBP": 62, "Resp": 22, "Age": 70, "WBC": 13.5},
        {"HR": 112, "O2Sat": 92, "Temp": 38.6, "SBP": 92, "MAP": 66, "DBP": 56, "Resp": 24, "Age": 70, "Lactate": 2.8, "WBC": 16.0},
        {"HR": 124, "O2Sat": 90, "Temp": 39.1, "SBP": 84, "MAP": 58, "DBP": 48, "Resp": 28, "Age": 70, "Lactate": 4.2, "WBC": 19.5},
    ]
    res = score_sepsis(hours)
    assert 0.0 <= res["risk"] <= 1.0
    assert res["band"] == "high"
    assert res["model"] == "sepsis2019-hgb-v1"
    assert any("tachycardia" in f.lower() or "tachypnea" in f.lower() or "lactat" in f.lower() for f in res["top_factors"])


def test_score_sepsis_strict_validation():
    # Empty list
    with pytest.raises(ValueError, match="non-empty list"):
        score_sepsis([])

    # Invalid type for hours
    with pytest.raises(ValueError, match="non-empty list"):
        score_sepsis("not-a-list")  # type: ignore

    # Non-dict item
    with pytest.raises(ValueError, match="must be a dictionary"):
        score_sepsis([{"HR": 80}, "invalid_row"])  # type: ignore

    # Dict without valid clinical columns
    with pytest.raises(ValueError, match="At least one valid numerical vital sign"):
        score_sepsis([{"irrelevant": "text"}])


def test_sepsis_endpoint_post_success(client):
    payload = {
        "hours": [
            {"HR": 75, "O2Sat": 98, "Temp": 37.0, "SBP": 120, "MAP": 85, "DBP": 75, "Resp": 16, "Age": 50},
            {"HR": 78, "O2Sat": 98, "Temp": 37.1, "SBP": 118, "MAP": 82, "DBP": 72, "Resp": 16, "Age": 50},
        ]
    }
    resp = client.post("/sepsis/score", json=payload)
    assert resp.status_code == 200
    data = resp.get_json()
    assert "risk" in data
    assert 0.0 <= data["risk"] <= 1.0
    assert data["band"] in {"low", "medium", "high"}
    assert isinstance(data["top_factors"], list)
    assert data["model"] == "sepsis2019-hgb-v1"


def test_sepsis_endpoint_validation_errors(client):
    # No body / not JSON
    resp = client.post("/sepsis/score", data="not json", content_type="text/plain")
    assert resp.status_code == 400

    # Missing hours
    resp = client.post("/sepsis/score", json={"something_else": 123})
    assert resp.status_code == 400
    assert "hours" in resp.get_json()["error"]

    # Empty hours list
    resp = client.post("/sepsis/score", json={"hours": []})
    assert resp.status_code == 400

    # Non-dictionary item in hours
    resp = client.post("/sepsis/score", json={"hours": ["string_hour"]})
    assert resp.status_code == 400


def test_sepsis_endpoint_model_missing_returns_503(client, monkeypatch):
    import risk.sepsis_model as sm
    monkeypatch.setattr(sm, "DEFAULT_MODEL_PATH", "/nonexistent/path/to/model.joblib")
    monkeypatch.setattr(sm, "_MODEL_CACHE", None)

    payload = {"hours": [{"HR": 80, "O2Sat": 98, "Temp": 37.0, "SBP": 120, "MAP": 80, "DBP": 70, "Resp": 16}]}
    resp = client.post("/sepsis/score", json=payload)
    assert resp.status_code == 503
    assert "unavailable" in resp.get_json()["error"].lower()
