"""
Column Extractor Nodes
======================
Nodi companion che estraggono un singolo valore da un DM_ROW
prodotto da DataManagerNode.
"""

from __future__ import annotations

import os
from typing import Any

import numpy as np


# ---------------------------------------------------------------------------
# Helper: estrazione valore
# ---------------------------------------------------------------------------

def _get_value(row_data: dict, column_name: str) -> Any:
    """Extracts a value from the row. Case-insensitive."""
    if column_name in row_data:
        return row_data[column_name]
    lower = column_name.lower()
    for k, v in row_data.items():
        if k.lower() == lower:
            return v
    return None


# ---------------------------------------------------------------------------
# Helper: risoluzione path immagine
# ---------------------------------------------------------------------------

def _get_input_dir() -> str:
    """
    Restituisce la cartella input di ComfyUI nel modo più affidabile possibile.
    Uses folder_paths (ComfyUI internal module) if available,
    otherwise falls back by walking up from this file's location.
    """
    try:
        import folder_paths
        return folder_paths.get_input_directory()
    except Exception:
        pass
    # Fallback: ComfyUI/custom_nodes/<pack>/nodes/this_file.py
    # → risaliamo 3 livelli per arrivare alla root di ComfyUI
    this_dir    = os.path.dirname(os.path.abspath(__file__))
    comfyui_dir = os.path.dirname(os.path.dirname(os.path.dirname(this_dir)))
    return os.path.join(comfyui_dir, "input")


def _resolve_image_path(val: Any) -> str | None:
    """
    Risolve il valore di una cella immagine in un path assoluto su disco.

    Accetta:
      - dict { "filename": "...", "subfolder": "...", "type": "input" }  (formato nuovo)
      - str JSON  '{"filename": "..."}' (stringa serializzata)
      - str repr  "{'filename': '...'}" (repr Python — caso legacy/bug)
      - str path  "/assoluto/o/relativo.png"

    Cerca nella cartella input di ComfyUI tramite folder_paths.
    """
    if not val:
        return None

    # Normalize: if it is a string representing a dict, convert it
    if isinstance(val, str):
        s = val.strip()
        # Try JSON
        if s.startswith("{"):
            import json as _json
            try:
                val = _json.loads(s)
            except Exception:
                # Try ast.literal_eval for Python repr format
                import ast as _ast
                try:
                    val = _ast.literal_eval(s)
                except Exception:
                    pass

    filename: str = ""
    subfolder: str = ""

    if isinstance(val, dict):
        filename  = val.get("filename") or ""
        subfolder = val.get("subfolder") or ""
    elif isinstance(val, str):
        if os.path.isfile(val):
            return os.path.abspath(val)
        filename  = os.path.basename(val)
        subfolder = ""

    if not filename:
        return None

    input_dir = _get_input_dir()

    # Candidates in priority order
    candidates = []
    if subfolder:
        candidates.append(os.path.join(input_dir, subfolder, filename))
    candidates.append(os.path.join(input_dir, filename))

    for c in candidates:
        if os.path.isfile(c):
            print(f"[DataManager] Image resolved: {c}")
            return c

    print(f"[DataManager] WARN: image not found: '{filename}' in '{input_dir}'")
    return None


# ---------------------------------------------------------------------------
# Helper: caricamento tensore
# ---------------------------------------------------------------------------

def _empty_image_tensor():
    """
    Restituisce un tensore immagine placeholder 64x64 nero.
    Usato quando il file non esiste, per evitare None che causa crash downstream.
    """
    import torch
    blank = np.zeros((64, 64, 3), dtype=np.float32)
    mask  = np.ones( (64, 64),    dtype=np.float32)
    return torch.from_numpy(blank)[None, ...], torch.from_numpy(mask)[None, ...]


def _load_image_tensor(path: str):
    """
    Carica un'immagine da disco e la converte in tensore ComfyUI [1,H,W,3] float32.
    Restituisce sempre (tensor, mask) — mai (None, None).
    """
    import torch
    from PIL import Image, ImageOps

    if not path or not os.path.isfile(path):
        print(f"[DataManager] File not found for loading: '{path}'")
        return _empty_image_tensor()

    try:
        img = Image.open(path)
        img = ImageOps.exif_transpose(img)   # correct EXIF orientation
        img = img.convert("RGBA")

        arr  = np.array(img).astype(np.float32) / 255.0
        rgb  = arr[:, :, :3]
        mask = 1.0 - arr[:, :, 3]           # alpha → mask (0 = opaque)

        tensor = torch.from_numpy(np.ascontiguousarray(rgb))[None, ...]
        mask_t = torch.from_numpy(np.ascontiguousarray(mask))[None, ...]
        return tensor, mask_t

    except Exception as exc:
        print(f"[DataManager] Error loading image '{path}': {exc}")
        return _empty_image_tensor()


# ---------------------------------------------------------------------------
# Nodo generico (debug)
# ---------------------------------------------------------------------------

class ColumnExtractorNode:
    """Extracts any value as a string. Useful for debugging."""
    CATEGORY = "Data Manager/Extractors"
    FUNCTION = "extract"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "row_data":    ("DM_ROW", {}),
            "column_name": ("STRING", {"default": ""}),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("value",)

    def extract(self, row_data: dict, column_name: str) -> tuple:
        v = _get_value(row_data, column_name)
        return (str(v) if v is not None else "",)


# ---------------------------------------------------------------------------
# Extractor tipizzati
# ---------------------------------------------------------------------------

class ExtractStringNode:
    CATEGORY = "Data Manager/Extractors"
    FUNCTION = "extract"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "row_data":    ("DM_ROW", {}),
            "column_name": ("STRING", {"default": ""}),
        }, "optional": {
            "fallback": ("STRING", {"default": ""}),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("value",)

    def extract(self, row_data: dict, column_name: str, fallback: str = "") -> tuple:
        v = _get_value(row_data, column_name)
        return (str(v) if v is not None else fallback,)


class ExtractIntNode:
    CATEGORY = "Data Manager/Extractors"
    FUNCTION = "extract"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "row_data":    ("DM_ROW", {}),
            "column_name": ("STRING", {"default": ""}),
        }, "optional": {
            "fallback": ("INT", {"default": 0}),
        }}

    RETURN_TYPES = ("INT",)
    RETURN_NAMES = ("value",)

    def extract(self, row_data: dict, column_name: str, fallback: int = 0) -> tuple:
        v = _get_value(row_data, column_name)
        if v is None:
            return (fallback,)
        try:
            return (int(float(str(v))),)
        except (ValueError, TypeError):
            return (fallback,)


class ExtractFloatNode:
    CATEGORY = "Data Manager/Extractors"
    FUNCTION = "extract"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "row_data":    ("DM_ROW", {}),
            "column_name": ("STRING", {"default": ""}),
        }, "optional": {
            "fallback": ("FLOAT", {"default": 0.0}),
        }}

    RETURN_TYPES = ("FLOAT",)
    RETURN_NAMES = ("value",)

    def extract(self, row_data: dict, column_name: str, fallback: float = 0.0) -> tuple:
        v = _get_value(row_data, column_name)
        if v is None:
            return (fallback,)
        try:
            return (float(str(v)),)
        except (ValueError, TypeError):
            return (fallback,)


class ExtractImagePathNode:
    """
    Estrae una colonna immagine: emette path (STRING), tensore IMAGE e MASK.
    Non restituisce mai None — in assenza di file emette un placeholder 64x64 nero.
    """
    CATEGORY = "Data Manager/Extractors"
    FUNCTION = "extract"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "row_data":    ("DM_ROW", {}),
            "column_name": ("STRING", {"default": ""}),
        }, "optional": {
            "load_image": ("BOOLEAN", {"default": True}),
        }}

    RETURN_TYPES = ("STRING", "IMAGE", "MASK")
    RETURN_NAMES = ("path",   "image", "mask")

    def extract(self, row_data: dict, column_name: str, load_image: bool = True) -> tuple:
        raw  = _get_value(row_data, column_name)
        path = _resolve_image_path(raw) or ""

        if load_image:
            # _load_image_tensor ALWAYS returns a valid tensor (never None)
            tensor, mask = _load_image_tensor(path)
            return (path, tensor, mask)

        # load_image=False: returns a placeholder to avoid breaking downstream nodes
        tensor, mask = _empty_image_tensor()
        return (path, tensor, mask)


def _load_audio_tensor(path: str):
    """
    Loads an audio file from disk and returns a ComfyUI AUDIO dict:
      { "waveform": Tensor[1, C, S] float32, "sample_rate": int }

    Compatible with PreviewAudio, SaveAudio and other standard audio nodes.
    Uses torchaudio (bundled with ComfyUI) with soundfile as fallback.
    Returns a silent 1-sample placeholder if the file cannot be loaded.
    """
    import torch

    def _silent(sr: int = 44100):
        return {"waveform": torch.zeros(1, 1, 1), "sample_rate": sr}

    if not path or not os.path.isfile(path):
        print(f"[DataManager] Audio file not found: '{path}'")
        return _silent()

    # Try torchaudio first (always available in ComfyUI)
    try:
        import torchaudio
        waveform, sample_rate = torchaudio.load(path)
        # waveform shape from torchaudio: [C, S] → we need [1, C, S]
        return {"waveform": waveform.unsqueeze(0), "sample_rate": sample_rate}
    except Exception as e:
        print(f"[DataManager] torchaudio failed for '{path}': {e}")

    # Fallback: soundfile
    try:
        import soundfile as sf
        import numpy as np
        data, sample_rate = sf.read(path, dtype="float32", always_2d=True)
        # data shape: [S, C] → convert to [1, C, S]
        waveform = torch.from_numpy(data.T).unsqueeze(0)
        return {"waveform": waveform, "sample_rate": sample_rate}
    except Exception as e:
        print(f"[DataManager] soundfile failed for '{path}': {e}")

    return _silent()


class ExtractAudioPathNode:
    """
    Extracts an audio column.
    Emits the resolved file path (STRING) and a ComfyUI AUDIO tensor
    compatible with PreviewAudio, SaveAudio and other standard audio nodes.
    """
    CATEGORY = "Data Manager/Extractors"
    FUNCTION = "extract"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "row_data":    ("DM_ROW", {}),
            "column_name": ("STRING", {"default": ""}),
        }, "optional": {
            "load_audio": ("BOOLEAN", {"default": True}),
        }}

    RETURN_TYPES = ("STRING", "AUDIO")
    RETURN_NAMES = ("path",   "audio")

    def extract(self, row_data: dict, column_name: str, load_audio: bool = True) -> tuple:
        raw  = _get_value(row_data, column_name)
        path = _resolve_image_path(raw) or ""

        if load_audio:
            audio = _load_audio_tensor(path)
        else:
            import torch
            audio = {"waveform": torch.zeros(1, 1, 1), "sample_rate": 44100}

        return (path, audio)
