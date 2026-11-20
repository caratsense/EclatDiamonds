"""
Cloudflare R2 uploads for the Eclat on-site sync agent.

R2 speaks the S3 API, so uploading means signing with AWS Signature V4. This is
hand-rolled rather than pulling in boto3 because boto3 + botocore is ~80 MB of
install on a shop's office PC — often a locked-down machine on a slow line — to
serve exactly one operation: PUT an object at a known endpoint with static keys.
The whole algorithm is below and is checked against botocore's own signer by
`test_sigv4.py`.

Two S3 quirks that are easy to get wrong and fail identically (an opaque
`SignatureDoesNotMatch` that reads like a bad secret):
  * the canonical path is the URL path VERBATIM — S3 does not re-encode or
    normalise it, unlike general SigV4;
  * the canonical query keeps its existing encoding — decoding and re-encoding
    turns a literal `/` in a value into `%2F` and breaks the signature.
"""
import hashlib
import hmac
import os
from datetime import datetime, timezone
from urllib.parse import urlsplit, quote

import requests

ALGORITHM = "AWS4-HMAC-SHA256"


def _sha256(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def _hmac(key, msg):
    if isinstance(key, str):
        key = key.encode("utf-8")
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def encode_key(key):
    """RFC 3986 encoding for an object key, keeping `/` separators literal.

    `safe="/~"` matches AWS's uri-encode rule: unreserved characters and the
    path separator pass through, everything else is percent-encoded.
    """
    return quote(key, safe="/~")


def _canonical_query(query):
    """Sort already-encoded pairs; never decode/re-encode (see module docstring)."""
    if not query:
        return ""
    pairs = []
    for pair in query.split("&"):
        k, _, v = pair.partition("=")
        pairs.append((k, v))
    return "&".join(f"{k}={v}" for k, v in sorted(pairs))


def sign_request(method, url, headers, payload, access_key, secret_key,
                 region="auto", service="s3", now=None):
    """Return the headers to send, including Authorization."""
    parts = urlsplit(url)
    now = now or datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = amz_date[:8]

    payload_hash = _sha256(payload)

    hdrs = dict(headers or {})
    hdrs["host"] = parts.netloc
    hdrs["x-amz-content-sha256"] = payload_hash
    hdrs["x-amz-date"] = amz_date

    normalized = sorted((k.lower(), " ".join(str(v).split())) for k, v in hdrs.items())
    canonical_headers = "".join(f"{k}:{v}\n" for k, v in normalized)
    signed_headers = ";".join(k for k, _ in normalized)

    canonical_request = "\n".join([
        method.upper(),
        parts.path or "/",                 # verbatim — S3 does not re-encode
        _canonical_query(parts.query),
        canonical_headers,
        signed_headers,
        payload_hash,
    ])

    scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join([ALGORITHM, amz_date, scope, _sha256(canonical_request)])

    k_date = _hmac("AWS4" + secret_key, date_stamp)
    k_region = _hmac(k_date, region)
    k_service = _hmac(k_region, service)
    k_signing = _hmac(k_service, "aws4_request")
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    hdrs["Authorization"] = (
        f"{ALGORITHM} Credential={access_key}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return hdrs


CONTENT_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
    ".tif": "image/tiff", ".tiff": "image/tiff",
}


def content_type_of(filename):
    return CONTENT_TYPES.get(os.path.splitext(filename)[1].lower(), "application/octet-stream")


class R2Client:
    """Minimal R2 uploader. `public_base_url` is the bucket's public address —
    either the generated `https://pub-<hash>.r2.dev` or a custom domain."""

    def __init__(self, account_id, access_key, secret_key, bucket, public_base_url,
                 endpoint=None):
        self.account_id = account_id
        self.access_key = access_key
        self.secret_key = secret_key
        self.bucket = bucket
        self.public_base_url = (public_base_url or "").rstrip("/")
        # Override for R2's jurisdiction-specific hosts (e.g. <acct>.eu.r2....)
        # and for pointing at a local S3 stand-in in tests.
        self.endpoint = (endpoint or f"https://{account_id}.r2.cloudflarestorage.com").rstrip("/")

    @property
    def configured(self):
        return all([self.account_id, self.access_key, self.secret_key,
                    self.bucket, self.public_base_url])

    def _url(self, key):
        return f"{self.endpoint}/{self.bucket}/{encode_key(key)}"

    def upload_file(self, path, key, timeout=180):
        """PUT a local file at `key`; returns its public URL."""
        with open(path, "rb") as fh:
            body = fh.read()

        encoded = encode_key(key)
        url = self._url(key)
        headers = sign_request(
            "PUT", url,
            {"content-type": content_type_of(path),
             "cache-control": "public, max-age=31536000, immutable"},
            body, self.access_key, self.secret_key,
        )
        r = requests.put(url, data=body, headers=headers, timeout=timeout)
        if not (200 <= r.status_code < 300):
            raise RuntimeError(f"R2 {r.status_code}: {r.text[:200]}")
        return f"{self.public_base_url}/{encoded}"

    def check_access(self):
        """Cheap credential/permission probe before uploading thousands of files.

        A HEAD on a key that does not exist returns 404 when the credentials and
        bucket are right, and 401/403 when they are not — so 404 is the success
        case here. Better to fail in one request than after the operator has
        walked away expecting a four-hour run.
        """
        url = self._url("_eclat_access_check")
        headers = sign_request("HEAD", url, {}, b"", self.access_key, self.secret_key)
        r = requests.head(url, headers=headers, timeout=30)
        if r.status_code in (200, 404):
            return True, "ok"
        if r.status_code in (401, 403):
            return False, ("R2 rejected the credentials (HTTP %d). Check R2_ACCESS_KEY_ID / "
                           "R2_SECRET_ACCESS_KEY, and that the token has Object Read & Write "
                           "on this bucket." % r.status_code)
        if r.status_code == 404:
            return False, "Bucket not found — check R2_BUCKET and R2_ACCOUNT_ID."
        return False, f"R2 returned HTTP {r.status_code}: {r.text[:200]}"
