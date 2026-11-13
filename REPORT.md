# Selective Prediction & Out-of-Distribution Gating for Chest Radiography (imgacc)

## 1. Executive Summary

This report documents the implementation and evaluation of **Selective Prediction** (uncertain abstention / referral to radiologist) and **Out-of-Distribution (OOD) Gating** for the chest radiography pipeline in MediCluster.

All evaluations are conducted strictly on the **official Kermany test set** consisting of **624 images** (234 Normal, 390 Pneumonia).

### Core Performance Comparison (Official Kermany Test)

| Method | Coverage | Answered (n) | Referred | Accuracy | Macro F1 | AUROC |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Off-the-Shelf DenseNet121** (default uncalibrated threshold 0.15) | 100.0% | 624 | 0 | 62.50% | 0.3846 | 0.7712 |
| **Calibrated Logistic Probe** (all images, threshold 0.4738) | 100.0% | 624 | 0 | 84.13% | 0.8107 | 0.9579 |
| **Selective Probe (Operating Point)** (10% train refer, $\delta=2.6952$) | **82.85%** | **517** | **107** | **91.68%** | **0.8823** | **0.9455** |

> **Methodological Rigor**: Decision thresholds and uncertainty abstention bands were fitted **strictly on the 5,216 Kermany TRAIN split images** using frozen DenseNet121 features. Zero test images were discarded to artificially inflate performance; all 624 test images are accounted for via rigorous risk-coverage metrics.

---

## 2. Selective Risk-Coverage Tradeoff Curve

When deploying AI in safety-critical clinical environments, abstaining on uncertain samples and referring them to a human specialist dramatically reduces diagnostic risk.

The abstention decision is defined by:
$$\text{keep} = \left| \text{logit}(p) - \text{logit}(\tau) \right| > \delta$$
where $\tau = 0.4738$ is the calibrated operating threshold and $\delta$ is the distance quantile chosen on the train set.

### Official Test Set Risk-Coverage Table

| Target Refer % | Coverage (%) | Answered ($n$) | Referred | Accuracy (%) | Macro F1 | AUROC |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **0% (All images)** | 100.0% | 624 | 0 | 84.13% | 0.8107 | 0.9579 |
| **5%** | 91.03% | 568 | 56 | 87.68% | 0.8408 | 0.9536 |
| **10% (Standard Operating Point)** | **82.85%** | **517** | **107** | **91.68%** | **0.8823** | **0.9455** |
| **20%** | 70.35% | 439 | 185 | 94.76% | 0.9157 | 0.9437 |
| **30%** | 62.34% | 389 | 235 | 95.37% | 0.9189 | 0.9472 |

At the chosen 10% train referral operating point:
- **517 images** are confidently classified with **91.68% accuracy** and **0.8823 Macro F1**.
- **107 images** are safely referred to the radiologist with status `"uncertain"`.

---

## 3. Out-of-Distribution (OOD) Gate

The OOD gate prevents false inferences on invalid inputs (blank files, clinical color photos, brain MRI slices) prior to running deep diagnostic classification.

### Architecture & Training
1. **Pixel-Level Validation**:
   - Blank / solid field detection: $\sigma_{\text{pixel}} < 5.0$.
   - Color photo detection: $\text{mean}(|R - G| + |G - B|) > 8.0$.
2. **Feature-Space Density Gate**:
   - Fitted a 32-cluster `MiniBatchKMeans` estimator on frozen DenseNet121 `features2` embeddings across all 5,216 Kermany TRAIN chest X-rays.
   - Set the acceptance threshold at $3.891$ ($1.25 \times 99.5\text{th}$ percentile of train minimum centroid distances).

### Empirical Validation
- **Kermany Test Chest X-rays**: **100.0% pass rate** (624 / 624 images accepted).
- **Blank / Uniform Images**: **100.0% reject rate**.
- **Natural / Color Photographs**: **100.0% reject rate**.
- **Brain MRI Scans**: **89.5% rejected** on raw feature centroid distance alone, and **100% rejected** when combined with multimodal validation.
- **Contract Output**:
  ```json
  {
    "status": "out_of_distribution",
    "prediction_label": "Not a chest X-ray — cannot analyze",
    "findings": [],
    "confidence": 0.0
  }
  ```

---

## 4. Full-Stack Product Wiring

1. **`ml-engine` (`analyzer.py`, `service.py`)**:
   - `analyze_image` gates inputs via `check_chest_ood()`.
   - Uses calibrated logistic probe `models_store/kermany_probe.joblib` when present.
   - Emits structured response: `{ status: "ok" | "uncertain" | "out_of_distribution", threshold, confidence, findings }`.
   - Dataset samples endpoint supports query parameters `identifiable` and `referred`, returning counts `identifiableCount: 517` and `referredCount: 107`.
   - Dataset benchmark endpoint evaluates full dataset and returns both 100% coverage baseline and selective risk-coverage curves.

2. **`backend` (`mediaRoutes.js`)**:
   - Persists `status`, `threshold`, `confidence`, and `message` in `media.analysis`.
   - Forwards query parameters `identifiable` and `referred` on `/api/media/datasets/:name/samples`.

3. **`agent-core` (`loop.ts`, `tests/loop.test.ts`)**:
   - Workflow rules strictly enforce that analyses with `status === "uncertain"` or `status === "out_of_distribution"` trigger `action = "request_review"` with `actNow = 1` and **never create an abnormal clinical alert**.

4. **`frontend` (`imagingModels.js`, `ImagingPage.jsx`, `ImagingDatasets.jsx`)**:
   - `imagingSummary` formats `uncertain` analyses as `"Uncertain — refer to radiologist"` and `out_of_distribution` as `"Not a chest X-ray — cannot analyze"`, applying the calibrated threshold.
   - `ImagingDatasets.jsx`:
     - Sample explorer displays identifiable images by default with a toggle: `"Show images the model refers (107)"`.
     - Benchmark view renders summary cards and the full risk-coverage tradeoff table across all target referral operating points.
   - `ImagingPage.jsx`: Displays dedicated status notices explaining abstentions and OOD rejections.

---

## 5. Verification & Test Suite Status

All unit, integration, and contract tests across the workspace pass cleanly:

| Test Suite | Framework | Status | Tests |
| :--- | :---: | :---: | :---: |
| `medicluster/ml-engine/tests` | Pytest | **PASS** | 43 / 43 |
| `medicluster/frontend/tests` | Node Test Runner | **PASS** | 70 / 70 |
| `medicluster/backend/tests` | Node Test Runner | **PASS** | 318 / 318 |
| `agent-core/tests` | Vitest | **PASS** | 380 / 380 |
| `frontend` Production Build | Vite 5 | **PASS** | Built in 7.68s |
