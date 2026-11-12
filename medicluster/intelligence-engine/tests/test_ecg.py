"""Unit tests for ECG analysis endpoint."""
import numpy as np
import pytest
import torch
from flask import Flask, g
import ecg
import runtime
from ecg_model import CLASSES, MODEL_VERSION, STANDARD_LEADS, ECGResNet1D


@pytest.fixture
def client(tmp_path, monkeypatch):
    app = Flask(__name__)
    app.config['TESTING'] = True

    @app.before_request
    def identity():
        from flask import request
        g.actor = request.headers.get('X-Actor-Id', 'dr_smith')

    @app.errorhandler(runtime.ApiError)
    def api_error(error):
        return {'error': error.message}, error.status

    app.register_blueprint(ecg.bp)

    @app.get('/health')
    def health():
        return {'ecg': ecg.status()}

    return app.test_client()


def create_synthetic_signal(leads=12, samples=1000, freq=1.0, noise=0.05):
    t = np.linspace(0, 10, samples, endpoint=False)
    signal = np.zeros((leads, samples), dtype=np.float32)
    for i in range(leads):
        signal[i] = np.sin(2 * np.pi * freq * t + i * 0.2) + np.random.normal(0, noise, samples)
    return signal.tolist()


def test_missing_checkpoint_returns_503(client, monkeypatch, tmp_path):
    monkeypatch.setattr(ecg, 'CHECKPOINT_PATH', tmp_path / 'non_existent.pt')
    monkeypatch.setattr(ecg, '_model', None)

    payload = {'signal': create_synthetic_signal()}
    res = client.post('/ecg/analyze', json=payload)
    assert res.status_code == 503
    assert 'Model checkpoint ecg_ptbxl.pt is missing' in res.json['error']


def test_health_reports_status(client, tmp_path, monkeypatch):
    monkeypatch.setattr(ecg, 'CHECKPOINT_PATH', tmp_path / 'missing.pt')
    monkeypatch.setattr(ecg, '_model', None)
    res = client.get('/health')
    assert res.status_code == 200
    assert res.json['ecg']['model'] == MODEL_VERSION
    assert res.json['ecg']['available'] is False
    assert res.json['ecg']['loaded'] is False


def test_validation_invalid_payloads(client, tmp_path, monkeypatch):
    # Mock model so validation runs past checkpoint check
    dummy_model = ECGResNet1D(in_channels=12, num_classes=5)
    dummy_model.eval()
    monkeypatch.setattr(ecg, 'get_model', lambda: dummy_model)

    # Empty body
    assert client.post('/ecg/analyze', json=None).status_code == 400

    # Non-dict body
    assert client.post('/ecg/analyze', json=[1, 2, 3]).status_code == 400

    # Missing signal
    assert client.post('/ecg/analyze', json={'lead_order': STANDARD_LEADS}).status_code == 400

    # Wrong shape: 11 leads
    bad_shape_11 = create_synthetic_signal(leads=11, samples=1000)
    res = client.post('/ecg/analyze', json={'signal': bad_shape_11})
    assert res.status_code == 400
    assert '12' in res.json['error']

    # Wrong shape: 12 leads, 500 samples
    bad_samples = create_synthetic_signal(leads=12, samples=500)
    res = client.post('/ecg/analyze', json={'signal': bad_samples})
    assert res.status_code == 400
    assert 'shape' in res.json['error']

    # Non-numeric
    non_num = create_synthetic_signal(leads=12, samples=1000)
    non_num[0][0] = 'not_a_number'
    assert client.post('/ecg/analyze', json={'signal': non_num}).status_code == 400

    # NaN / Inf
    nan_sig = create_synthetic_signal(leads=12, samples=1000)
    nan_sig[2][10] = float('nan')
    assert client.post('/ecg/analyze', json={'signal': nan_sig}).status_code == 400

    inf_sig = create_synthetic_signal(leads=12, samples=1000)
    inf_sig[1][5] = float('inf')
    assert client.post('/ecg/analyze', json={'signal': inf_sig}).status_code == 400


def test_validation_invalid_lead_order(client, monkeypatch):
    dummy_model = ECGResNet1D(in_channels=12, num_classes=5)
    dummy_model.eval()
    monkeypatch.setattr(ecg, 'get_model', lambda: dummy_model)

    sig = create_synthetic_signal()

    # Lead order wrong length
    res = client.post('/ecg/analyze', json={'signal': sig, 'lead_order': ['I', 'II']})
    assert res.status_code == 400

    # Unknown lead
    res = client.post('/ecg/analyze', json={'signal': sig, 'lead_order': ['I', 'II', 'III', 'AVR', 'AVL', 'AVF', 'V1', 'V2', 'V3', 'V4', 'V5', 'V99']})
    assert res.status_code == 400


def test_analyze_synthetic_signal_success(client, monkeypatch):
    dummy_model = ECGResNet1D(in_channels=12, num_classes=5)
    dummy_model.eval()
    monkeypatch.setattr(ecg, 'get_model', lambda: dummy_model)

    sig = create_synthetic_signal()
    res = client.post('/ecg/analyze', json={'signal': sig})
    assert res.status_code == 200
    body = res.json

    assert body['model'] == MODEL_VERSION
    assert 'probabilities' in body
    assert set(body['probabilities'].keys()) == set(CLASSES)
    for c in CLASSES:
        assert 0.0 <= body['probabilities'][c] <= 1.0

    assert body['top'] in CLASSES
    assert body['top'] == max(body['probabilities'], key=body['probabilities'].get)


def test_lead_reordering_produces_consistent_predictions(client, monkeypatch):
    dummy_model = ECGResNet1D(in_channels=12, num_classes=5)
    dummy_model.eval()
    monkeypatch.setattr(ecg, 'get_model', lambda: dummy_model)

    sig = np.array(create_synthetic_signal(), dtype=np.float32)

    # Scramble leads
    perm = [2, 0, 1, 5, 4, 3, 11, 10, 9, 8, 7, 6]
    scrambled_sig = sig[perm].tolist()
    scrambled_leads = [STANDARD_LEADS[i] for i in perm]

    res_orig = client.post('/ecg/analyze', json={'signal': sig.tolist()})
    res_reordered = client.post('/ecg/analyze', json={'signal': scrambled_sig, 'lead_order': scrambled_leads})

    assert res_orig.status_code == 200
    assert res_reordered.status_code == 200
    assert res_orig.json['probabilities'] == res_reordered.json['probabilities']


def test_warning_on_extreme_or_flatline_amplitude(client, monkeypatch):
    dummy_model = ECGResNet1D(in_channels=12, num_classes=5)
    dummy_model.eval()
    monkeypatch.setattr(ecg, 'get_model', lambda: dummy_model)

    # Flatline
    flat = np.zeros((12, 1000), dtype=np.float32).tolist()
    res = client.post('/ecg/analyze', json={'signal': flat})
    assert res.status_code == 200
    assert 'warning' in res.json
    assert 'Flatline' in res.json['warning']

    # Extreme amplitude
    extreme = np.ones((12, 1000), dtype=np.float32) * 20.0
    res = client.post('/ecg/analyze', json={'signal': extreme.tolist()})
    assert res.status_code == 200
    assert 'warning' in res.json
    assert 'Extreme' in res.json['warning']


def test_real_checkpoint_inference_if_present(client):
    if not ecg.CHECKPOINT_PATH.is_file():
        pytest.skip("ecg_ptbxl.pt checkpoint not present")
    # Reset any mocked model
    ecg._model = None
    sig = create_synthetic_signal()
    res = client.post('/ecg/analyze', json={'signal': sig})
    assert res.status_code == 200
    assert res.json['model'] == MODEL_VERSION
    assert 'probabilities' in res.json
    assert res.json['top'] in CLASSES
