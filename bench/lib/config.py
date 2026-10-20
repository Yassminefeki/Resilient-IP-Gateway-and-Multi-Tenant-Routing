"""
bench.lib.config — Loads bench/config.yaml with environment variable interpolation.
"""

import os
import re
import yaml
from pathlib import Path
from typing import Any, Dict

ENV_PATTERN = re.compile(r"\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}")

def expand_env(value: Any) -> Any:
    if isinstance(value, str):
        def replace(match):
            var_name = match.group(1)
            default_val = match.group(2) if match.group(2) is not None else ""
            return os.getenv(var_name, default_val)
        return ENV_PATTERN.sub(replace, value)
    elif isinstance(value, dict):
        return {k: expand_env(v) for k, v in value.items()}
    elif isinstance(value, list):
        return [expand_env(item) for item in value]
    return value

def load_config(config_path: str = None) -> Dict[str, Any]:
    if config_path is None:
        root_dir = Path(__file__).resolve().parent.parent.parent
        config_path = root_dir / "bench" / "config.yaml"
    else:
        config_path = Path(config_path)

    if not config_path.is_file():
        raise FileNotFoundError(f"Benchmark configuration not found at {config_path}")

    with open(config_path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    return expand_env(raw)
