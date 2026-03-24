"""
ComfyUI Data Manager
====================
Custom node pack providing an interactive Excel-like grid
for managing structured data inside ComfyUI workflows.

Included nodes:
  - DataManagerNode      : main grid with column schema + rows
  - ColumnExtractorNode  : extracts a single typed value from a row
  - RowIteratorNode      : iterates over all rows for batch processing
"""

from .nodes.data_manager import DataManagerNode
from .nodes.column_extractor import (
    ColumnExtractorNode,
    ExtractStringNode,
    ExtractIntNode,
    ExtractFloatNode,
    ExtractImagePathNode,
)
from .nodes.row_iterator import RowIteratorNode

# ── Custom API route: list images in the input folder ──────────────────────
# Exposes GET /dm/list_inputs → JSON array of filenames
# Used by the frontend as a reliable fallback over /object_info/LoadImage
try:
    from pathlib import Path
    from aiohttp import web

    async def _list_input_images(request):
        """Returns the list of image files in the ComfyUI input folder."""
        IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"}
        try:
            import folder_paths  # modulo interno di ComfyUI
            input_dir = Path(folder_paths.get_input_directory())
        except ImportError:
            this_dir  = Path(__file__).parent
            input_dir = this_dir.parent.parent / "input"

        results = []
        if input_dir.exists():
            for f in sorted(input_dir.rglob("*")):
                if f.suffix.lower() in IMAGE_EXTS and f.is_file():
                    rel = f.relative_to(input_dir)
                    results.append(str(rel).replace("\\", "/"))

        return web.json_response(results)

    from server import PromptServer
    PromptServer.instance.app.router.add_get("/dm/list_inputs", _list_input_images)

except Exception as _e:
    print(f"[DataManager] WARNING: could not register route /dm/list_inputs: {_e}")

# ── Class name → Python class mapping ──────────────────────────────────────
NODE_CLASS_MAPPINGS = {
    "DataManagerNode":      DataManagerNode,
    "ColumnExtractorNode":  ColumnExtractorNode,
    "ExtractStringNode":    ExtractStringNode,
    "ExtractIntNode":       ExtractIntNode,
    "ExtractFloatNode":     ExtractFloatNode,
    "ExtractImagePathNode": ExtractImagePathNode,
    "RowIteratorNode":      RowIteratorNode,
}

# ── Human-readable names shown in ComfyUI UI ────────────────────────────────
NODE_DISPLAY_NAME_MAPPINGS = {
    "DataManagerNode":      "📊 Data Manager",
    "ColumnExtractorNode":  "🔍 Column Extractor",
    "ExtractStringNode":    "🔤 Extract String",
    "ExtractIntNode":       "🔢 Extract Int",
    "ExtractFloatNode":     "🔣 Extract Float",
    "ExtractImagePathNode": "🖼️ Extract Image Path",
    "RowIteratorNode":      "🔄 Row Iterator",
}

# ── JS folder for frontend (grid widget) ───────────────────────────────
WEB_DIRECTORY = "./web/js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
