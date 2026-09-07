#!/usr/bin/env python3
"""Static contract for the production shell clock during print preview."""
from pathlib import Path
import sys


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: print_preview_stability_contract.py <shell-chunk.js>")
    source = Path(sys.argv[1]).read_text(encoding="utf-8")
    required = (
        'window.addEventListener("beforeprint"',
        'window.addEventListener("afterprint"',
        'window.matchMedia("print")',
        'clearInterval',
    )
    missing = [item for item in required if item not in source]
    assert not missing, f"print-stability contract missing: {missing}"
    assert 'setInterval(() => s(/* @__PURE__ */ new Date()), 1e3)' in source, "clock update behavior was unexpectedly removed"
    print("PASS: shell clock pauses for print and resumes after print")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
