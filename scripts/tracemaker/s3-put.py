#!/usr/bin/env python3
"""PUT one file to S3-compatible storage (Cloudflare R2, AWS). Stdlib only."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hmac_sha256(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def signing_key(secret: str, datestamp: str, region: str, service: str) -> bytes:
    k_date = hmac_sha256(("AWS4" + secret).encode("utf-8"), datestamp)
    k_region = hmac.new(k_date, region.encode("utf-8"), hashlib.sha256).digest()
    k_service = hmac.new(k_region, service.encode("utf-8"), hashlib.sha256).digest()
    return hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()


def content_type_for(path: str, explicit: str | None) -> str:
    if explicit:
        return explicit
    lower = path.lower()
    if lower.endswith(".json"):
        return "application/json"
    if lower.endswith(".txt") or lower.endswith(".md"):
        return "text/plain; charset=utf-8"
    if lower.endswith(".tar.gz") or lower.endswith(".tgz"):
        return "application/gzip"
    if lower.endswith(".zip"):
        return "application/zip"
    return "application/octet-stream"


def put_object(opts: argparse.Namespace) -> None:
    body = open(opts.file, "rb").read()
    payload_hash = sha256_hex(body)
    now = dt.datetime.now(dt.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")
    region = opts.region
    service = "s3"
    endpoint = opts.endpoint.rstrip("/")
    host = urllib.parse.urlparse(endpoint).netloc
    key = opts.key.lstrip("/")
    if opts.path_style:
        canonical_uri = "/" + urllib.parse.quote(f"{opts.bucket}/{key}", safe="/-_.~")
        url = f"{endpoint}/{opts.bucket}/{urllib.parse.quote(key, safe='/-_.~')}"
    else:
        canonical_uri = "/" + urllib.parse.quote(key, safe="/-_.~")
        url = f"{endpoint}/{urllib.parse.quote(key, safe='/-_.~')}"
        host = f"{opts.bucket}.{host}"
    content_type = content_type_for(opts.file, opts.content_type)
    cache = opts.cache_control
    headers = {
        "content-type": content_type,
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    if cache:
        headers["cache-control"] = cache
    signed_header_names = ";".join(sorted(headers))
    canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
    canonical_request = "\n".join(
        [
            "PUT",
            canonical_uri,
            "",
            canonical_headers,
            signed_header_names,
            payload_hash,
        ]
    )
    credential_scope = f"{datestamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            credential_scope,
            sha256_hex(canonical_request.encode("utf-8")),
        ]
    )
    signature = hmac.new(
        signing_key(opts.secret_key, datestamp, region, service),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    auth = (
        f"AWS4-HMAC-SHA256 Credential={opts.access_key}/{credential_scope}, "
        f"SignedHeaders={signed_header_names}, Signature={signature}"
    )
    req_headers = {
        "Authorization": auth,
        "Content-Type": content_type,
        "Host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
        "Content-Length": str(len(body)),
    }
    if cache:
        req_headers["Cache-Control"] = cache
    request = urllib.request.Request(url, data=body, method="PUT", headers=req_headers)
    try:
        with urllib.request.urlopen(request, timeout=opts.timeout) as resp:
            status = getattr(resp, "status", 200)
            if status >= 400:
                raise SystemExit(f"S3 PUT {opts.key} failed: HTTP {status}")
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")[:500]
        raise SystemExit(f"S3 PUT {opts.key} failed: HTTP {err.code} {detail}") from err
    print(f"uploaded s3://{opts.bucket}/{key} ({len(body)} bytes)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--region", default=os.environ.get("TRACEMAKER_S3_REGION", "auto"))
    parser.add_argument("--access-key", default=os.environ.get("TRACEMAKER_S3_ACCESS_KEY_ID", ""))
    parser.add_argument("--secret-key", default=os.environ.get("TRACEMAKER_S3_SECRET_ACCESS_KEY", ""))
    parser.add_argument("--content-type")
    parser.add_argument("--cache-control")
    parser.add_argument("--path-style", action="store_true", default=True)
    parser.add_argument("--virtual-hosted", action="store_true")
    parser.add_argument("--timeout", type=int, default=120)
    opts = parser.parse_args()
    if opts.virtual_hosted:
        opts.path_style = False
    if not opts.access_key or not opts.secret_key:
        print("s3-put.py: missing access/secret key", file=sys.stderr)
        raise SystemExit(2)
    put_object(opts)


if __name__ == "__main__":
    main()
