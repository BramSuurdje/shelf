# Storage

Shelf treats S3-compatible storage as an object byte store. Database rows are the source of truth for visible paths, folder hierarchy, active file versions, tombstones, shares, public links, and quotas.

Uploads are server-orchestrated:

1. Client creates an upload session.
2. API validates auth, permissions, quotas, and limits.
3. API creates a pending node, pending version, and pending upload session.
4. API returns a presigned PUT URL or multipart part URLs.
5. Browser uploads bytes directly to S3.
6. Client completes the upload session.
7. API marks the version complete and emits a node event.
8. Worker expires stale sessions and aborts stale multipart uploads.

Because step 5 runs in the browser, the bucket must allow cross-origin requests from Shelf's public origin. At minimum, allow `PUT`, `GET`, and `HEAD`, allow the `content-type` request header, and expose `ETag`.

Default thresholds:

- Multipart threshold: 64 MiB
- Signed URL expiry: 15 minutes
- Concurrent file uploads: 4
- Concurrent multipart parts per file: 4
