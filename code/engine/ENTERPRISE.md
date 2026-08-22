# The enterprise directory has been removed

Upstream LiteLLM ships an `enterprise/` directory holding the `litellm-enterprise`
package. It is the one part of LiteLLM that is **not** MIT: it carries the BerriAI
Enterprise License, which permits production use only under a BerriAI subscription.

We removed it. This file records what went and how to re-apply the removal after
re-vendoring a newer upstream, which will bring the directory back.

## Why

**Licensing.** This repository is MIT. Carrying a proprietary directory inside it made
the licence of the whole tree conditional and put code in our image that we are not
licensed to run in production.

**We were not using it.** Nearly every feature in the package is gated at runtime behind
`premium_user`, a licence validated against `license.litellm.ai`. `LITELLM_LICENSE` is
set nowhere in this repository, so project management, enterprise vector stores and the
rest already answered with *"… is an enterprise feature"*.

`code/engine/LICENSE` needs no edit: its enterprise clause reads *"if that directory
exists"*, so with the directory gone everything in this tree is MIT.

## What was removed

| Path | Contents |
|---|---|
| `enterprise/` | The `litellm_enterprise` package — 149 Python files, 4.6 MB |
| `litellm/proxy/enterprise` | A symlink to `../../enterprise`, dangling once the target is gone |
| `tests/enterprise/`, `tests/test_litellm/enterprise/` | 30 test files covering only that package |
| 4 further test files | `test_llm_guard.py`, `test_secret_detect_hook.py`, `test_pagerduty_alerting.py`, `test_proxy_reject_logging.py` — each imports `litellm_enterprise` at module level, so they fail at collection rather than skip |

Configuration, in the same commit:

| File | Change |
|---|---|
| `pyproject.toml` | Dropped `litellm-enterprise==0.1.58` from the `proxy` extra, the `[tool.uv.sources]` workspace entry, the `enterprise` workspace member, and the two maturin excludes for the symlink |
| `Dockerfile` | Dropped `COPY enterprise/pyproject.toml` in the builder and `COPY --from=builder /app/enterprise` in the runtime stage |
| `migrations/Dockerfile` | Dropped the bind mount of `enterprise/pyproject.toml` |
| `Makefile` | Dropped `tests/test_litellm/enterprise` from the unit-test target |
| `codecov.yaml` | Dropped the now-dangling `enterprise/**` path |
| `uv.lock` | Regenerated — `litellm-enterprise` removed |

`docker/build_admin_ui.sh` still tests for `enterprise/enterprise_ui/enterprise_colors.json`
and skips when it is absent. That was already the branch taken, so it is left alone.

## What this costs

The import in `proxy_server.py` that pulls the enterprise routes is wrapped in
`try: … except ImportError`, so the proxy starts and serves normally without the package.
Gone with it:

| Feature | Note |
|---|---|
| `GET /audit`, `GET /audit/{id}` | **The only real loss.** Audit entries are still *written* — every writer lives in the MIT core (`litellm/proxy/management_helpers/audit_logs.py` and the key/user management hooks). Only the read API and its Admin-UI page are gone; the rows are in Postgres and remain queryable by SQL |
| Email events | Invitation and key-created mails over SMTP / Resend / SendGrid |
| Project management, tags | Licence-gated, already unavailable |
| Enterprise vector store endpoints | Licence-gated |
| Llama Guard, LLM Guard, secret detection, PagerDuty callbacks | Only active when configured; none is |
| One core test | `test_proxy_reject_logging.py` asserted that rejected requests are logged as failures, using the enterprise secret-detection hook as the rejecting guardrail. It cannot run without the package, so it went with it |

## Re-applying after a re-vendor

1. `rm -rf enterprise litellm/proxy/enterprise tests/enterprise tests/test_litellm/enterprise`
2. Delete the four test files listed above.
3. Re-apply the configuration changes in the table above.
4. `uv lock`
5. Verify — the proxy must import and the guardrail registry must still discover our hook:

```bash
docker build -t anonymice-engine .
docker run --rm --entrypoint python anonymice-engine -c \
  "from litellm.proxy.proxy_server import app; \
   from litellm.proxy.guardrails.guardrail_registry import get_guardrail_initializer_from_hooks; \
   print(len(app.router.routes), len(get_guardrail_initializer_from_hooks()))"
```

If a future upstream moves an enterprise import out of its `try` block, step 5 is what
catches it.
