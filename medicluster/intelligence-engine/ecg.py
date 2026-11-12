"""ECG analysis blueprint: PTB-XL 12-lead multi-label classification."""
from pathlib import Path
import threading
import numpy as np
import torch
from flask import Blueprint, jsonify, request
from runtime import ApiError
from ecg_model import CLASSES, MODEL_VERSION, STANDARD_LEADS, ECGResNet1D, normalize_signal

bp = Blueprint('ecg', __name__)

BASE_DIR = Path(__file__).resolve().parent
CHECKPOINT_PATH = BASE_DIR / 'checkpoints' / 'ecg_ptbxl.pt'

_model = None
_model_lock = threading.Lock()
_device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')


def get_model():
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        if not CHECKPOINT_PATH.is_file():
            raise ApiError(503, 'Model checkpoint ecg_ptbxl.pt is missing')
        model = ECGResNet1D(in_channels=12, num_classes=len(CLASSES)).to(_device)
        checkpoint = torch.load(CHECKPOINT_PATH, map_location=_device, weights_only=True)
        model.load_state_dict(checkpoint['model_state_dict'])
        model.eval()
        _model = model
        return _model


def status():
    return {
        'model': MODEL_VERSION,
        'available': CHECKPOINT_PATH.is_file(),
        'loaded': _model is not None,
    }


def parse_and_validate_ecg_request(data):
    if not isinstance(data, dict):
        raise ApiError(400, 'JSON body must be an object')
    if 'signal' not in data:
        raise ApiError(400, 'Missing required field: signal')

    raw_signal = data['signal']
    if not isinstance(raw_signal, list) or len(raw_signal) != 12:
        raise ApiError(400, 'signal must be a 12x1000 array representing 12 leads')

    # Convert to numpy array and validate shape and finite values
    try:
        arr = np.array(raw_signal, dtype=np.float32)
    except (ValueError, TypeError):
        raise ApiError(400, 'signal must contain numeric values only')

    if arr.shape != (12, 1000):
        raise ApiError(400, f'signal must have shape (12, 1000), got {arr.shape}')

    if not np.all(np.isfinite(arr)):
        raise ApiError(400, 'signal contains NaN or infinite values')

    # Validate lead_order if provided
    lead_order = data.get('lead_order')
    if lead_order is not None:
        if not isinstance(lead_order, list) or len(lead_order) != 12:
            raise ApiError(400, 'lead_order must be a list of 12 lead names')
        norm_order = [str(lead).strip().upper() for lead in lead_order]
        std_norm = [l.upper() for l in STANDARD_LEADS]
        if sorted(norm_order) != sorted(std_norm):
            raise ApiError(400, f'lead_order must contain all 12 standard leads: {STANDARD_LEADS}')

        # Reorder leads to match STANDARD_LEADS order
        order_map = {name: idx for idx, name in enumerate(norm_order)}
        indices = [order_map[l] for l in std_norm]
        arr = arr[indices]

    return arr


@bp.post('/ecg/analyze')
def analyze_ecg():
    data = request.get_json(silent=True)
    if data is None:
        raise ApiError(400, 'Valid JSON required')

    signal = parse_and_validate_ecg_request(data)
    model = get_model()

    # Check for warnings (e.g. flatline or extreme values)
    warning = None
    amplitude_peak = float(np.max(np.abs(signal)))
    if amplitude_peak < 1e-4:
        warning = 'Flatline signal detected: amplitude near zero'
    elif amplitude_peak > 15.0:
        warning = f'Extreme signal amplitude ({amplitude_peak:.1f} mV) detected'

    normalized = normalize_signal(signal)
    device = next(model.parameters()).device
    inp_tensor = torch.from_numpy(normalized)[None].to(device)  # (1, 12, 1000)

    with torch.inference_mode():
        logits = model(inp_tensor)
        probs = torch.sigmoid(logits)[0].cpu().numpy()

    probabilities = {cls: round(float(probs[i]), 4) for i, cls in enumerate(CLASSES)}
    top_class = max(probabilities, key=probabilities.get)

    result = {
        'probabilities': probabilities,
        'top': top_class,
        'model': MODEL_VERSION,
    }
    if warning:
        result['warning'] = warning

    return jsonify(result)
