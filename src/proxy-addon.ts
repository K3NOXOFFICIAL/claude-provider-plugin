/**
 * mitmproxy addon used by `cpr run <A> --inference <B>`. It touches only
 * POST /v1/messages* on api.anthropic.com; everything else passes through.
 */
export const PROXY_ADDON_PY = String.raw`import json
import os
import time

from mitmproxy import http

with open(os.environ["CPR_PROXY_CONFIG"], encoding="utf-8") as f:
    CFG = json.load(f)


def _error(status, error_type, message, details=None):
    err = {"type": error_type, "message": message}
    if details:
        err["details"] = details
    return http.Response.make(
        status,
        json.dumps({"type": "error", "error": err}),
        {"content-type": "application/json"},
    )


def _map_model(model):
    if CFG.get("forceModel"):
        return CFG["forceModel"]
    tiers = CFG.get("tiers") or {}
    lowered = (model or "").lower()
    for tier in ("opus", "sonnet", "haiku"):
        if tier in lowered and tiers.get(tier):
            return tiers[tier]
    return model


def _oauth_token():
    try:
        with open(CFG["credentialsFile"], encoding="utf-8") as f:
            oauth = json.load(f)["claudeAiOauth"]
    except Exception:
        return None, "no login found for the inference account; run cpr run <account> once and /login"
    if oauth.get("expiresAt") and oauth["expiresAt"] < time.time() * 1000:
        return None, "the inference account's token expired; run cpr run <account> once to refresh it"
    return oauth["accessToken"], None


def request(flow: http.HTTPFlow) -> None:
    r = flow.request
    path = r.path.split("?")[0]
    if r.method != "POST" or not path.startswith("/v1/messages"):
        return

    body = None
    try:
        body = json.loads(r.get_text())
    except Exception:
        pass

    # A claude.ai login sends stateful "thread" turns that only the issuing account can serve.
    # Refusing makes Claude Code resend the full history statelessly.
    if isinstance(body, dict) and "thread" in body:
        flow.response = _error(
            400,
            "invalid_request_error",
            "thread continuation is not supported through the split proxy",
            {"error_code": "thread_unsupported_request"},
        )
        return

    if isinstance(body, dict) and "model" in body:
        body["model"] = _map_model(body["model"])
        r.set_text(json.dumps(body))

    if CFG["mode"] == "oauth":
        token, problem = _oauth_token()
        if problem:
            flow.response = _error(401, "authentication_error", problem)
            return
        r.headers["authorization"] = "Bearer " + token
        return

    r.scheme = CFG["scheme"]
    r.host = CFG["host"]
    r.port = CFG["port"]
    r.headers["host"] = CFG["host"]
    r.path = CFG.get("basePath", "") + r.path
    r.headers.pop("x-api-key", None)
    r.headers["authorization"] = "Bearer " + CFG["token"]
    r.headers["x-api-key"] = CFG["token"]
    betas = r.headers.get("anthropic-beta")
    if betas:
        kept = [b for b in betas.split(",") if not b.strip().startswith("oauth-")]
        if kept:
            r.headers["anthropic-beta"] = ",".join(kept)
        else:
            del r.headers["anthropic-beta"]


def responseheaders(flow: http.HTTPFlow) -> None:
    if flow.response is not None and flow.request.path.startswith("/v1/messages"):
        flow.response.stream = True
`;
