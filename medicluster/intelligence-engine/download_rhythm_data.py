#!/usr/bin/env python3
"""Download CUDB and VFDB datasets from PhysioNet S3 mirror."""
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor

CUDB_RECORDS = [f"cu{i:02d}" for i in range(1, 36)]
VFDB_RECORDS = [
    "418", "419", "420", "421", "422", "423", "424", "425", "426", "427", "428", "429", "430",
    "602", "605", "607", "609", "610", "611", "612", "614", "615"
]

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")

def download_file(db_name, rec, ext):
    target_dir = os.path.join(DATA_DIR, db_name)
    os.makedirs(target_dir, exist_ok=True)
    target_path = os.path.join(target_dir, f"{rec}.{ext}")
    if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
        return True
    url = f"https://physionet-open.s3.amazonaws.com/{db_name}/1.0.0/{rec}.{ext}"
    res = subprocess.run(["curl", "-sL", "--fail", "--max-time", "30", "-o", target_path, url])
    return res.returncode == 0

def main():
    tasks = []
    for rec in CUDB_RECORDS:
        for ext in ["hea", "dat", "atr"]:
            tasks.append(("cudb", rec, ext))
    for rec in VFDB_RECORDS:
        for ext in ["hea", "dat", "atr"]:
            tasks.append(("vfdb", rec, ext))

    print(f"Downloading {len(tasks)} files for CUDB and VFDB...")
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(lambda t: download_file(*t), tasks))
    print(f"Downloaded {sum(results)} / {len(tasks)} files successfully.")

if __name__ == "__main__":
    main()
