"""Arrest rhythm classification inference blueprint."""
import os
import numpy as np
import scipy.signal
import torch
import torch.nn as nn
from flask import Blueprint, request, jsonify
from runtime import ApiError

bp = Blueprint('rhythm', __name__, url_prefix='/rhythm')

CLASSES = ["VF", "VT", "ASYSTOLE", "ORGANIZED"]
FS_TARGET = 250
WINDOW_LEN = 1000  # 4 seconds at 250 Hz
MODEL_NAME = "arrest-rhythm-v1"

class ConvBlock(nn.Module):
    def __init__(self, in_c, out_c, k=7, s=2):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv1d(in_c, out_c, kernel_size=k, stride=s, padding=k//2),
            nn.BatchNorm1d(out_c),
            nn.LeakyReLU(0.1, inplace=True),
            nn.Conv1d(out_c, out_c, kernel_size=k, stride=1, padding=k//2),
            nn.BatchNorm1d(out_c),
            nn.LeakyReLU(0.1, inplace=True),
        )
        self.down = nn.Sequential(
            nn.Conv1d(in_c, out_c, kernel_size=1, stride=s),
            nn.BatchNorm1d(out_c)
        ) if (in_c != out_c or s != 1) else nn.Identity()

    def forward(self, x):
        return self.conv(x) + self.down(x)

class ArrestRhythmCNN(nn.Module):
    def __init__(self, num_classes=4):
        super().__init__()
        self.net = nn.Sequential(
            ConvBlock(1, 32, k=15, s=2),
            ConvBlock(32, 64, k=11, s=2),
            ConvBlock(64, 128, k=7, s=2),
            ConvBlock(128, 128, k=5, s=2),
            nn.AdaptiveAvgPool1d(1)
        )
        self.classifier = nn.Sequential(
            nn.Linear(128, 64),
            nn.ReLU(inplace=True),
            nn.Dropout(0.3),
            nn.Linear(64, num_classes)
        )

    def forward(self, x):
        feat = self.net(x).flatten(1)
        return self.classifier(feat)

_model = None

def get_model():
    global _model
    if _model is not None:
        return _model
    base_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(base_dir, "arrest_rhythm.pt")
    model = ArrestRhythmCNN(num_classes=4)
    if os.path.exists(model_path):
        ckpt = torch.load(model_path, map_location="cpu", weights_only=False)
        model.load_state_dict(ckpt["state_dict"])
    model.eval()
    _model = model
    return _model

def normalize_signal(sig):
    sig = np.nan_to_num(sig, nan=0.0)
    std = float(np.std(sig))
    mean = float(np.mean(sig))
    denom = max(std, 0.08)
    return np.clip((sig - mean) / denom, -10.0, 10.0)

def classify_lead(lead_data, fs):
    if not isinstance(lead_data, (list, np.ndarray)) or len(lead_data) < 10:
        raise ApiError(400, "Lead signal must contain at least 10 samples")
    if not isinstance(fs, (int, float)) or fs <= 0:
        raise ApiError(400, "fs must be a positive number")

    arr = np.array(lead_data, dtype=np.float32)
    # Resample to 250 Hz if needed
    if fs != FS_TARGET:
        target_num_samples = int(round(len(arr) * (FS_TARGET / fs)))
        if target_num_samples >= 2:
            arr = scipy.signal.resample(arr, target_num_samples)
        else:
            raise ApiError(400, "Signal too short for resampling")

    # Take the last 4 seconds (1000 samples), or pad if shorter
    if len(arr) >= WINDOW_LEN:
        arr = arr[-WINDOW_LEN:]
    else:
        # Pad with edge values or zeros
        arr = np.pad(arr, (WINDOW_LEN - len(arr), 0), mode="edge")

    norm = normalize_signal(arr)
    tensor = torch.tensor(norm, dtype=torch.float32).unsqueeze(0).unsqueeze(0)  # (1, 1, 1000)

    model = get_model()
    with torch.no_grad():
        logits = model(tensor)
        probs = torch.softmax(logits, dim=1).squeeze(0).cpu().numpy()

    prob_dict = {cls_name: round(float(p), 4) for cls_name, p in zip(CLASSES, probs)}
    top_class = CLASSES[int(np.argmax(probs))]

    return {
        "probabilities": prob_dict,
        "top": top_class,
        "model": MODEL_NAME
    }

@bp.post('/classify')
def classify_endpoint():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError(400, "Expected a JSON object")
    lead = data.get("lead")
    fs = data.get("fs")
    if lead is None or fs is None:
        raise ApiError(400, "Missing required fields: lead and fs")

    result = classify_lead(lead, fs)
    return jsonify(result)
