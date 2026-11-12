"""
risk/sepsis_model.py
PhysioNet / CinC Challenge 2019 Sepsis prediction pipeline.
Features:
  - Patient-level forward fill of clinical vitals and laboratory values
  - 6-hour rolling aggregations (mean, min, max, std, diff)
  - HistGradientBoostingClassifier model with patient-level 80/20 train/test split
"""

import os
import glob
import math
import joblib
import numpy as np
import pandas as pd
from typing import Any, Dict, List, Optional, Tuple
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score, average_precision_score
from sklearn.model_selection import train_test_split

MODEL_ID = "sepsis2019-hgb-v1"
DEFAULT_MODEL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models_store")
DEFAULT_MODEL_PATH = os.path.join(DEFAULT_MODEL_DIR, "sepsis2019.joblib")

# Core clinical columns from PhysioNet 2019
VITALS_COLS = ["HR", "O2Sat", "Temp", "SBP", "MAP", "DBP", "Resp"]
KEY_LABS_COLS = ["WBC", "Lactate", "Creatinine", "Platelets", "Glucose", "BUN", "pH", "Calcium", "Magnesium", "Potassium", "Hgb", "Hct"]
DEMO_COLS = ["Age", "Gender", "ICULOS"]

ROLLING_TARGET_COLS = ["HR", "O2Sat", "Temp", "SBP", "MAP", "DBP", "Resp", "WBC", "Lactate", "Creatinine", "Platelets", "Glucose"]

COLUMN_SYNONYMS = {
    "heart_rate": "HR",
    "heartrate": "HR",
    "hr": "HR",
    "spo2": "O2Sat",
    "o2sat": "O2Sat",
    "oxygen_saturation": "O2Sat",
    "temp": "Temp",
    "temperature": "Temp",
    "sbp": "SBP",
    "systolic_bp": "SBP",
    "systolic": "SBP",
    "map": "MAP",
    "mean_arterial_pressure": "MAP",
    "dbp": "DBP",
    "diastolic_bp": "DBP",
    "diastolic": "DBP",
    "resp": "Resp",
    "respiratory_rate": "Resp",
    "rr": "Resp",
    "wbc": "WBC",
    "white_blood_cell": "WBC",
    "lactate": "Lactate",
    "creatinine": "Creatinine",
    "platelets": "Platelets",
    "platelet_count": "Platelets",
    "age": "Age",
    "gender": "Gender",
    "glucose": "Glucose",
    "bun": "BUN",
    "ph": "pH",
    "culos": "ICULOS",
    "iculos": "ICULOS",
}


def normalize_input_keys(row: Dict[str, Any]) -> Dict[str, Any]:
    """Map common case variations and synonyms to standardized PhysioNet column names."""
    normalized = {}
    for k, v in row.items():
        if v is None:
            continue
        canon = COLUMN_SYNONYMS.get(str(k).strip().lower(), k)
        try:
            val_float = float(v)
            if not math.isnan(val_float):
                normalized[canon] = val_float
        except (ValueError, TypeError):
            continue
    return normalized


def compute_patient_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Forward-fill vitals & labs across hourly sequence and calculate 6-hour rolling statistics.
    Expects df sorted chronologically for a single patient.
    """
    df = df.copy()

    # Fill MAP if SBP and DBP exist but MAP does not
    if "MAP" not in df.columns or df["MAP"].isna().all():
        if "SBP" in df.columns and "DBP" in df.columns:
            df["MAP"] = df["DBP"] + (df["SBP"] - df["DBP"]) / 3.0

    # Ensure baseline columns exist
    all_needed = list(set(VITALS_COLS + KEY_LABS_COLS + DEMO_COLS))
    for col in all_needed:
        if col not in df.columns:
            df[col] = np.nan

    # Forward fill measurements across hours
    df[all_needed] = df[all_needed].ffill()

    # If ICULOS is missing, assign 1, 2, 3...
    if df["ICULOS"].isna().all():
        df["ICULOS"] = np.arange(1, len(df) + 1)
    else:
        df["ICULOS"] = df["ICULOS"].bfill().fillna(1.0)

    # Rolling 6h windows
    engineered = df[all_needed].copy()
    for col in ROLLING_TARGET_COLS:
        r = df[col].rolling(window=6, min_periods=1)
        engineered[f"{col}_mean_6h"] = r.mean()
        engineered[f"{col}_min_6h"] = r.min()
        engineered[f"{col}_max_6h"] = r.max()
        engineered[f"{col}_std_6h"] = r.std().fillna(0.0)
        # 6-hour delta: current value minus value 6 hours ago (or at start of window)
        engineered[f"{col}_diff_6h"] = df[col] - df[col].shift(5).bfill()

    return engineered


def train_sepsis_model(
    data_dir: str,
    output_path: str = DEFAULT_MODEL_PATH,
    max_patients_a: int = 10000,
    max_patients_b: int = 5000,
    random_state: int = 42,
) -> Dict[str, Any]:
    """
    Train HistGradientBoostingClassifier on PhysioNet 2019 dataset.
    Uses patient-level 80/20 train/test split.
    """
    set_a_pattern = os.path.join(data_dir, "training_setA", "*.psv")
    set_b_pattern = os.path.join(data_dir, "training_setB", "*.psv")

    files_a = sorted(glob.glob(set_a_pattern))[:max_patients_a]
    files_b = sorted(glob.glob(set_b_pattern))[:max_patients_b]
    all_files = files_a + files_b

    if not all_files:
        raise FileNotFoundError(f"No .psv files found in {data_dir}/training_setA or training_setB")

    print(f"Loading {len(all_files)} patient records ({len(files_a)} from Set A, {len(files_b)} from Set B)...")

    patient_records = []
    patient_has_sepsis = []
    for filepath in all_files:
        try:
            df = pd.read_csv(filepath, sep="|")
            if len(df) == 0:
                continue
            has_sepsis = int((df["SepsisLabel"] == 1).any())
            patient_records.append((filepath, df))
            patient_has_sepsis.append(has_sepsis)
        except Exception as e:
            continue

    # Patient-level 80/20 split stratified by patient-level sepsis occurrence
    train_indices, test_indices = train_test_split(
        range(len(patient_records)),
        test_size=0.20,
        random_state=random_state,
        stratify=patient_has_sepsis,
    )

    print(f"Processing features: {len(train_indices)} train patients, {len(test_indices)} test patients...")

    train_dfs = []
    for idx in train_indices:
        _, df = patient_records[idx]
        y = df["SepsisLabel"].values
        feats = compute_patient_features(df)
        feats["_target_"] = y
        train_dfs.append(feats)

    test_dfs = []
    for idx in test_indices:
        _, df = patient_records[idx]
        y = df["SepsisLabel"].values
        feats = compute_patient_features(df)
        feats["_target_"] = y
        test_dfs.append(feats)

    train_data = pd.concat(train_dfs, ignore_index=True)
    test_data = pd.concat(test_dfs, ignore_index=True)

    feature_cols = [c for c in train_data.columns if c != "_target_"]

    X_train = train_data[feature_cols].to_numpy()
    y_train = train_data["_target_"].to_numpy()
    X_test = test_data[feature_cols].to_numpy()
    y_test = test_data["_target_"].to_numpy()

    print(f"Train rows: {len(X_train)} (sepsis: {y_train.sum()} = {y_train.mean()*100:.2f}%)")
    print(f"Test rows: {len(X_test)} (sepsis: {y_test.sum()} = {y_test.mean()*100:.2f}%)")

    # HistGradientBoostingClassifier natively handles missing values (NaNs)
    # class_weight='balanced' addresses the high class imbalance (~2% positive hourly rows)
    clf = HistGradientBoostingClassifier(
        max_iter=150,
        learning_rate=0.08,
        max_depth=6,
        class_weight="balanced",
        random_state=random_state,
    )

    print("Fitting HistGradientBoostingClassifier...")
    clf.fit(X_train, y_train)

    y_pred_proba = clf.predict_proba(X_test)[:, 1]
    auroc = float(roc_auc_score(y_test, y_pred_proba))
    auprc = float(average_precision_score(y_test, y_pred_proba))

    print(f"Evaluation Results -> AUROC: {auroc:.4f}, AUPRC: {auprc:.4f}")

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    artifact = {
        "model": clf,
        "feature_cols": feature_cols,
        "model_id": MODEL_ID,
        "metrics": {
            "auroc": auroc,
            "auprc": auprc,
            "train_patients": len(train_indices),
            "test_patients": len(test_indices),
            "train_rows": len(X_train),
            "test_rows": len(X_test),
        },
    }
    joblib.dump(artifact, output_path)
    print(f"Saved trained model bundle to {output_path}")
    return artifact


_MODEL_CACHE: Optional[Dict[str, Any]] = None


def load_model(model_path: Optional[str] = None) -> Dict[str, Any]:
    global _MODEL_CACHE
    if _MODEL_CACHE is not None:
        return _MODEL_CACHE
    target_path = model_path if model_path is not None else DEFAULT_MODEL_PATH
    if not os.path.exists(target_path):
        raise FileNotFoundError(f"Model artifact not found at {target_path}")
    _MODEL_CACHE = joblib.load(target_path)
    return _MODEL_CACHE



def extract_top_factors(df_patient: pd.DataFrame) -> List[str]:
    """
    Identify key clinical factors and dynamic trends contributing to sepsis risk.
    """
    if len(df_patient) == 0:
        return []
    last = df_patient.iloc[-1]
    factors: List[str] = []

    # Heart Rate
    hr = last.get("HR")
    if pd.notna(hr):
        if hr >= 110:
            factors.append(f"Severe tachycardia (HR {hr:.0f} bpm)")
        elif hr >= 90:
            factors.append(f"Tachycardia (HR {hr:.0f} bpm)")
        elif hr <= 50:
            factors.append(f"Bradycardia (HR {hr:.0f} bpm)")

    # Respiratory rate
    resp = last.get("Resp")
    if pd.notna(resp):
        if resp >= 26:
            factors.append(f"Severe tachypnea (Resp {resp:.0f}/min)")
        elif resp >= 22:
            factors.append(f"Elevated respiratory rate (Resp {resp:.0f}/min)")

    # Temperature
    temp = last.get("Temp")
    if pd.notna(temp):
        if temp >= 38.3:
            factors.append(f"Hyperthermia / Fever (Temp {temp:.1f} °C)")
        elif temp <= 36.0:
            factors.append(f"Hypothermia (Temp {temp:.1f} °C)")

    # Blood Pressure & MAP
    map_val = last.get("MAP")
    sbp = last.get("SBP")
    if pd.notna(map_val) and map_val < 65:
        factors.append(f"Hypotension (MAP {map_val:.1f} mmHg)")
    elif pd.notna(sbp) and sbp < 90:
        factors.append(f"Low systolic BP (SBP {sbp:.0f} mmHg)")

    # Oxygen saturation
    o2 = last.get("O2Sat")
    if pd.notna(o2) and o2 < 92:
        factors.append(f"Hypoxemia (O2Sat {o2:.0f}%)")

    # Lactate
    lac = last.get("Lactate")
    if pd.notna(lac):
        if lac >= 4.0:
            factors.append(f"Severe lactic acidosis (Lactate {lac:.1f} mmol/L)")
        elif lac >= 2.0:
            factors.append(f"Elevated lactate (Lactate {lac:.1f} mmol/L)")

    # WBC
    wbc = last.get("WBC")
    if pd.notna(wbc):
        if wbc >= 12.0:
            factors.append(f"Leukocytosis (WBC {wbc:.1f} k/uL)")
        elif wbc <= 4.0:
            factors.append(f"Leukopenia (WBC {wbc:.1f} k/uL)")

    # Creatinine / Platelets
    creat = last.get("Creatinine")
    if pd.notna(creat) and creat >= 1.5:
        factors.append(f"Elevated creatinine ({creat:.1f} mg/dL)")

    plt = last.get("Platelets")
    if pd.notna(plt) and plt < 100:
        factors.append(f"Thrombocytopenia (Platelets {plt:.0f} k/uL)")

    # Check 6h trend diffs
    hr_diff = last.get("HR_diff_6h")
    if pd.notna(hr_diff) and hr_diff >= 15:
        factors.append(f"Rising heart rate (+{hr_diff:.0f} bpm over 6h)")

    map_diff = last.get("MAP_diff_6h")
    if pd.notna(map_diff) and map_diff <= -15:
        factors.append(f"Dropping MAP ({map_diff:.1f} mmHg over 6h)")

    resp_diff = last.get("Resp_diff_6h")
    if pd.notna(resp_diff) and resp_diff >= 6:
        factors.append(f"Increasing respiratory rate (+{resp_diff:.0f}/min over 6h)")

    if not factors:
        factors.append("Vitals within baseline observation thresholds")

    return factors[:5]


def score_sepsis(hours: List[Dict[str, Any]], model_path: Optional[str] = None) -> Dict[str, Any]:
    """
    Score sepsis risk given chronological hourly snapshots.
    Input validation:
      - hours must be a non-empty list of dicts
      - each item must have valid numerical clinical fields
    Returns:
      {
        "risk": 0..1,
        "band": "low" | "medium" | "high",
        "top_factors": [...],
        "model": "sepsis2019-hgb-v1"
      }
    """
    if not isinstance(hours, list) or len(hours) == 0:
        raise ValueError("'hours' must be a non-empty list of hourly readings")

    clean_rows = []
    for i, h in enumerate(hours):
        if not isinstance(h, dict):
            raise ValueError(f"Hour at index {i} must be a dictionary")
        norm = normalize_input_keys(h)
        clean_rows.append(norm)

    df_raw = pd.DataFrame(clean_rows)
    if len(df_raw.columns) == 0:
        raise ValueError("At least one valid numerical vital sign or lab value must be provided in 'hours'")

    artifact = load_model(model_path)
    clf: HistGradientBoostingClassifier = artifact["model"]
    feature_cols: List[str] = artifact["feature_cols"]

    df_features = compute_patient_features(df_raw)

    # Ensure all trained feature columns are present
    for col in feature_cols:
        if col not in df_features.columns:
            df_features[col] = np.nan

    # Evaluate the latest hour
    latest_row = df_features[feature_cols].iloc[[-1]].to_numpy()
    risk_proba = float(clf.predict_proba(latest_row)[0, 1])

    # Calibrated risk bands
    if risk_proba < 0.35:
        band = "low"
    elif risk_proba < 0.65:
        band = "medium"
    else:
        band = "high"

    top_factors = extract_top_factors(df_features)

    return {
        "risk": round(risk_proba, 4),
        "band": band,
        "top_factors": top_factors,
        "model": MODEL_ID,
    }
