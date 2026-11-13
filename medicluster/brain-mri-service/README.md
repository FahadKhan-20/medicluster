# Brain MRI service (port 8001)

Serves the Brain_health_monitor MobileNetV2 TFLite tumor classifier (imported by CORTIA,
`models/mri/brain_tumor_model.tflite`) behind the API MediCluster's `BRAIN_MRI_URL` adapter expects
(`POST /api/predict`, multipart `file`).

Run:
```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
cp -r /path/to/cortia/models/mri models/mri   # model files are not in git
.venv/bin/python benchmark.py   # trains probe_figshare.joblib
.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8001
```

## Accuracy — Figshare brain tumor dataset (Cheng, CC BY 4.0), stratified 80/20 split, seed 1337, 613 test slices

| Method | Answered | Accuracy | Macro F1 |
|---|---|---|---|
| Original TFLite model | 100% | 65.9% | 0.650 |
| Probe on the model's features, trained on TRAIN only | 100% | 94.1% | 0.936 |
| Probe, refer 10% least-confident (cut-off from TRAIN) | 93.2% | 96.7% | 0.963 |
| Live service (original no-tumor gate + probe) | 100% | 86.3% | 0.895 |

Figshare has no healthy scans: tumor type is validated, the "no tumor" decision is not (it comes
from the original model, and wrongly fires on 51 of 613 tumor slices). Uncertain tumor-type calls are
flagged `uncertain: true`. Research support only, not a diagnostic device.
