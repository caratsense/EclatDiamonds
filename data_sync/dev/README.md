# Dev tools for the sync agent

Not part of the client deliverable — **do not copy this folder to a client PC.**
Only `data_sync/EclatSync/` goes on site.

Both tools support the Cloudflare R2 upload path. R2 speaks the S3 API, so the
agent (and the backend) sign requests with AWS SigV4, hand-rolled in
`EclatSync/eclat_r2.py` and `backend/src/storage/sigv4.ts` to avoid a large SDK
dependency. These exist so that decision stays safe.

They need `botocore`, which the agent itself does not:

```
pip install botocore
```

## `generate_sigv4_vectors.py`

Produces reference signatures using botocore's own `S3SigV4Auth` — the signer
inside boto3 and the AWS CLI. Output is committed as test fixtures in two places:

- `backend/test/sigv4-vectors.json`
- `data_sync/EclatSync/sigv4_vectors.json`

Regenerate only if you add cases. Each vector pins the timestamp botocore chose,
so the comparison is deterministic.

```
python generate_sigv4_vectors.py > vectors.json
```

## `fake_r2.py`

A local stand-in for R2 that **verifies SigV4 the way a real S3 server does**,
recomputing the expected signature with botocore from the request as it arrived
on the wire. It also records what it stored, so a test can assert the body
arrived byte-identical and the Content-Type was right.

This covers what the unit vectors cannot: URL construction, header assembly, body
transmission, and response handling.

```
python fake_r2.py                       # listens on 127.0.0.1:8101
```

Then, in another shell:

```
# Python agent
cd ../EclatSync && python test_sigv4.py

# Backend (the R2 suite skips itself unless this env var is set)
cd ../../backend
R2_TEST_ENDPOINT=http://127.0.0.1:8101 npx jest --config ./test/jest-e2e.json -t "R2 provider"
```

> On Windows a second process can bind a port already in use, silently sending
> your requests to the stale server. If results look impossible, check
> `netstat -ano | grep 8101` for more than one listener.
