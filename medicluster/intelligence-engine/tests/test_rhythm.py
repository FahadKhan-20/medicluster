"""Tests for arrest rhythm classifier and /rhythm/classify endpoint."""
import os
import numpy as np
import pytest
from app import app
from rhythm import classify_lead, CLASSES, MODEL_NAME

@pytest.fixture
def client():
    app.config['TESTING'] = True
    os.environ['INTELLIGENCE_TOKEN'] = 'test-token-secret'
    with app.test_client() as client:
        yield client

def test_classify_lead_asystole():
    # 4 seconds at 250 Hz = 1000 samples of flatline with tiny noise
    signal = np.random.normal(0, 0.01, 1000).tolist()
    res = classify_lead(signal, 250)
    assert res["model"] == MODEL_NAME
    assert set(res["probabilities"].keys()) == set(CLASSES)
    assert res["top"] == "ASYSTOLE"
    assert res["probabilities"]["ASYSTOLE"] > 0.8

def test_classify_lead_resampling():
    # 4 seconds at 100 Hz = 400 samples
    signal = np.random.normal(0, 0.01, 400).tolist()
    res = classify_lead(signal, 100)
    assert res["model"] == MODEL_NAME
    assert res["top"] == "ASYSTOLE"

def test_classify_lead_validation_errors():
    with pytest.raises(Exception):
        classify_lead([], 250)
    with pytest.raises(Exception):
        classify_lead([1.0] * 5, 250)
    with pytest.raises(Exception):
        classify_lead([1.0] * 100, -1)

def test_rhythm_classify_http_endpoint(client):
    headers = {
        'X-Intelligence-Key': 'test-token-secret',
        'X-Actor-Id': 'clinician-test'
    }
    # Valid call
    signal = np.random.normal(0, 0.01, 1000).tolist()
    response = client.post('/rhythm/classify', headers=headers, json={
        'lead': signal,
        'fs': 250
    })
    assert response.status_code == 200
    data = response.get_json()
    assert data['model'] == MODEL_NAME
    assert 'probabilities' in data
    assert 'top' in data
    assert data['top'] in CLASSES

def test_rhythm_classify_http_unauthenticated(client):
    response = client.post('/rhythm/classify', json={'lead': [0.1] * 100, 'fs': 250})
    assert response.status_code == 401

def test_rhythm_classify_http_missing_fields(client):
    headers = {
        'X-Intelligence-Key': 'test-token-secret',
        'X-Actor-Id': 'clinician-test'
    }
    response = client.post('/rhythm/classify', headers=headers, json={'fs': 250})
    assert response.status_code == 400
