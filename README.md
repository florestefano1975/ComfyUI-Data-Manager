# 📊 ComfyUI Data Manager

A custom node pack for ComfyUI that adds an **interactive Excel-like grid**
directly inside your workflows — ideal for storyboards, character sheets, dataset builders and more.

---

## 📦 Installation

```bash
# From ComfyUI's custom_nodes folder
cd ComfyUI/custom_nodes
git clone <repo-url> comfyui-data-manager
# or copy the folder manually
```

Restart ComfyUI. The nodes will appear under the **Data Manager** category.

---

## 🧩 Available Nodes

### 📊 Data Manager  _(main node)_

The central node with the interactive grid.

**Grid interactions:**
| Action | How |
|---|---|
| Add column | `+ Col` button in the toolbar |
| Add row | `+ Row` button in the toolbar |
| Edit column | Click on the column header → opens edit dialog |
| Delete column | Click the `×` button on the right side of the header |
| Edit cell | Click on a cell → edit dialog |
| Delete row | `×` button on the right of the row |
| Apply preset | `📋 Preset` button |
| Import CSV | `⬆ CSV` button |
| Export CSV | `⬇ CSV` button |

**Column types:**
| Type | Color | Description |
|---|---|---|
| `string` | 🔵 blue | Free text |
| `int` | 🟠 orange | Integer number |
| `float` | 🟢 green | Decimal number |
| `image` | 🟣 purple | File path + inline thumbnail |

**Inputs:**
- `row_index` — index of the row to emit (0-based)
- `force_reload` _(optional)_ — reload data from external file

**Outputs:**
- `row_data` → `DM_ROW` — dictionary of the selected row
- `total_rows` → `INT` — total number of rows
- `column_schema` → `DM_SCHEMA` — map `{label: type}`
- `dataset` → `DM_DATASET` — full dataset (schema + raw rows), connect to Row Iterator

**Bidirectional sync:**
Set `file_path` in the node metadata to enable automatic sync to disk.
The node saves both `.json` and `.csv` on every execution.

---

### 🔍 Column Extractor  _(generic)_

Extracts any column as a string. Useful for quick debugging.

```
row_data + column_name → value (STRING)
```

---

### 🔤 Extract String / 🔢 Extract Int / 🔣 Extract Float

Typed extractors. Include a `fallback` value if the cell is empty.

```
row_data + column_name + fallback → value (STRING|INT|FLOAT)
```

---

### 🖼️ Extract Image Path

Extracts an image column. Loads the file from disk and converts it
to a ComfyUI tensor ready for the pipeline.

```
row_data + column_name + load_image → path (STRING) + image (IMAGE) + mask (MASK)
```

---

### 🔄 Row Iterator

Iterates over all rows in the dataset.

**Connection:** `Data Manager.dataset` → `Row Iterator.dataset`

**Mode `manual`** — emits the row indicated by `row_index`.

**Mode `auto`** — advances one row per execution.
Use it with repeated _Queue Prompt_ to automatically process
the entire dataset in batch.

**Outputs:**
- `row_data` — current row dictionary
- `current_index` — 0-based index
- `is_last` — `True` if this is the last row
- `progress` — string `"3 / 10"` for display

---

## 🎬 Example: Storyboard workflow

```
[Data Manager]
  ├── Preset: Storyboard
  │   Columns: Scene | Prompt | Negative | Seed | Steps | CFG | Reference
  │
  ├── dataset ──────────────→ [Row Iterator] (batch mode)
  │
  └── row_data ─────────────→ [Extract String: "Prompt"]   → [CLIP Text Encode]
                            → [Extract String: "Negative"] → [CLIP Text Encode (neg)]
                            → [Extract Int:   "Seed"]      → [KSampler seed]
                            → [Extract Int:   "Steps"]     → [KSampler steps]
                            → [Extract Float: "CFG"]       → [KSampler cfg]
                            → [Extract Image: "Reference"] → [Load Image / IP-Adapter]
```

Enter scenes in the grid, change `row_index` to switch scenes.
Use the **Row Iterator** in `auto` mode to generate all scenes in batch.

---

## 📁 File structure

```
comfyui-data-manager/
├── __init__.py
├── nodes/
│   ├── __init__.py
│   ├── data_manager.py      # Main node + CSV/JSON sync
│   ├── column_extractor.py  # Typed extractors
│   └── row_iterator.py      # Batch iterator
└── web/
    └── js/
        └── data_manager.js  # LiteGraph grid widget (frontend)
```

---

## 💾 Internal data format (JSON)

```json
{
  "schema": [
    {"id": "col_abc123", "label": "Prompt", "type": "string"},
    {"id": "col_def456", "label": "Seed",   "type": "int"}
  ],
  "rows": [
    {"col_abc123": "A dark forest...", "col_def456": 42},
    {"col_abc123": "A bright meadow", "col_def456": 99}
  ],
  "meta": {
    "name": "MyStoryboard",
    "file_path": "data/mystoryboard.json"
  }
}
```

---

## ⚠️ Notes

- The `image` type uses paths relative to the ComfyUI `input/` folder.
- Thumbnails are loaded via the ComfyUI server (the file must be accessible).
- In `auto` mode the Row Iterator uses `IS_CHANGED` to force re-execution — make sure you have a stop condition (e.g. check `is_last`).
- The JSON payload is stored in the workflow itself: data travels with the `.json` workflow file.

---

## 🛠️ Requirements

- ComfyUI (recent version with custom widget support)
- Python 3.10+
- `Pillow` (for image loading in extractors)
- `torch` (already included in ComfyUI)
