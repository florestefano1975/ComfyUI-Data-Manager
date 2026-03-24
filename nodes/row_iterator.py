"""
RowIteratorNode
===============
Iterates over rows from a DataManagerNode dataset.

Correct connection:
    [Data Manager].dataset  →  [Row Iterator].dataset

Modes:
  "manual" — emits the row indicated by row_index (static)
  "auto"   — advances one row per execution (batch processing)

Outputs:
  row_data      (DM_ROW)   — current row as a typed dictionary
  current_index (INT)      — 0-based index of the current row
  is_last       (BOOLEAN)  — True if this is the last row
  progress      (STRING)   — e.g. "3 / 10"
"""

from __future__ import annotations

from typing import Any

# In-memory state for auto mode (persists for the server session)
_iterator_state: dict[str, int] = {}


def _cast(v: Any, t: str) -> Any:
    """Type-casts a raw value according to the column type."""
    if v is None or v == "":
        return None
    try:
        if t == "int":   return int(float(str(v)))
        if t == "float": return float(str(v))
        if t == "image":
            # Preserve dict {filename, subfolder, type} as-is
            if isinstance(v, dict):
                return v
            # JSON string → deserialize
            if isinstance(v, str) and v.strip().startswith("{"):
                import json as _json, ast as _ast
                try:    return _json.loads(v)
                except: pass
                try:    return _ast.literal_eval(v)
                except: pass
            return v
    except (ValueError, TypeError):
        pass
    return str(v)


def _apply_schema(row: dict, schema: list[dict]) -> dict:
    """Returns a row with keys = label and typed values."""
    out = {}
    for col in schema:
        cid   = col["id"]
        label = col["label"]
        ctype = col["type"]
        raw   = row.get(cid, row.get(label))
        out[label] = _cast(raw, ctype)
    return out


class RowIteratorNode:

    CATEGORY = "Data Manager"
    FUNCTION = "execute"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Receives the full dataset from the DataManagerNode "dataset" output
                "dataset": ("DM_DATASET", {}),
                "iterate_mode": (["auto", "manual"], {"default": "auto"}),
                "row_index": ("INT", {"default": 0, "min": 0, "max": 9999, "step": 1}),
                "reset": ("BOOLEAN", {"default": False}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES  = ("DM_ROW", "INT",           "BOOLEAN", "STRING")
    RETURN_NAMES  = ("row_data","current_index", "is_last", "progress")

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        if kwargs.get("iterate_mode") == "auto":
            import time
            return time.time()
        return 0.0

    def execute(
        self,
        dataset:      dict,
        iterate_mode: str,
        row_index:    int,
        reset:        bool,
        unique_id:    str = "",
    ) -> tuple:

        schema = dataset.get("schema", [])
        rows   = dataset.get("rows",   [])
        total  = len(rows)

        if total == 0:
            return ({}, 0, True, "0 / 0")

        if iterate_mode == "manual":
            idx = max(0, min(row_index, total - 1))
        else:  # auto
            if reset or unique_id not in _iterator_state:
                _iterator_state[unique_id] = 0
            idx = _iterator_state[unique_id]
            _iterator_state[unique_id] = (idx + 1) % total

        row_data = _apply_schema(rows[idx], schema)
        is_last  = (idx == total - 1)
        progress = f"{idx + 1} / {total}"

        return (row_data, idx, is_last, progress)

    @classmethod
    def reset_iterator(cls, unique_id: str) -> None:
        _iterator_state[unique_id] = 0
