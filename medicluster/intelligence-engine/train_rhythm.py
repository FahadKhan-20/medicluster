#!/usr/bin/env python3
"""Train a 1D-CNN on CUDB and VFDB datasets for arrest rhythm classification.
Classes:
0: VF (Ventricular Fibrillation / Flutter)
1: VT (Ventricular Tachycardia)
2: ASYSTOLE (Synthesised flatline + noise / low amplitude)
3: ORGANIZED (Normal sinus rhythm / supraventricular)
"""
import glob
import os
import random
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset
import wfdb

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
MODEL_PATH = os.path.join(BASE_DIR, "arrest_rhythm.pt")

CLASSES = ["VF", "VT", "ASYSTOLE", "ORGANIZED"]
FS = 250
WINDOW_LEN = 4 * FS  # 1000 samples

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
            ConvBlock(1, 32, k=15, s=2),    # 500
            ConvBlock(32, 64, k=11, s=2),   # 250
            ConvBlock(64, 128, k=7, s=2),   # 125
            ConvBlock(128, 128, k=5, s=2),  # 63
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

def parse_intervals(rec_path, db_name):
    try:
        rec = wfdb.rdrecord(rec_path)
        ann = wfdb.rdann(rec_path, "atr")
    except Exception as e:
        print(f"Error reading {rec_path}: {e}")
        return [], []

    sig = np.nan_to_num(rec.p_signal[:, 0], nan=0.0)
    n_samples = len(sig)

    # Build discrete rhythm changepoints
    events = []
    for s, sym, aux in zip(ann.sample, ann.symbol, ann.aux_note):
        aux_clean = aux.strip("\x00").strip()
        if sym == "+":
            if any(k in aux_clean for k in ["(VF", "(VFIB", "(VFL"]):
                events.append((s, "VF"))
            elif "(VT" in aux_clean:
                events.append((s, "VT"))
            elif any(k in aux_clean for k in ["(N", "(NSR", "(AF", "(AFIB", "(SBR", "(NOD", "(B", "(BI", "(PM", "(SVTA"]):
                events.append((s, "ORGANIZED"))
            elif "(ASYS" in aux_clean:
                events.append((s, "ASYSTOLE"))
        elif sym == "[":
            events.append((s, "VF"))
        elif sym == "]":
            events.append((s, "ORGANIZED"))

    # Initial state
    rhythm_timeline = np.full(n_samples, "ORGANIZED", dtype=object)
    if events:
        events.sort(key=lambda x: x[0])
        # Before first event
        first_s, first_r = events[0]
        rhythm_timeline[:first_s] = "ORGANIZED"
        for i in range(len(events)):
            curr_s, curr_r = events[i]
            next_s = events[i + 1][0] if i + 1 < len(events) else n_samples
            start = max(0, min(curr_s, n_samples))
            end = max(0, min(next_s, n_samples))
            if start < end:
                rhythm_timeline[start:end] = curr_r

    windows = []
    labels = []
    step = WINDOW_LEN // 2  # 2s step

    for st in range(0, n_samples - WINDOW_LEN, step):
        chunk = sig[st:st + WINDOW_LEN]
        if np.isnan(chunk).any() or np.isinf(chunk).any():
            continue
        seg_labels = rhythm_timeline[st:st + WINDOW_LEN]
        u, counts = np.unique(seg_labels, return_counts=True)
        top_label = u[np.argmax(counts)]
        if np.max(counts) >= 0.7 * WINDOW_LEN:
            windows.append(chunk)
            labels.append(top_label)

    return windows, labels

def generate_asystole(count):
    windows = []
    for _ in range(count):
        t = np.linspace(0, 4, WINDOW_LEN)
        noise = np.random.normal(0, random.uniform(0.005, 0.02), WINDOW_LEN)
        drift = random.uniform(0.005, 0.02) * np.sin(2 * np.pi * random.uniform(0.1, 0.5) * t + random.uniform(0, np.pi))
        hum = random.uniform(0.002, 0.005) * np.sin(2 * np.pi * random.choice([50, 60]) * t)
        windows.append(noise + drift + hum)
    return windows

def normalize_signal(sig):
    sig = np.nan_to_num(sig, nan=0.0)
    std = float(np.std(sig))
    mean = float(np.mean(sig))
    denom = max(std, 0.08)
    return np.clip((sig - mean) / denom, -10.0, 10.0)

def load_data():
    all_w = []
    all_l = []

    for f in sorted(glob.glob(os.path.join(DATA_DIR, "cudb", "*.hea"))):
        w, l = parse_intervals(f[:-4], "cudb")
        all_w.extend(w)
        all_l.extend(l)

    for f in sorted(glob.glob(os.path.join(DATA_DIR, "vfdb", "*.hea"))):
        w, l = parse_intervals(f[:-4], "vfdb")
        all_w.extend(w)
        all_l.extend(l)

    real_counts = {c: all_l.count(c) for c in CLASSES}
    print("Real counts:", real_counts, flush=True)

    n_asys = max(1500, real_counts["VF"])
    asys_w = generate_asystole(n_asys)
    all_w.extend(asys_w)
    all_l.extend(["ASYSTOLE"] * n_asys)

    # Balance classes (target 2000 per class)
    target = 2000
    bal_w, bal_l = [], []
    random.seed(42)
    for c in CLASSES:
        cw = [w for w, l in zip(all_w, all_l) if l == c]
        if len(cw) > target:
            cw = random.sample(cw, target)
        elif len(cw) < target and len(cw) > 0:
            # Over-sample to target
            cw = cw * (target // len(cw)) + random.sample(cw, target % len(cw))
        bal_w.extend(cw)
        bal_l.extend([c] * len(cw))

    print(f"Balanced size: {len(bal_w)}", flush=True)
    for c in CLASSES:
        print(f"  {c}: {bal_l.count(c)}", flush=True)

    X = np.array([normalize_signal(w) for w in bal_w], dtype=np.float32)[:, np.newaxis, :]
    y = np.array([CLASSES.index(l) for l in bal_l], dtype=np.int64)

    return X, y

def train():
    random.seed(42)
    np.random.seed(42)
    torch.manual_seed(42)

    X, y = load_data()

    indices = np.arange(len(X))
    np.random.shuffle(indices)
    split = int(0.8 * len(indices))
    train_idx, test_idx = indices[:split], indices[split:]

    X_train, y_train = torch.tensor(X[train_idx]), torch.tensor(y[train_idx])
    X_test, y_test = torch.tensor(X[test_idx]), torch.tensor(y[test_idx])

    train_loader = DataLoader(TensorDataset(X_train, y_train), batch_size=64, shuffle=True)
    test_loader = DataLoader(TensorDataset(X_test, y_test), batch_size=64, shuffle=False)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Training on: {device}", flush=True)

    model = ArrestRhythmCNN(num_classes=4).to(device)
    criterion = nn.CrossEntropyLoss()
    optimizer = optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=12)

    for epoch in range(1, 13):
        model.train()
        total_loss, correct, total = 0.0, 0, 0
        for bx, by in train_loader:
            bx, by = bx.to(device), by.to(device)
            optimizer.zero_grad()
            out = model(bx)
            loss = criterion(out, by)
            loss.backward()
            optimizer.step()
            total_loss += loss.item() * len(by)
            preds = out.argmax(dim=1)
            correct += (preds == by).sum().item()
            total += len(by)
        scheduler.step()
        print(f"Epoch {epoch:2d}/12 - Loss: {total_loss / total:.4f} - Acc: {correct / total:.4f}", flush=True)

    model.eval()
    all_preds, all_targets = [], []
    with torch.no_grad():
        for bx, by in test_loader:
            bx, by = bx.to(device), by.to(device)
            out = model(bx)
            preds = out.argmax(dim=1)
            all_preds.extend(preds.cpu().numpy())
            all_targets.extend(by.cpu().numpy())

    all_preds = np.array(all_preds)
    all_targets = np.array(all_targets)

    f1_scores = {}
    print("\n--- TEST EVALUATION RESULTS ---", flush=True)
    for idx, c in enumerate(CLASSES):
        tp = int(np.sum((all_preds == idx) & (all_targets == idx)))
        fp = int(np.sum((all_preds == idx) & (all_targets != idx)))
        fn = int(np.sum((all_preds != idx) & (all_targets == idx)))
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0
        f1_scores[c] = float(f1)
        print(f"Class {c:10s}: Precision = {precision:.4f}, Recall = {recall:.4f}, F1 = {f1:.4f} (Support = {tp + fn})", flush=True)

    macro_f1 = float(np.mean(list(f1_scores.values())))
    overall_acc = float(np.mean(all_preds == all_targets))
    print(f"Overall Accuracy: {overall_acc:.4f}, Macro F1: {macro_f1:.4f}", flush=True)

    torch.save({
        "state_dict": model.cpu().state_dict(),
        "classes": CLASSES,
        "fs": FS,
        "window_len": WINDOW_LEN,
        "f1_scores": f1_scores,
        "macro_f1": macro_f1,
        "overall_acc": overall_acc
    }, MODEL_PATH)
    print(f"Checkpoint saved to {MODEL_PATH}", flush=True)

if __name__ == "__main__":
    train()
