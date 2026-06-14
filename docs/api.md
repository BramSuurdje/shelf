# API Shape

All application routes live under `/api/v1`.

- `/api/v1/auth`
- `/api/v1/setup`
- `/api/v1/nodes`
- `/api/v1/uploads`
- `/api/v1/shares`
- `/api/v1/public`
- `/api/v1/events`
- `/api/v1/devices`
- `/api/v1/admin`
- `/api/v1/settings`
- `/api/v1/quotas`
- `/api/v1/audit`

All writes accept `mutationId`. Node mutations also accept `baseNodeRevision` when stale-write protection matters. Responses that mutate nodes include the changed node revision or event cursor where relevant.

