"""
DataManagerNode
===============
Main node. Manages column schema and data rows.

Python (backend) responsibilities:
  - Receive JSON payload from the frontend widget (grid)
  - Validate and type-cast cell values
  - Emit the selected row as a typed DICT
  - Sync data to an external JSON/CSV file
  - Provide template presets
"""

from __future__ import annotations

import csv
import json
import os
import time
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Costanti
# ---------------------------------------------------------------------------

# Supported column types
COLUMN_TYPES = ["string", "int", "float", "image", "audio"]

# Built-in template presets
PRESETS: dict[str, list[dict]] = {
    "Storyboard": [
        {"id": "col_scene",    "label": "Scene",       "type": "string"},
        {"id": "col_prompt",   "label": "Prompt",      "type": "string"},
        {"id": "col_neg",      "label": "Negative",    "type": "string"},
        {"id": "col_seed",     "label": "Seed",        "type": "int"},
        {"id": "col_steps",    "label": "Steps",       "type": "int"},
        {"id": "col_cfg",      "label": "CFG",         "type": "float"},
        {"id": "col_ref",      "label": "Reference",   "type": "image"},
    ],
    "Character Sheet": [
        {"id": "col_name",     "label": "Name",        "type": "string"},
        {"id": "col_desc",     "label": "Description", "type": "string"},
        {"id": "col_prompt",   "label": "Prompt",      "type": "string"},
        {"id": "col_age",      "label": "Age",         "type": "int"},
        {"id": "col_portrait", "label": "Portrait",    "type": "image"},
    ],
    "Dataset Builder": [
        {"id": "col_caption",  "label": "Caption",     "type": "string"},
        {"id": "col_tags",     "label": "Tags",        "type": "string"},
        {"id": "col_weight",   "label": "Weight",      "type": "float"},
        {"id": "col_image",    "label": "Image",       "type": "image"},
    ],
    "Empty": [],
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cast_value(value: Any, col_type: str) -> Any:
    """Casts a raw value to the correct column type."""
    if value is None or value == "":
        return None
    try:
        if col_type == "int":
            return int(float(str(value)))
        if col_type == "float":
            return float(str(value))
        if col_type == "string":
            return str(value)
        if col_type in ("image", "audio"):
            # Both image and audio store a dict {filename, subfolder, type}.
            # Must NOT be cast to string — preserve it as a dict.
            if isinstance(value, dict):
                return value
            if isinstance(value, str):
                # Might be serialized JSON: try to deserialize
                try:
                    import json as _json
                    parsed = _json.loads(value)
                    if isinstance(parsed, dict) and "filename" in parsed:
                        return parsed
                except Exception:
                    pass
                return value  # fallback: raw string (legacy path)
    except (ValueError, TypeError):
        pass
    return value


def _validate_payload(payload: dict) -> tuple[bool, str]:
    """Checks that the payload has the expected structure."""
    if not isinstance(payload, dict):
        return False, "payload non è un dizionario"
    if "schema" not in payload or not isinstance(payload["schema"], list):
        return False, "campo 'schema' mancante o non valido"
    if "rows" not in payload or not isinstance(payload["rows"], list):
        return False, "campo 'rows' mancante o non valido"
    for col in payload["schema"]:
        if "id" not in col or "label" not in col or "type" not in col:
            return False, f"malformed column: {col}"
        if col["type"] not in COLUMN_TYPES:
            return False, f"invalid column type: {col['type']}"
    return True, ""


def _apply_schema_to_row(row: dict, schema: list[dict]) -> dict:
    """Type-casts all values in a row according to the schema."""
    typed: dict = {}
    for col in schema:
        cid   = col["id"]
        label = col["label"]
        ctype = col["type"]
        raw   = row.get(cid, row.get(label))  # supports both id and label as key
        typed[label] = _cast_value(raw, ctype)
    return typed


# ---------------------------------------------------------------------------
# Sync helpers
# ---------------------------------------------------------------------------

def _ensure_data_dir(file_path: str) -> Path:
    p = Path(file_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _save_json(payload: dict, file_path: str) -> None:
    p = _ensure_data_dir(file_path)
    tmp = p.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    tmp.replace(p)  # scrittura atomica


def _load_json(file_path: str) -> dict | None:
    p = Path(file_path)
    if not p.exists():
        return None
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_csv(payload: dict, file_path: str) -> None:
    """Esporta le righe come CSV usando le label come intestazioni."""
    schema = payload.get("schema", [])
    rows   = payload.get("rows", [])
    if not schema:
        return
    headers = [col["label"] for col in schema]
    col_ids = [col["id"]    for col in schema]
    col_types = {col["id"]: col["type"] for col in schema}
    p = _ensure_data_dir(file_path)
    with open(p, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for row in rows:
            out = {}
            for cid, label in zip(col_ids, headers):
                out[label] = _cast_value(row.get(cid, ""), col_types[cid]) or ""
            writer.writerow(out)


def _load_csv(file_path: str, schema: list[dict]) -> list[dict] | None:
    """Importa un CSV e lo converte in lista di righe indicizzate per col id."""
    p = Path(file_path)
    if not p.exists():
        return None
    label_to_id = {col["label"]: col["id"] for col in schema}
    rows = []
    with open(p, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for csv_row in reader:
            row: dict = {}
            for label, value in csv_row.items():
                cid = label_to_id.get(label)
                if cid:
                    row[cid] = value
            rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# Nodo principale
# ---------------------------------------------------------------------------

class DataManagerNode:
    """
    ComfyUI node that exposes an interactive grid for managing structured data.

    The JS frontend writes/updates the `grid_data` field (serialized JSON)
    containing schema + rows. The Python backend deserializes, validates,
    syncs to disk, and returns the selected row as a typed DICT.
    """

    # ── ComfyUI metadata ──────────────────────────────────────────────────────

    CATEGORY    = "Data Manager"
    FUNCTION    = "execute"
    OUTPUT_NODE = False

    # ── Inputs/Outputs ──────────────────────────────────────────────────────────

    @classmethod
    def INPUT_TYPES(cls) -> dict:
        return {
            "required": {
                # JSON payload serialized by the JS widget (schema + rows + meta)
                "grid_data": ("STRING", {
                    "default":   json.dumps({
                        "schema": [],
                        "rows":   [],
                        "meta":   {"name": "Untitled", "file_path": ""}
                    }),
                    "multiline": False,
                }),
                # Index of the row to emit (0-based)
                "row_index": ("INT", {
                    "default": 0,
                    "min":     0,
                    "max":     9999,
                    "step":    1,
                }),
            },
            "optional": {
                # If provided, forces a reload from the external file before execution
                "force_reload": ("BOOLEAN", {"default": False}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES  = ("DM_ROW", "INT",        "DM_SCHEMA",     "DM_DATASET",)
    RETURN_NAMES  = ("row_data","total_rows","column_schema", "dataset",)

    # ── Execution ────────────────────────────────────────────────────────────

    def execute(
        self,
        grid_data:    str,
        row_index:    int,
        force_reload: bool = False,
        unique_id:    str  = "",
    ) -> tuple:

        # 1. Deserialize payload from widget
        try:
            payload = json.loads(grid_data)
        except json.JSONDecodeError as e:
            raise ValueError(f"[DataManager] grid_data JSON invalid: {e}") from e

        # 2. Validate structure
        ok, err = _validate_payload(payload)
        if not ok:
            raise ValueError(f"[DataManager] invalid payload: {err}")

        schema    = payload["schema"]
        rows      = payload["rows"]
        meta      = payload.get("meta", {})
        file_path = meta.get("file_path", "").strip()

        # 3. Sync: if force_reload and file_path are set, reload from file
        if force_reload and file_path:
            ext = Path(file_path).suffix.lower()
            if ext == ".csv":
                loaded_rows = _load_csv(file_path, schema)
                if loaded_rows is not None:
                    rows = loaded_rows
                    payload["rows"] = rows
            else:
                loaded = _load_json(file_path)
                if loaded:
                    payload = loaded
                    schema  = payload.get("schema", schema)
                    rows    = payload.get("rows",   rows)

        # 4. Save to external file if file_path is set
        if file_path:
            ext = Path(file_path).suffix.lower()
            try:
                if ext == ".csv":
                    _save_csv(payload, file_path)
                else:
                    # default .json (even if the extension differs)
                    json_path = str(Path(file_path).with_suffix(".json"))
                    _save_json(payload, json_path)
                    # also save a CSV alongside for convenience
                    csv_path = str(Path(file_path).with_suffix(".csv"))
                    _save_csv(payload, csv_path)
            except Exception as exc:
                print(f"[DataManager] WARNING: file sync failed: {exc}")

        # 5. Select the requested row
        total_rows = len(rows)
        if total_rows == 0:
            row_data = {}
        else:
            idx      = max(0, min(row_index, total_rows - 1))
            row_data = _apply_schema_to_row(rows[idx], schema)

        # 6. Simplified schema for extractors
        column_schema = {col["label"]: col["type"] for col in schema}

        # 7. Full dataset (schema + raw rows) for the Row Iterator
        dataset = {"schema": schema, "rows": rows}

        return (row_data, total_rows, column_schema, dataset)

    # ── Extra API exposed to the JS frontend via /dm/ route ───────────────────────

    @classmethod
    def get_presets(cls) -> dict:
        """Returns the built-in presets (called by the frontend)."""
        return PRESETS

    @classmethod
    def import_csv(cls, file_path: str, current_schema: list[dict]) -> list[dict]:
        """Imports rows from an external CSV."""
        rows = _load_csv(file_path, current_schema)
        return rows or []

    @classmethod
    def export_csv(cls, payload: dict, file_path: str) -> bool:
        """Exports the entire dataset to CSV."""
        try:
            _save_csv(payload, file_path)
            return True
        except Exception as exc:
            print(f"[DataManager] export_csv error: {exc}")
            return False
