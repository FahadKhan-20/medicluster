"""Train 1D ResNet on PTB-XL superclass task."""
import ast
import os
from pathlib import Path
import time
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset
import wfdb

from ecg_model import CLASSES, ECGResNet1D, normalize_signal

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / 'data' / 'ptbxl'
CHECKPOINT_DIR = BASE_DIR / 'checkpoints'
CHECKPOINT_PATH = CHECKPOINT_DIR / 'ecg_ptbxl.pt'
CACHE_PATH = DATA_DIR / 'ptbxl_100hz_cached.npz'


def load_dataset():
    if CACHE_PATH.is_file():
        print(f"Loading pre-cached data from {CACHE_PATH}...")
        cached = np.load(CACHE_PATH)
        return cached['X'], cached['Y'], cached['folds']

    print("Building dataset from PTB-XL records...")
    db_csv = DATA_DIR / 'ptbxl_database.csv'
    scp_csv = DATA_DIR / 'scp_statements.csv'
    if not db_csv.is_file() or not scp_csv.is_file():
        raise RuntimeError(f"Missing PTB-XL dataset files in {DATA_DIR}")

    df = pd.read_csv(db_csv, index_col='ecg_id')
    agg_df = pd.read_csv(scp_csv, index_col=0)
    agg_df = agg_df[agg_df.diagnostic == 1]

    def aggregate_diagnostic(y_dic):
        classes = set()
        for key in y_dic.keys():
            if key in agg_df.index:
                cls = agg_df.loc[key].diagnostic_class
                if pd.notna(cls):
                    classes.add(cls)
        return list(classes)

    df.scp_codes = df.scp_codes.apply(lambda x: ast.literal_eval(x) if isinstance(x, str) else x)
    df['superclasses'] = df.scp_codes.apply(aggregate_diagnostic)

    # Multi-hot encoding for CLASSES
    num_samples = len(df)
    Y = np.zeros((num_samples, len(CLASSES)), dtype=np.float32)
    for i, (_, row) in enumerate(df.iterrows()):
        for sc in row['superclasses']:
            if sc in CLASSES:
                Y[i, CLASSES.index(sc)] = 1.0

    folds = df['strat_fold'].to_numpy(dtype=np.int32)

    # Load 12-lead signals (1000, 12) -> transpose to (12, 1000)
    X = np.zeros((num_samples, 12, 1000), dtype=np.float32)
    print(f"Reading {num_samples} ECG records...")
    t0 = time.time()
    for i, (_, row) in enumerate(df.iterrows()):
        rec_path = str(DATA_DIR / row['filename_lr'])
        signal, _ = wfdb.rdsamp(rec_path)
        # signal is (1000, 12) -> (12, 1000)
        X[i] = normalize_signal(signal.T)
        if (i + 1) % 5000 == 0:
            print(f"  Processed {i+1}/{num_samples} in {time.time()-t0:.1f}s")

    print(f"Finished loading in {time.time()-t0:.1f}s. Saving cache to {CACHE_PATH}...")
    np.savez_compressed(CACHE_PATH, X=X, Y=Y, folds=folds)
    return X, Y, folds


def compute_macro_auc(y_true, y_pred):
    aucs = []
    per_class = {}
    for i, c in enumerate(CLASSES):
        # Only compute if at least one positive and one negative sample exists
        if len(np.unique(y_true[:, i])) > 1:
            score = roc_auc_score(y_true[:, i], y_pred[:, i])
            aucs.append(score)
            per_class[c] = float(score)
        else:
            per_class[c] = float('nan')
    macro = float(np.mean(aucs)) if aucs else 0.0
    return macro, per_class


def main():
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f"Using device: {device}")

    X, Y, folds = load_dataset()

    train_mask = (folds >= 1) & (folds <= 8)
    val_mask = (folds == 9)
    test_mask = (folds == 10)

    print(f"Train samples: {train_mask.sum()}, Val: {val_mask.sum()}, Test: {test_mask.sum()}")

    train_ds = TensorDataset(torch.from_numpy(X[train_mask]), torch.from_numpy(Y[train_mask]))
    val_ds = TensorDataset(torch.from_numpy(X[val_mask]), torch.from_numpy(Y[val_mask]))
    test_ds = TensorDataset(torch.from_numpy(X[test_mask]), torch.from_numpy(Y[test_mask]))

    batch_size = 64
    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True, pin_memory=torch.cuda.is_available())
    val_loader = DataLoader(val_ds, batch_size=batch_size, shuffle=False)
    test_loader = DataLoader(test_ds, batch_size=batch_size, shuffle=False)

    model = ECGResNet1D(in_channels=12, num_classes=len(CLASSES)).to(device)
    criterion = nn.BCEWithLogitsLoss()
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    epochs = 12
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs, eta_min=1e-5)

    CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
    best_val_auc = 0.0

    print("Beginning training...")
    for epoch in range(1, epochs + 1):
        model.train()
        train_loss = 0.0
        for bx, by in train_loader:
            bx, by = bx.to(device), by.to(device)
            optimizer.zero_grad()
            out = model(bx)
            loss = criterion(out, by)
            loss.backward()
            optimizer.step()
            train_loss += loss.item() * len(bx)
        scheduler.step()
        train_loss /= len(train_ds)

        # Validation
        model.eval()
        val_loss = 0.0
        val_preds, val_targets = [], []
        with torch.no_grad():
            for bx, by in val_loader:
                bx, by = bx.to(device), by.to(device)
                logits = model(bx)
                val_loss += criterion(logits, by).item() * len(bx)
                val_preds.append(torch.sigmoid(logits).cpu().numpy())
                val_targets.append(by.cpu().numpy())

        val_loss /= len(val_ds)
        val_preds = np.concatenate(val_preds, axis=0)
        val_targets = np.concatenate(val_targets, axis=0)
        val_auc, per_class_val = compute_macro_auc(val_targets, val_preds)

        print(f"Epoch {epoch:02d}/{epochs:02d} - Train Loss: {train_loss:.4f} - Val Loss: {val_loss:.4f} - Val Macro-AUC: {val_auc:.4f}")

        if val_auc > best_val_auc:
            best_val_auc = val_auc
            torch.save({
                'epoch': epoch,
                'model_state_dict': model.state_dict(),
                'optimizer_state_dict': optimizer.state_dict(),
                'val_auc': val_auc,
                'classes': CLASSES,
            }, CHECKPOINT_PATH)
            print(f"  * Saved new best checkpoint to {CHECKPOINT_PATH} (Val AUC: {val_auc:.4f})")

    # Final evaluation on Test Set (fold 10)
    print("\n--- Evaluating best model on Fold 10 Test Set ---")
    ckpt = torch.load(CHECKPOINT_PATH, map_location=device, weights_only=True)
    model.load_state_dict(ckpt['model_state_dict'])
    model.eval()

    test_preds, test_targets = [], []
    with torch.no_grad():
        for bx, by in test_loader:
            bx, by = bx.to(device), by.to(device)
            logits = model(bx)
            test_preds.append(torch.sigmoid(logits).cpu().numpy())
            test_targets.append(by.cpu().numpy())

    test_preds = np.concatenate(test_preds, axis=0)
    test_targets = np.concatenate(test_targets, axis=0)
    test_macro_auc, test_per_class = compute_macro_auc(test_targets, test_preds)

    print(f"Test Macro-AUC: {test_macro_auc:.4f}")
    for c, auc in test_per_class.items():
        print(f"  {c}: {auc:.4f}")

    # Write summary for report
    summary_path = CHECKPOINT_DIR / 'evaluation_summary.txt'
    with open(summary_path, 'w') as f:
        f.write(f"Test Macro-AUC: {test_macro_auc:.4f}\n")
        for c, auc in test_per_class.items():
            f.write(f"{c}: {auc:.4f}\n")
    print(f"Saved summary to {summary_path}")


if __name__ == '__main__':
    main()
