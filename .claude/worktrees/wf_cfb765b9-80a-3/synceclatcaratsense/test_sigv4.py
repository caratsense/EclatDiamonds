"""
Checks eclat_r2.sign_request against botocore's reference signatures.

Run:  python test_sigv4.py

The vectors in `sigv4_vectors.json` came from botocore's own S3SigV4Auth (the
signer inside boto3 and the AWS CLI). Each pins the timestamp botocore used, so
feeding the same instant back makes the comparison deterministic.

This exists because a signing bug is invisible until it hits real R2, where every
mistake — a double-encoded key, a re-encoded query value, an unsorted header —
surfaces as the same opaque `SignatureDoesNotMatch`.
"""
import base64
import json
import os
import sys
from datetime import datetime, timezone

from eclat_r2 import sign_request, encode_key

HERE = os.path.dirname(os.path.abspath(__file__))
ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE"
SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"

passed = failed = 0


def check(label, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"PASS  {label}")
    else:
        failed += 1
        print(f"FAIL  {label}")
        if detail:
            print(f"        {detail}")


with open(os.path.join(HERE, "sigv4_vectors.json"), encoding="utf-8") as f:
    vectors = json.load(f)

for v in vectors:
    when = datetime.strptime(v["amzDate"], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    signed = sign_request(
        v["method"], v["url"], v["headers"],
        base64.b64decode(v["payload_b64"]),
        ACCESS_KEY, SECRET_KEY, now=when,
    )
    ok = signed["Authorization"] == v["authorization"]
    check(
        f"matches botocore: {v['name']}", ok,
        "" if ok else f"ours={signed['Authorization']}\n        ref ={v['authorization']}",
    )
    check(f"  content-sha256: {v['name']}",
          signed["x-amz-content-sha256"] == v["contentSha256"].lower())

check("encode_key keeps separators", encode_key("catalogue/product_1.jpg") == "catalogue/product_1.jpg")
check("encode_key escapes spaces/non-ascii",
      encode_key("catalogue/ring design é.png") == "catalogue/ring%20design%20%C3%A9.png",
      encode_key("catalogue/ring design é.png"))
check("encode_key escapes !'()*",
      encode_key("it's (a) ring!*.jpg") == "it%27s%20%28a%29%20ring%21%2A.jpg",
      encode_key("it's (a) ring!*.jpg"))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
