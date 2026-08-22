"""Where the engine sits inside its repository, for the budget gates.

Upstream the engine was the repository root, so a gate could scan a base worktree
at its top level. Here the engine is a subdirectory of a larger repo, and scanning
the worktree root finds no source at all: the base measures zero violations and
every inherited violation in the tree is blamed on the change under test. Each
gate therefore scans `<worktree>/<engine_prefix()>` rather than `<worktree>`.
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
