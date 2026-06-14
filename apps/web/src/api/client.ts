const apiBaseUrl = import.meta.env.VITE_API_URL ?? ""

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}/api/v1${path}`, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
    ...init,
  })

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { message: string } }
    | null

  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Request failed")
  }

  return payload?.data as T
}

export async function authFetch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}/api/v1/auth${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })

  const payload = (await response.json().catch(() => null)) as
    | T
    | { message?: string }
    | null

  if (!response.ok) {
    throw new Error(
      payload &&
        typeof payload === "object" &&
        "message" in payload &&
        typeof payload.message === "string"
        ? payload.message
        : "Authentication failed"
    )
  }

  return payload as T
}

export interface ShelfNode {
  id: string
  name: string
  type: "file" | "folder"
  parentId: string | null
  sizeBytes: number
  mimeType: string | null
  revision: number
  updatedAt: string
}

export interface UploadSessionResponse {
  uploadSessionId: string
  nodeId: string
  fileVersionId: string
  objectKey: string
  upload:
    | { kind: "single"; url: string; expiresAt: string }
    | {
        kind: "multipart"
        uploadId: string
        partSizeBytes: number
        parts: Array<{ partNumber: number; url: string }>
        expiresAt: string
      }
}
