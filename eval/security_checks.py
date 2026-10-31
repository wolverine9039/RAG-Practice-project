"""Automated checks of the deployed security measures; writes eval/results_security.json.

    python -m eval.security_checks
    python -m eval.security_checks --site https://uno.example.com --backend https://<service>.run.app --origin-ip 1.2.3.4

Costs one cheap model request (the "nonce accepted" check asks "hi"). Note: the login rate-limit check locks your own
IP out of wp-login.php for about a minute, and the chat-API burst check blocks the chat for you for about a minute.
Secrets are read from .env only to check they are NOT exposed; they are never printed.
"""
import argparse
import json
import random
import re
import socket
import time
import uuid

import httpx

from app.config import PROJECT_ROOT, settings

OUT = PROJECT_ROOT / "eval" / "results_security.json"
DEFAULTS = {
    "site": "https://uno-chatbot.buildwithmayank.tech",
    "backend": "https://uno-rag-backend-231627702902.us-central1.run.app",
    "origin_ip": "34.57.222.238",
}

results: list[dict] = []


def check(area: str, name: str, expected: str, ok: bool | None, observed: str) -> None:
    """ok=None marks an informational finding (not pass/fail)."""
    result = "INFO" if ok is None else ("PASS" if ok else "FAIL")
    results.append({"area": area, "check": name, "expected": expected, "observed": observed, "result": result})
    print(f"  [{result:4}] {area:10} {name}: {observed}")


def cf_challenged(r: httpx.Response) -> bool:
    return r.headers.get("cf-mitigated") == "challenge" or "challenge-platform" in r.text[:5000]


def tcp_blocked(ip: str, port: int, timeout: float = 5.0) -> tuple[bool, str]:
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return False, "connection accepted"
    except (TimeoutError, socket.timeout):
        return True, f"no answer within {timeout:.0f}s"
    except OSError as e:
        return True, f"refused ({e.__class__.__name__})"


def backend_checks(api: str) -> None:
    key = settings.BACKEND_API_KEY
    c = httpx.Client(timeout=60)
    r = c.get(f"{api}/")
    check("backend", "root is a JSON service description (no web page)", "200 application/json",
          r.status_code == 200 and r.headers.get("content-type", "").startswith("application/json"),
          f"{r.status_code} {r.headers.get('content-type')}")
    r = c.get(f"{api}/health")
    body = r.text
    leaked = [n for n, v in (("BACKEND_API_KEY", key), ("LANGFUSE_SECRET_KEY", settings.LANGFUSE_SECRET_KEY)) if v and v in body]
    check("backend", "/health is public and contains no secrets", "200, no secret values",
          r.status_code == 200 and not leaked, f"{r.status_code}, leaked: {leaked or 'none'}")
    for method, path, payload in (("POST", "/chat", {"question": "hi"}), ("POST", "/ingest", {}),
                                  ("POST", "/feedback", {"trace_id": "0" * 32, "value": 1}),
                                  ("DELETE", "/chat/{session_id}", None)):
        url = f"{api}{path}".replace("{session_id}", str(uuid.uuid4()))
        for label, headers in (("no key", {}), ("wrong key", {"X-API-Key": "wrong-" + uuid.uuid4().hex})):
            r = c.request(method, url, json=payload, headers=headers)
            check("backend", f"{method} {path} with {label} is rejected", "401", r.status_code == 401, str(r.status_code))
    auth = {"X-API-Key": key}
    r = c.post(f"{api}/chat", json={"question": "x" * 1001}, headers=auth)
    check("backend", "question over 1000 characters is rejected before any model call", "422",
          r.status_code == 422, str(r.status_code))
    r = c.post(f"{api}/feedback", json={"trace_id": "not-a-trace-id", "value": 1}, headers=auth)
    check("backend", "malformed feedback trace id is rejected", "422", r.status_code == 422, str(r.status_code))
    r = c.get(f"{api}/docs")
    check("backend", "OpenAPI docs page", "informational", None,
          f"{r.status_code} (public schema only; every data endpoint still needs the key)")


def site_checks(site: str, origin_ip: str, api: str) -> None:
    host = httpx.URL(site).host
    c = httpx.Client(timeout=30, headers={"User-Agent": "uno-security-checks/1.0"})
    r = home = c.get(f"{site}/")
    if cf_challenged(r):
        check("site", "home page through Cloudflare", "200 via Cloudflare", None, "blocked by a Cloudflare challenge")
        return
    check("site", "valid HTTPS certificate, served through Cloudflare", "200, server: cloudflare, cf-ray",
          r.status_code == 200 and r.headers.get("server") == "cloudflare" and "cf-ray" in r.headers,
          f"{r.status_code}, server={r.headers.get('server')}, cf-ray={'yes' if 'cf-ray' in r.headers else 'no'}")
    r = c.get(f"http://{host}/", follow_redirects=False)
    check("site", "http redirects to https", "301/308 -> https://",
          r.status_code in (301, 302, 307, 308) and r.headers.get("location", "").startswith("https://"),
          f"{r.status_code} -> {r.headers.get('location')}")
    for port in (443, 80):
        blocked, how = tcp_blocked(origin_ip, port)
        check("network", f"origin {origin_ip}:{port} not reachable directly (Cloudflare-only firewall)",
              "no connection", blocked, how)
    r = c.get(f"{site}/xmlrpc.php")
    check("site", "xmlrpc.php blocked", "403", r.status_code == 403, str(r.status_code))
    for name, value in (("HSTS", "strict-transport-security"), ("nosniff", "x-content-type-options"),
                        ("frame options", "x-frame-options")):
        check("site", f"security header: {name}", "informational", None, home.headers.get(value, "not set"))

    page = c.get(f"{site}/uno-rules-chat/").text
    key = settings.BACKEND_API_KEY
    check("plugin", "chat page does not expose the backend API key", "key absent", bool(key) and key not in page,
          "absent" if key not in page else "PRESENT")
    api_host = httpx.URL(api).host
    check("plugin", "chat page does not expose the backend address", "backend host absent",
          api_host not in page and "run.app" not in page, "absent" if "run.app" not in page else "present")
    m = re.search(r'"nonce":"([0-9a-f]+)"', page)

    ask = f"{site}/wp-json/uno-chat/v1/ask"
    r = c.post(ask, json={"question": "hi", "session_id": str(uuid.uuid4())})
    check("plugin", "REST /ask without a nonce is rejected", "403", r.status_code == 403, str(r.status_code))
    r = c.post(ask, json={"question": "hi", "session_id": str(uuid.uuid4())}, headers={"X-WP-Nonce": "0123456789"})
    check("plugin", "REST /ask with a forged nonce is rejected", "403", r.status_code == 403, str(r.status_code))
    if m:
        r = c.post(ask, json={"question": "hi", "session_id": str(uuid.uuid4())}, headers={"X-WP-Nonce": m.group(1)})
        check("plugin", "REST /ask with the page's nonce is answered (WordPress -> backend proxy works)", "200",
              r.status_code == 200 and "answer" in r.json(), str(r.status_code))
    else:
        check("plugin", "REST /ask with the page's nonce", "200", False, "nonce not found in page")

    # Cloudflare itself rejects a client-supplied CF-Connecting-IP (error 1000), so it never reaches the origin
    r = c.post(ask, json={"question": "hi", "session_id": "x"}, headers={"CF-Connecting-IP": "9.9.9.9"})
    edge_block = "error code: 1000" in r.text or "prohibited IP" in r.text  # plain-text or HTML error page
    check("rate-limit", "forged CF-Connecting-IP header is rejected at Cloudflare's edge", "403 error 1000",
          r.status_code == 403 and edge_block and "uno_chat" not in r.text,
          f"{r.status_code} Cloudflare error 1000" if edge_block else f"{r.status_code} {r.text[:60]!r}")

    # Caddy chat zone: 20 requests/minute per real visitor IP. Other spoofed proxy headers reach the origin and must
    # not create new buckets (Caddy only trusts CF-Connecting-IP, and only from Cloudflare's ranges).
    statuses = []
    for _ in range(25):
        fake = ".".join(str(random.randint(1, 254)) for _ in range(4))
        r = c.post(ask, json={"question": "hi", "session_id": "x"},
                   headers={"X-Forwarded-For": fake, "X-Real-IP": fake, "True-Client-IP": fake})
        statuses.append(r.status_code)
        if r.status_code == 429:
            retry = r.headers.get("retry-after")
            break
    else:
        retry = None
    first_429 = statuses.index(429) + 1 if 429 in statuses else None
    # 3 chat-API calls above already count towards the same per-minute bucket
    check("rate-limit", "chat API: per-IP burst limit (20/min) holds even with spoofed IP headers",
          "429 by the 21st call in the minute, never 200",
          first_429 is not None and first_429 + 3 <= 21 and 200 not in statuses,
          f"first 429 at call {first_429} of this burst (+3 earlier), Retry-After {retry}s, statuses {sorted(set(statuses))}")

    login = f"{site}/wp-login.php"
    statuses = []
    for _ in range(7):
        r = c.post(login, data={"log": "security-check-" + uuid.uuid4().hex[:6], "pwd": "wrong"}, follow_redirects=False)
        statuses.append(r.status_code)
        if r.status_code == 429:
            retry = r.headers.get("retry-after")
            break
    first_429 = statuses.index(429) + 1 if 429 in statuses else None
    check("rate-limit", "login: 5 attempts/min per IP, then 429 with Retry-After", "6th attempt -> 429",
          first_429 == 6, f"attempt statuses {statuses}, Retry-After {retry if first_429 else '-'}s")
    r = c.get(login)
    check("rate-limit", "login page itself still loads while POSTs are limited", "200", r.status_code == 200,
          str(r.status_code))


def main():
    ap = argparse.ArgumentParser(description="Check the deployed security measures")
    ap.add_argument("--site", default=DEFAULTS["site"])
    ap.add_argument("--backend", default=DEFAULTS["backend"])
    ap.add_argument("--origin-ip", default=DEFAULTS["origin_ip"])
    args = ap.parse_args()
    site, api = args.site.rstrip("/"), args.backend.rstrip("/")
    print("Backend (Cloud Run)")
    backend_checks(api)
    print("WordPress site (Cloudflare -> Caddy -> WordPress)")
    site_checks(site, args.origin_ip, api)
    summary = {k: sum(r["result"] == k for r in results) for k in ("PASS", "FAIL", "INFO")}
    OUT.write_text(json.dumps({"run_at": time.strftime("%Y-%m-%d %H:%M"), "site": site,
                               "backend_host": httpx.URL(api).host, "summary": summary, "checks": results},
                              indent=2), encoding="utf-8")
    print(f"\n{summary['PASS']} passed, {summary['FAIL']} failed, {summary['INFO']} informational. Saved {OUT}")


if __name__ == "__main__":
    main()
