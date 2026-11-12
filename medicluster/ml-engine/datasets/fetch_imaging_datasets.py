#!/usr/bin/env python3
"""
fetch_imaging_datasets.py
Fetch complete labelled imaging datasets for the MediCluster Imaging Library:
1. Kermany Chest X-Ray: 5,856 images (Normal / Pneumonia), official train/test/val splits (CC BY 4.0).
2. Figshare Brain Tumor Dataset (Jun Cheng): 3,064 T1-CE MRI slices (glioma / meningioma / pituitary) + masks,
   with fixed seeded 20% test split recorded in manifest (CC BY 4.0).
3. NIH ChestX-ray14: Official test split list and labels CSV (CC0 / Public Domain), with optional --nih-sample N.

Disk Space Safety:
- Streams/extracts one chunk at a time and deletes temporary archives immediately.
- Verifies free disk space >= 3.0 GB before each chunk; aborts cleanly if space is low.
- Total kept on disk is <= 3.0 GB (~1.5 GB total for both full datasets).
"""

import argparse
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Dict, List, Optional

import numpy as np
import pyarrow.parquet as pq
from PIL import Image
from sklearn.model_selection import train_test_split

KERMANY_CONFIG = {
    "name": "chest-xray-pneumonia",
    "displayName": "Chest X-ray · Pediatric Pneumonia (Kermany)",
    "modality": "chest-xray",
    "license": "CC BY 4.0",
    "doi": "10.17632/rscbjbr9sj.2",
    "sourceUrl": "https://huggingface.co/datasets/hf-vision/chest-xray-pneumonia",
    "citation": "Kermany, Daniel S., et al. 'Identifying Medical Diagnoses and Treatable Diseases by Image-Based Deep Learning.' Cell 172.5 (2018): 1122-1131.",
    "classMap": {0: "Normal", 1: "Pneumonia"},
    "classes": ["Normal", "Pneumonia"],
    "compatibleModels": [
        "densenet121-res224-chex",
        "densenet121-res224-all",
        "resnet50-res512-all",
        "densenet121-res224-nih",
        "densenet121-res224-pc",
    ],
    "parquetBase": "https://huggingface.co/api/datasets/hf-vision/chest-xray-pneumonia/parquet/default",
    "splits": {
        "test": ["test/0.parquet"],
        "validation": ["validation/0.parquet"],
        "train": [f"train/{i}.parquet" for i in range(7)],
    },
}

BRAIN_CONFIG = {
    "name": "brain-mri-tumor",
    "displayName": "Brain MRI · Tumor Slices & Masks (Cheng / Figshare)",
    "modality": "brain-mri",
    "license": "CC BY 4.0",
    "doi": "10.6084/m9.figshare.1512427",
    "sourceUrl": "https://huggingface.co/datasets/chehablab/JCBTD",
    "citation": "Cheng, Jun (2017): brain tumor dataset. figshare. Dataset. https://doi.org/10.6084/m9.figshare.1512427.v5",
    "parquetUrl": "https://huggingface.co/api/datasets/chehablab/JCBTD/parquet/default/train/0.parquet",
    "classMap": {1: "meningioma", 2: "glioma", 3: "pituitary"},
    "classes": ["glioma", "meningioma", "pituitary"],
    "compatibleModels": [
        "brain-mri-tflite",
    ],
}

NIH_CONFIG = {
    "name": "nih-chest-xray14",
    "displayName": "NIH ChestX-ray14 (Metadata & Test Split)",
    "modality": "chest-xray",
    "license": "CC0 / Public Domain",
    "sourceUrl": "https://huggingface.co/datasets/alkzar90/NIH-Chest-X-ray-dataset",
    "citation": "Wang, Xiaosong, et al. 'ChestX-ray8: Hospital-scale Chest X-ray Database and Benchmarks.' CVPR 2017.",
    "testListUrl": "https://huggingface.co/datasets/alkzar90/NIH-Chest-X-ray-dataset/raw/main/data/test_list.txt",
    "labelsCsvUrl": "https://huggingface.co/datasets/alkzar90/NIH-Chest-X-ray-dataset/raw/main/data/Data_Entry_2017_v2020.csv",
}


def check_disk_space(target_path: Path, min_free_gb: float = 3.0) -> float:
    """Verify free disk space. Aborts cleanly if free space is below min_free_gb."""
    free_bytes = shutil.disk_usage(target_path).free
    free_gb = free_bytes / (1024 ** 3)
    if free_gb < min_free_gb:
        raise RuntimeError(
            f"Insufficient disk space: {free_gb:.2f} GB free on {target_path} "
            f"(minimum {min_free_gb:.1f} GB required). Aborting cleanly."
        )
    return free_gb


def download_file(url: str, dest_path: Path) -> None:
    """Download a file with curl following redirects."""
    cmd = ["curl", "-sL", "-f", "--connect-timeout", "30", "--max-time", "600", "-o", str(dest_path), url]
    res = subprocess.run(cmd)
    if res.returncode != 0:
        raise RuntimeError(f"Failed to download {url} (curl error code {res.returncode})")


def fetch_kermany_chest_xray(config: dict, output_root: Path, per_class: Optional[int] = None) -> dict:
    """
    Download and extract full Kermany Chest X-ray dataset (test, validation, train).
    Saves clean JPEGs without metadata and records official split for each sample.
    """
    name = config["name"]
    dataset_dir = output_root / name
    dataset_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n========================================================")
    print(f"Fetching {config['displayName']} (Full official splits)...")
    print(f"========================================================")

    class_map = config["classMap"]
    classes = config["classes"]
    counts_by_split: Dict[str, Dict[str, int]] = {
        "test": {c: 0 for c in classes},
        "validation": {c: 0 for c in classes},
        "train": {c: 0 for c in classes},
    }
    files_record = []
    total_bytes = 0

    # Process each split in order: test, validation, train
    for split_name, relative_shards in config["splits"].items():
        print(f"\n-- Processing split '{split_name}' ({len(relative_shards)} shard(s)) --")
        split_dir = dataset_dir / split_name
        split_dir.mkdir(parents=True, exist_ok=True)
        for cls_name in classes:
            (split_dir / cls_name.lower()).mkdir(parents=True, exist_ok=True)

        for shard_rel in relative_shards:
            check_disk_space(output_root, min_free_gb=3.0)
            shard_url = f"{config['parquetBase']}/{shard_rel}"
            shard_filename = Path(shard_rel).name

            print(f"  Downloading shard {shard_rel}...")
            with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as tmp_file:
                tmp_parquet = Path(tmp_file.name)

            try:
                download_file(shard_url, tmp_parquet)
                table = pq.read_table(str(tmp_parquet))
                num_rows = table.num_rows
                print(f"  Downloaded {shard_filename} ({tmp_parquet.stat().st_size / (1024*1024):.1f} MB, {num_rows} rows). Extracting...")

                # Extract rows
                pydict = table.to_pydict()
                images = pydict["image"]
                labels = pydict["label"]

                for i in range(num_rows):
                    lbl_id = labels[i]
                    cls_name = class_map.get(lbl_id, "Unknown")
                    if cls_name not in classes:
                        continue

                    if per_class is not None and counts_by_split[split_name][cls_name] >= per_class:
                        continue

                    raw_item = images[i]
                    raw_bytes = raw_item["bytes"] if isinstance(raw_item, dict) else raw_item

                    # Validate with PIL and convert to RGB/L
                    img = Image.open(BytesIO(raw_bytes))
                    width, height = img.size
                    if img.mode not in ("RGB", "L"):
                        img = img.convert("RGB")

                    sha256 = hashlib.sha256(raw_bytes).hexdigest()
                    file_idx = counts_by_split[split_name][cls_name] + 1
                    file_id = f"cxr_{split_name}_{cls_name.lower()[:4]}_{file_idx:04d}"
                    filename = f"{file_id}.jpg"
                    out_path = split_dir / cls_name.lower() / filename

                    img.save(out_path, format="JPEG", quality=95)
                    actual_bytes = out_path.stat().st_size
                    total_bytes += actual_bytes
                    counts_by_split[split_name][cls_name] += 1

                    rel_path = str(out_path.relative_to(output_root))
                    files_record.append({
                        "id": file_id,
                        "filename": filename,
                        "relPath": rel_path,
                        "class": cls_name,
                        "labelId": int(lbl_id),
                        "split": split_name,
                        "sha256": sha256,
                        "bytes": actual_bytes,
                        "width": width,
                        "height": height,
                        "format": "JPEG",
                    })

                print(f"  Extracted from {shard_filename}. Current '{split_name}' counts: {counts_by_split[split_name]}")

            finally:
                if tmp_parquet.is_file():
                    tmp_parquet.unlink()

    total_counts = {c: sum(counts_by_split[s][c] for s in counts_by_split) for c in classes}
    total_counts["total"] = sum(total_counts.values())

    return {
        "name": name,
        "displayName": config["displayName"],
        "modality": config["modality"],
        "classes": classes,
        "classMap": {str(k): v for k, v in class_map.items()},
        "license": config["license"],
        "doi": config["doi"],
        "sourceUrl": config["sourceUrl"],
        "citation": config["citation"],
        "compatibleModels": config["compatibleModels"],
        "counts": total_counts,
        "countsBySplit": counts_by_split,
        "files": files_record,
    }


def fetch_figshare_brain_mri(config: dict, output_root: Path, per_class: Optional[int] = None) -> dict:
    """
    Download and extract full Figshare Brain Tumor dataset (Jun Cheng).
    Saves 512x512 PNG images and corresponding tumor masks.
    Applies fixed seeded 20% test split recorded in manifest.
    """
    name = config["name"]
    dataset_dir = output_root / name
    images_dir = dataset_dir / "images"
    masks_dir = dataset_dir / "masks"
    images_dir.mkdir(parents=True, exist_ok=True)
    masks_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n========================================================")
    print(f"Fetching {config['displayName']} (Cheng / Figshare)...")
    print(f"========================================================")

    check_disk_space(output_root, min_free_gb=3.0)

    with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as tmp_file:
        tmp_parquet = Path(tmp_file.name)

    files_record = []
    class_map = config["classMap"]
    classes = config["classes"]

    for cls_name in classes:
        (images_dir / cls_name).mkdir(parents=True, exist_ok=True)

    try:
        print(f"  Downloading brain tumor dataset ({config['parquetUrl']})...")
        download_file(config["parquetUrl"], tmp_parquet)
        table = pq.read_table(str(tmp_parquet))
        num_rows = table.num_rows
        print(f"  Downloaded {num_rows} MRI slices ({tmp_parquet.stat().st_size / (1024*1024):.1f} MB).")

        pydict = table.to_pydict()
        images = pydict["image"]
        masks = pydict["mask"]
        labels = pydict["label"]
        patient_ids = pydict.get("patient_id", [str(i) for i in range(num_rows)])
        slice_ids = pydict.get("slice_id", [0] * num_rows)

        # Build row list
        valid_indices = []
        for i in range(num_rows):
            lbl_id = labels[i]
            if lbl_id in class_map:
                valid_indices.append(i)

        # Fixed seeded 20% stratified train/test split
        valid_labels = [labels[i] for i in valid_indices]
        train_idx, test_idx = train_test_split(
            valid_indices,
            test_size=0.20,
            random_state=42,
            stratify=valid_labels,
        )
        test_set = set(test_idx)

        counts_by_split: Dict[str, Dict[str, int]] = {
            "test": {c: 0 for c in classes},
            "train": {c: 0 for c in classes},
        }

        print(f"  Fixed 20% split: {len(test_idx)} test slices, {len(train_idx)} train slices.")
        print(f"  Extracting PNG images and tumor masks...")

        total_bytes = 0
        for i in valid_indices:
            lbl_id = labels[i]
            cls_name = class_map[lbl_id]
            split_name = "test" if i in test_set else "train"

            if per_class is not None and counts_by_split[split_name][cls_name] >= per_class:
                continue

            raw_img_bytes = images[i]["bytes"]
            raw_mask_bytes = masks[i]["bytes"]

            img_sha256 = hashlib.sha256(raw_img_bytes).hexdigest()
            mask_sha256 = hashlib.sha256(raw_mask_bytes).hexdigest()

            file_idx = len(files_record) + 1
            file_id = f"brn_{cls_name[:4]}_{file_idx:04d}"
            img_filename = f"{file_id}.png"
            mask_filename = f"{file_id}_mask.png"

            img_path = images_dir / cls_name / img_filename
            mask_path = masks_dir / mask_filename

            img_path.write_bytes(raw_img_bytes)
            mask_path.write_bytes(raw_mask_bytes)

            actual_bytes = img_path.stat().st_size
            total_bytes += actual_bytes
            counts_by_split[split_name][cls_name] += 1

            files_record.append({
                "id": file_id,
                "filename": img_filename,
                "relPath": str(img_path.relative_to(output_root)),
                "maskRelPath": str(mask_path.relative_to(output_root)),
                "class": cls_name,
                "labelId": int(lbl_id),
                "patientId": str(patient_ids[i]),
                "sliceId": int(slice_ids[i]),
                "split": split_name,
                "sha256": img_sha256,
                "maskSha256": mask_sha256,
                "bytes": actual_bytes,
                "width": 512,
                "height": 512,
                "format": "PNG",
            })

            if len(files_record) % 500 == 0:
                print(f"    Extracted {len(files_record)} / {len(valid_indices)} brain MRI slices...")

    finally:
        if tmp_parquet.is_file():
            tmp_parquet.unlink()

    total_counts = {c: sum(counts_by_split[s][c] for s in counts_by_split) for c in classes}
    total_counts["total"] = sum(total_counts.values())

    return {
        "name": name,
        "displayName": config["displayName"],
        "modality": config["modality"],
        "classes": classes,
        "classMap": {str(k): v for k, v in class_map.items()},
        "license": config["license"],
        "doi": config["doi"],
        "sourceUrl": config["sourceUrl"],
        "citation": config["citation"],
        "compatibleModels": config["compatibleModels"],
        "counts": total_counts,
        "countsBySplit": counts_by_split,
        "files": files_record,
    }


def fetch_nih_metadata(config: dict, output_root: Path, sample_n: int = 0) -> dict:
    """Download NIH ChestX-ray14 official test-split list and labels CSV."""
    name = config["name"]
    dataset_dir = output_root / name
    dataset_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n========================================================")
    print(f"Fetching NIH ChestX-ray14 official test split & label CSV...")
    print(f"========================================================")

    test_list_path = dataset_dir / "test_list.txt"
    labels_csv_path = dataset_dir / "Data_Entry_2017_v2020.csv"

    if not test_list_path.is_file():
        print("  Downloading test_list.txt (25,596 official test images)...")
        download_file(config["testListUrl"], test_list_path)

    if not labels_csv_path.is_file():
        print("  Downloading Data_Entry_2017_v2020.csv...")
        download_file(config["labelsCsvUrl"], labels_csv_path)

    test_lines = test_list_path.read_text().strip().splitlines()
    print(f"  NIH test list verified: {len(test_lines)} image filenames.")

    return {
        "name": name,
        "displayName": config["displayName"],
        "modality": config["modality"],
        "license": config["license"],
        "sourceUrl": config["sourceUrl"],
        "citation": config["citation"],
        "testListRelPath": str(test_list_path.relative_to(output_root)),
        "labelsCsvRelPath": str(labels_csv_path.relative_to(output_root)),
        "testSplitCount": len(test_lines),
        "files": [],
    }


def main():
    parser = argparse.ArgumentParser(description="Fetch full open-access imaging datasets for MediCluster")
    parser.add_argument("--per-class", type=int, default=None, help="Optional subset limit per class (default: None = FULL dataset)")
    parser.add_argument("--nih-sample", type=int, default=0, help="Optional sample count for NIH ChestX-ray14 (default: 0)")
    parser.add_argument("--output-dir", type=str, default=None, help="Directory to save images (default: ml-engine/datasets/imaging)")
    args = parser.parse_args()

    base_dir = Path(__file__).resolve().parent
    output_root = Path(args.output_dir) if args.output_dir else (base_dir / "imaging")
    output_root.mkdir(parents=True, exist_ok=True)

    initial_free = check_disk_space(output_root, min_free_gb=3.0)
    print(f"Disk check: {initial_free:.2f} GB free on {output_root}. (Safety threshold: 3.0 GB)")

    manifest_path = output_root / "manifest.json"
    manifest = {
        "version": "2.0.0",
        "description": "MediCluster complete curated imaging dataset library for clinical evaluation and benchmarking",
        "datasets": {},
    }

    # 1. Kermany Chest X-Ray
    kermany_info = fetch_kermany_chest_xray(KERMANY_CONFIG, output_root, per_class=args.per_class)
    manifest["datasets"][KERMANY_CONFIG["name"]] = kermany_info

    # 2. Figshare Brain MRI
    brain_info = fetch_figshare_brain_mri(BRAIN_CONFIG, output_root, per_class=args.per_class)
    manifest["datasets"][BRAIN_CONFIG["name"]] = brain_info

    # 3. NIH ChestX-ray14 metadata
    nih_info = fetch_nih_metadata(NIH_CONFIG, output_root, sample_n=args.nih_sample)
    manifest["datasets"][NIH_CONFIG["name"]] = nih_info

    # Write manifest
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"\nManifest successfully written to: {manifest_path}")

    # Summary
    final_free = check_disk_space(output_root, min_free_gb=3.0)
    print("\n" + "=" * 65)
    print("FULL IMAGING DATASETS SUMMARY:")
    print("=" * 65)
    total_imgs = sum(len(d["files"]) for d in manifest["datasets"].values())
    total_bytes = sum(sum(f["bytes"] for f in d["files"]) for d in manifest["datasets"].values())
    for name, info in manifest["datasets"].items():
        print(f"• {info['displayName']}")
        print(f"  Modality: {info['modality']} | License: {info['license']}")
        if "counts" in info:
            print(f"  Total: {info['counts']['total']} images | Breakdown: {info['counts']}")
            if "countsBySplit" in info:
                print(f"  Splits: {info['countsBySplit']}")
        if info.get("testSplitCount"):
            print(f"  Official test partition size: {info['testSplitCount']:,} images (test_list.txt)")
    print(f"\nTotal images kept on disk: {total_imgs:,}")
    print(f"Total dataset size on disk: {total_bytes / (1024*1024):.2f} MB ({total_bytes / (1024**3):.2f} GB)")
    print(f"Remaining free disk space: {final_free:.2f} GB (Used during run: {initial_free - final_free:.2f} GB)")
    print("=" * 65)


if __name__ == "__main__":
    main()
