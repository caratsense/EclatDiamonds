"""
A local stand-in for Cloudflare R2 that VERIFIES SigV4 the way a real S3 server
does, using botocore to recompute the expected signature from the request as
received on the wire.

This tests more than the signing function: it exercises URL construction, header
assembly, body transmission and the client's response handling. If our client can
satisfy an independent verifier, the only thing left that could differ on real R2
is the credentials themselves.
"""
import base64
import hashlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import datetime, timezone

from botocore.auth import S3SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

ACCESS_KEY = "TESTACCESSKEY0001"
SECRET_KEY = "TESTSECRETKEY000000000000000000000000001"
PORT = 8101

STORED = {}      # key -> {"bytes": n, "content_type": str, "sha256": str}
FAILURES = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _verify(self, body):
        auth = self.headers.get("Authorization", "")
        amz_date = self.headers.get("x-amz-date") or self.headers.get("X-Amz-Date")
        if not auth or not amz_date:
            return False, "missing Authorization or x-amz-date"

        # Rebuild exactly what the client sent, then let botocore sign it and
        # compare. Host must match what the client signed.
        url = f"http://{self.headers.get('Host')}{self.path}"
        signed_headers = ""
        for part in auth.split(","):
            part = part.strip()
            if part.startswith("SignedHeaders="):
                signed_headers = part[len("SignedHeaders="):]
        wanted = [h.strip() for h in signed_headers.split(";") if h.strip()]

        # Copy the signed headers EXCEPT the two botocore generates itself —
        # passing those in as well makes it comma-join duplicates and every
        # signature mismatches.
        headers = {}
        for h in wanted:
            if h in ("host", "x-amz-date", "x-amz-content-sha256"):
                continue
            v = self.headers.get(h)
            if v is not None:
                headers[h] = v

        req = AWSRequest(method=self.command, url=url, data=body, headers=headers)
        req.context["payload_signing_enabled"] = True
        # Pin to the client's timestamp so only the algorithm is under test.
        req.context["timestamp"] = amz_date
        signer = S3SigV4Auth(Credentials(ACCESS_KEY, SECRET_KEY), "s3", "auto")
        signer._modify_request_before_signing(req)
        canonical = signer.canonical_request(req)
        sts = signer.string_to_sign(req, canonical)
        expected_sig = signer.signature(sts, req)

        got_sig = auth.rsplit("Signature=", 1)[-1].strip()
        if got_sig != expected_sig:
            return False, (
                f"signature mismatch\n  canonical request server computed:\n"
                f"{canonical}\n  expected={expected_sig}\n  got     ={got_sig}"
            )

        declared = self.headers.get("x-amz-content-sha256", "")
        if declared != hashlib.sha256(body).hexdigest():
            return False, "x-amz-content-sha256 does not match the body actually sent"
        return True, "ok"

    def do_PUT(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        ok, msg = self._verify(body)
        if not ok:
            FAILURES.append((self.path, msg))
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        STORED[self.path] = {
            "bytes": len(body),
            "content_type": self.headers.get("content-type"),
            "cache_control": self.headers.get("cache-control"),
            "sha256": hashlib.sha256(body).hexdigest(),
        }
        self.send_response(200)
        self.send_header("ETag", '"%s"' % hashlib.md5(body).hexdigest())
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        ok, msg = self._verify(b"")
        if not ok:
            FAILURES.append((self.path, msg))
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        exists = self.path in STORED
        self.send_response(200 if exists else 404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path == "/__state":
            payload = json.dumps({"stored": STORED, "failures": FAILURES}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()


if __name__ == "__main__":
    srv = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"fake-R2 listening on {PORT}", flush=True)
    srv.serve_forever()
