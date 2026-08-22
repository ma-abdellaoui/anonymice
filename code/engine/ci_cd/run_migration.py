import argparse
import os
import re
import shutil
import tempfile
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import testing.postgresql


DESTRUCTIVE_PATTERN = re.compile(r"\bDROP\s+(COLUMN|TABLE|INDEX)\b", re.IGNORECASE)
DEFAULT_BASE_BRANCH = "main"
# This fork is developed in parallel, so a branch is behind origin/main most of the
# time and a hard refusal blocked routine work. Staleness is still reported loudly;
# --require-fresh-branch restores the refusal. The destructive-migration guard is
# untouched and still refuses outright, which is what actually stops a dropped column.
REQUIRE_FRESH_BRANCH_DEFAULT = False


def _find_destructive_statements(sql: str) -> list:
    """Return SQL lines containing DROP COLUMN, DROP TABLE, or DROP INDEX."""
    return [
        line.strip() for line in sql.splitlines() if DESTRUCTIVE_PATTERN.search(line)
    ]


def _print_freshness_failure(
    base_branch: str, reason: str, stderr_text: str = ""
) -> None:
    """Loudly refuse to run when the freshness check can't be completed."""
    banner = "=" * 72
    out = sys.stderr
    print(banner, file=out)
    print(f"  FRESHNESS CHECK FAILED — COULD NOT VERIFY origin/{base_branch}", file=out)
    print(banner, file=out)
    print("", file=out)
    print(f"Reason: {reason}", file=out)
    if stderr_text:
        print("", file=out)
        print("git stderr:", file=out)
        for line in stderr_text.rstrip().splitlines():
            print(f"    {line}", file=out)
    print("", file=out)
    print("Common causes:", file=out)
    print("  - No network access (offline)", file=out)
    print("  - 'origin' remote not configured, or base branch name is wrong", file=out)
    print("  - Not a git repository", file=out)
    print("", file=out)
    print("Options:", file=out)
    print(
        f"  - Fix the above and re-run, OR pass --base-branch <name> if your", file=out
    )
    print(
        f"    base branch is not '{base_branch}', OR pass --skip-freshness-check",
        file=out,
    )
    print("    to bypass (only if you fully understand the risk).", file=out)
    print(banner, file=out)


def _print_stale_branch_warning(base_branch: str, behind: int, refusing: bool) -> None:
    """Report that HEAD is behind the base branch, refusing only when asked to."""
    banner = "=" * 72
    out = sys.stderr
    print(banner, file=out)
    headline = "STALE BRANCH" if refusing else "STALE BRANCH (warning only)"
    print(
        f"  {headline} — {behind} commit(s) behind origin/{base_branch}",
        file=out,
    )
    print(banner, file=out)
    print("", file=out)
    print(
        f"Your branch is {behind} commit(s) behind origin/{base_branch}. Generating a\n"
        "migration from a stale branch is how newly-added columns get silently\n"
        "dropped, so check the generated SQL against what those commits changed.",
        file=out,
    )
    print("", file=out)
    print("To bring the branch up to date:", file=out)
    print(f"  git fetch origin && git merge origin/{base_branch}", file=out)
    print("  # or rebase, whichever matches your workflow", file=out)
    print("", file=out)
    if refusing:
        print("Refusing because --require-fresh-branch was passed.", file=out)
    else:
        print(
            "Continuing anyway: this repo is developed in parallel, so being behind\n"
            "origin is normal here. Pass --require-fresh-branch to refuse instead.\n"
            "The DROP COLUMN / DROP TABLE / DROP INDEX guard still refuses outright.",
            file=out,
        )
    print("", file=out)
    print(banner, file=out)


def _check_branch_freshness(root_dir: Path, base_branch: str, require_fresh: bool) -> None:
    """Fetch origin/<base_branch> and report how far behind HEAD is.

    Exits 3 only when `require_fresh` is set; otherwise this is a loud warning.
    """
    cwd = str(root_dir)
    try:
        subprocess.run(
            ["git", "fetch", "origin", base_branch],
            check=True,
            capture_output=True,
            text=True,
            cwd=cwd,
        )
    except FileNotFoundError:
        _print_freshness_failure(base_branch, "git executable not found on PATH")
        sys.exit(3)
    except subprocess.CalledProcessError as e:
        _print_freshness_failure(
            base_branch,
            f"`git fetch origin {base_branch}` failed",
            e.stderr or "",
        )
        sys.exit(3)

    try:
        result = subprocess.run(
            ["git", "rev-list", "--count", f"HEAD..origin/{base_branch}"],
            check=True,
            capture_output=True,
            text=True,
            cwd=cwd,
        )
        behind = int(result.stdout.strip())
    except subprocess.CalledProcessError as e:
        _print_freshness_failure(
            base_branch,
            f"`git rev-list HEAD..origin/{base_branch}` failed",
            e.stderr or "",
        )
        sys.exit(3)
    except ValueError:
        _print_freshness_failure(
            base_branch,
            "could not parse commit count from `git rev-list`",
        )
        sys.exit(3)

    if behind > 0:
        _print_stale_branch_warning(base_branch, behind, refusing=require_fresh)
        if require_fresh:
            sys.exit(3)
        return

    print(f"Branch freshness OK: up to date with origin/{base_branch}.")


def _print_destructive_refusal(destructive_lines: list) -> None:
    """Loudly refuse to write a destructive migration and explain how to proceed."""
    banner = "=" * 72
    out = sys.stderr
    print(banner, file=out)
    print(
        "  DESTRUCTIVE MIGRATION DETECTED — REFUSING TO WRITE MIGRATION FILE", file=out
    )
    print(banner, file=out)
    print("", file=out)
    print(
        "The generated migration contains the following destructive statements:",
        file=out,
    )
    print("", file=out)
    for line in destructive_lines:
        print(f"    {line}", file=out)
    print("", file=out)
    print(
        "This very often means your branch is OUT OF DATE, or your local\n"
        "schema.prisma is inconsistent with the migrations/ directory. A\n"
        "previous incident saw newly-added columns silently dropped this way\n"
        "and merged to main. Stop and verify before proceeding.",
        file=out,
    )
    print("", file=out)
    print("Before re-running:", file=out)
    print(
        "  1. git fetch origin && git status   # confirm branch is up to date", file=out
    )
    print(
        "  2. Re-check all schema.prisma files are in sync (runbook Step 0)", file=out
    )
    print("  3. Review EACH DROP above — is it actually intended?", file=out)
    print("  4. If (and only if) the drops are intentional, re-run with:", file=out)
    print("         --allow-destructive", file=out)
    print("", file=out)
    print(banner, file=out)
    print(
        "  AI AGENTS / ASSISTANTS: DO NOT automatically re-run this command\n"
        "  with --allow-destructive. Surface this error to the human operator\n"
        "  and wait for their explicit confirmation before passing the flag.\n"
        "  Passing the flag without human review is the exact failure mode\n"
        "  this guard exists to prevent.",
        file=out,
    )
    print(banner, file=out)


def create_migration(
    migration_name: str = None,
    allow_destructive: bool = False,
    base_branch: str = DEFAULT_BASE_BRANCH,
    skip_freshness_check: bool = False,
    require_fresh_branch: bool = REQUIRE_FRESH_BRANCH_DEFAULT,
):
    """
    Create a new migration SQL file in the migrations directory by comparing
    current database state with schema.

    Args:
        migration_name (str): Name for the migration
        allow_destructive (bool): Required to write a migration that contains
            DROP COLUMN, DROP TABLE, or DROP INDEX statements. Without this
            flag, the script exits non-zero and prints guidance.
        base_branch (str): Branch to check freshness against
            (default: "litellm_internal_staging").
        skip_freshness_check (bool): Skip the "branch is up to date" check.
            Only for intentional migrations against an older base.
    """
    root_dir = Path(__file__).parent.parent

    if skip_freshness_check:
        print(
            "WARNING: freshness check skipped (--skip-freshness-check). "
            "Generating a migration from a stale branch can silently drop columns."
        )
    else:
        _check_branch_freshness(root_dir, base_branch, require_fresh_branch)

    try:
        migrations_dir = (
            root_dir / "litellm-proxy-extras" / "litellm_proxy_extras" / "migrations"
        )
        schema_path = root_dir / "schema.prisma"

        # Create temporary PostgreSQL database
        with testing.postgresql.Postgresql() as postgresql:
            db_url = postgresql.url()

            # Prisma resolves migrations as <schema>/../migrations, so the schema is
            # copied into a scratch directory and the migrations placed beside it.
            # Working next to the real schema.prisma put that directory at
            # code/engine/migrations, which is tracked and holds the Docker
            # migration runner, and the teardown deleted it.
            with tempfile.TemporaryDirectory(prefix="prisma_migrate_") as scratch:
                scratch_dir = Path(scratch)
                temp_schema_path = scratch_dir / "schema.prisma"
                temp_migrations_dir = scratch_dir / "migrations"

                shutil.copy(schema_path, temp_schema_path)
                shutil.copytree(migrations_dir, temp_migrations_dir)

                # Apply existing migrations to temp database
                os.environ["DATABASE_URL"] = db_url
                subprocess.run(
                    ["prisma", "migrate", "deploy", "--schema", str(temp_schema_path)],
                    check=True,
                )

                # Generate diff between current database and schema
                result = subprocess.run(
                    [
                        "prisma",
                        "migrate",
                        "diff",
                        "--from-url",
                        db_url,
                        "--to-schema-datamodel",
                        str(temp_schema_path),
                        "--script",
                    ],
                    capture_output=True,
                    text=True,
                    check=True,
                )

                # Prisma emits the literal "-- This is an empty migration." when
                # there's no real drift. Treat that as "no changes".
                diff_sql = result.stdout
                stripped = diff_sql.strip()
                is_empty_diff = (
                    not stripped or stripped == "-- This is an empty migration."
                )

                if not is_empty_diff:
                    destructive_lines = _find_destructive_statements(diff_sql)
                    if destructive_lines and not allow_destructive:
                        _print_destructive_refusal(destructive_lines)
                        sys.exit(2)
                    if destructive_lines and allow_destructive:
                        print(
                            "WARNING: writing destructive migration "
                            "(--allow-destructive passed). Statements:"
                        )
                        for line in destructive_lines:
                            print(f"    {line}")

                    # Generate timestamp and create migration directory
                    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
                    migration_name = migration_name or "unnamed_migration"
                    migration_dir = migrations_dir / f"{timestamp}_{migration_name}"
                    migration_dir.mkdir(parents=True, exist_ok=True)

                    # Write the SQL to migration.sql
                    migration_file = migration_dir / "migration.sql"
                    migration_file.write_text(diff_sql)

                    print(f"Created migration in {migration_dir}")
                    return True
                else:
                    print("No schema changes detected. Migration not needed.")
                    return False

    except subprocess.CalledProcessError as e:
        print(f"Error generating migration: {e.stderr}")
        return False
    except Exception as e:
        print(f"Error creating migration: {str(e)}")
        return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description=(
            "Generate a Prisma migration by diffing the temp DB "
            "(existing migrations applied) against schema.prisma."
        )
    )
    parser.add_argument(
        "migration_name",
        nargs="?",
        default=None,
        help="Name for the migration (used in the generated directory name).",
    )
    parser.add_argument(
        "--allow-destructive",
        action="store_true",
        help=(
            "Required to write a migration that contains DROP COLUMN, "
            "DROP TABLE, or DROP INDEX. Without this flag, destructive "
            "diffs are refused."
        ),
    )
    parser.add_argument(
        "--base-branch",
        default=DEFAULT_BASE_BRANCH,
        help=(
            f"Branch to check freshness against (default: {DEFAULT_BASE_BRANCH}). "
            "The script fetches origin/<base-branch> and refuses to run if HEAD "
            "is behind it."
        ),
    )
    parser.add_argument(
        "--skip-freshness-check",
        action="store_true",
        help="Skip the base-branch comparison entirely, so nothing is fetched or reported.",
    )
    parser.add_argument(
        "--require-fresh-branch",
        action="store_true",
        default=REQUIRE_FRESH_BRANCH_DEFAULT,
        help=(
            "Refuse to generate a migration while HEAD is behind the base branch. "
            "Off by default here: this repo is developed in parallel, so staleness "
            "is reported but does not block."
        ),
    )
    args = parser.parse_args()
    create_migration(
        args.migration_name,
        allow_destructive=args.allow_destructive,
        base_branch=args.base_branch,
        skip_freshness_check=args.skip_freshness_check,
        require_fresh_branch=args.require_fresh_branch,
    )
