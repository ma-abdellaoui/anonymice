"""Where the engine sits inside its repository, for the budget gates.

Upstream the engine was the repository root. Here it is a subdirectory, so a gate
scanning a base worktree at its top level finds no source, measures zero
violations, and blames every inherited one on the change under test.
"""

import subprocess
from pathlib import Path
from typing import Final

DEFAULT_BASE: Final = "origin/main"


def engine_prefix(repo_root: Path) -> Path:
    """`repo_root` relative to the git root, so a base worktree can be scanned at the same depth."""
    top: Final = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    return repo_root.resolve().relative_to(Path(top).resolve())


def base_engine_root(worktree: Path, repo_root: Path) -> Path:
    """The directory inside a base worktree that corresponds to `repo_root`."""
    return worktree / engine_prefix(repo_root)
