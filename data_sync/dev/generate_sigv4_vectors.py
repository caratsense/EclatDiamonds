"""Reference SigV4 signatures from botocore, for cross-checking our signer.

Uses S3SigV4Auth (not plain SigV4Auth) because S3/R2 signing includes the
x-amz-content-sha256 header in the signed set. Rather than pinning botocore's
clock (which it reads internally), we let it choose a timestamp and report it,
so the comparison harness can feed the SAME instant to our signer.
"""
import json, base64
from botocore.auth import S3SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

CASES = [
    {"name": "simple put", "method": "PUT",
     "url": "https://abc123.r2.cloudflarestorage.com/eclat-media/catalogue/product_8001.jpg",
     "headers": {"content-type": "image/jpeg"}, "payload": b"hello world"},
    {"name": "empty payload get", "method": "GET",
     "url": "https://abc123.r2.cloudflarestorage.com/eclat-media/",
     "headers": {}, "payload": b""},
    {"name": "key with spaces and unicode", "method": "PUT",
     "url": "https://abc123.r2.cloudflarestorage.com/eclat-media/catalogue/ring%20design%20%C3%A9.png",
     "headers": {"content-type": "image/png"}, "payload": b"\x89PNG\r\n\x1a\n"},
    {"name": "key with rfc3986 specials", "method": "PUT",
     "url": "https://abc123.r2.cloudflarestorage.com/eclat-media/catalogue/it%27s%20%28a%29%20ring%21%2A.jpg",
     "headers": {"content-type": "image/jpeg"}, "payload": b"x"},
    {"name": "query params", "method": "GET",
     "url": "https://abc123.r2.cloudflarestorage.com/eclat-media?list-type=2&prefix=catalogue/&max-keys=100",
     "headers": {}, "payload": b""},
    {"name": "extra signed headers", "method": "PUT",
     "url": "https://abc123.r2.cloudflarestorage.com/eclat-media/catalogue/stock_42.jpg",
     "headers": {"content-type": "image/jpeg", "cache-control": "public, max-age=31536000"},
     "payload": bytes(range(256))},
]

AK = "AKIAIOSFODNN7EXAMPLE"
SK = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
REGION, SERVICE = "auto", "s3"

out = []
for c in CASES:
    req = AWSRequest(method=c["method"], url=c["url"], data=c["payload"], headers=dict(c["headers"]))
    req.context["payload_signing_enabled"] = True   # force real hash, not UNSIGNED-PAYLOAD
    S3SigV4Auth(Credentials(AK, SK), SERVICE, REGION).add_auth(req)
    out.append({
        "name": c["name"], "method": c["method"], "url": c["url"],
        "headers": c["headers"],
        "payload_b64": base64.b64encode(c["payload"]).decode(),
        "authorization": req.headers["Authorization"],
        "amzDate": req.headers["X-Amz-Date"],
        "contentSha256": req.headers.get("X-Amz-Content-SHA256"),
    })

print(json.dumps(out, indent=1))
