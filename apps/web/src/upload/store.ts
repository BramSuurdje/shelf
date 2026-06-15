import { toast } from "sonner"
import { create } from "zustand"

import { apiFetch, type UploadSessionResponse } from "@/api/client"

type UploadStatus = "queued" | "uploading" | "complete" | "failed" | "cancelled"

export interface UploadTask {
  id: string
  file: File
  parentId: string | null
  batchId?: string
  status: UploadStatus
  progress: number
  speedBytesPerSecond: number
  etaSeconds: number | null
  error?: string
  abortController: AbortController
  uploadSessionId?: string
  abortMutationId?: string
}

interface UploadState {
  tasks: UploadTask[]
  addFiles: (
    files: File[],
    parentId: string | null,
    options?: { toastLabel?: string }
  ) => void
  addFileGroups: (
    groups: Array<{ files: File[]; parentId: string | null }>,
    options?: { toastLabel?: string }
  ) => void
  retry: (taskId: string) => void
  cancel: (taskId: string) => void
  startNext: () => void
}

const maxConcurrentUploads = 4
const uploadBatchTrackers = new Map<
  string,
  {
    completed: number
    failed: number
    settled: number
    total: number
    resolve: () => void
    reject: (error: Error) => void
  }
>()

function createUploadBatch(label: string, total: number) {
  const id = crypto.randomUUID()
  const promise = new Promise<void>((resolve, reject) => {
    uploadBatchTrackers.set(id, {
      completed: 0,
      failed: 0,
      settled: 0,
      total,
      resolve,
      reject,
    })
  })

  toast.promise(promise, {
    loading: `Uploading ${label}`,
    success: `${label} uploaded`,
    error: (error) =>
      error instanceof Error ? error.message : `Failed to upload ${label}`,
  })

  return id
}

function settleUploadBatch(
  batchId: string | undefined,
  status: "complete" | "failed" | "cancelled",
  error?: Error
) {
  if (!batchId) return
  const tracker = uploadBatchTrackers.get(batchId)
  if (!tracker) return

  tracker.settled += 1
  if (status === "complete") tracker.completed += 1
  if (status !== "complete") tracker.failed += 1

  if (tracker.settled < tracker.total) return
  uploadBatchTrackers.delete(batchId)

  if (tracker.failed > 0) {
    tracker.reject(
      error ??
        new Error(
          `Uploaded ${tracker.completed} of ${tracker.total} files. ${tracker.failed} failed.`
        )
    )
    return
  }

  tracker.resolve()
}

async function uploadFile(
  task: UploadTask,
  update: (patch: Partial<UploadTask>) => void
) {
  const mimeType = task.file.type || "application/octet-stream"
  const session = await apiFetch<UploadSessionResponse>("/uploads", {
    method: "POST",
    body: JSON.stringify({
      mutationId: crypto.randomUUID(),
      parentId: task.parentId,
      fileName: task.file.name,
      mimeType,
      sizeBytes: task.file.size,
    }),
  })
  update({ uploadSessionId: session.uploadSessionId })

  const startedAt = performance.now()

  if (session.upload.kind === "single") {
    await putWithProgress(
      session.upload.url,
      task.file,
      mimeType,
      task.abortController,
      (loaded) => {
        updateProgress(task.file.size, loaded, startedAt, update)
      }
    )
  } else {
    const upload = session.upload
    let uploadedBytes = 0
    const completedParts = await Promise.all(
      upload.parts.map(async (part) => {
        const start = (part.partNumber - 1) * upload.partSizeBytes
        const end = Math.min(start + upload.partSizeBytes, task.file.size)
        const blob = task.file.slice(start, end)
        const response = await putPartWithRetry(
          part.url,
          blob,
          task.abortController
        )
        const eTag = response.headers.get("etag")
        if (!eTag) throw new Error("S3 did not return a multipart ETag")
        uploadedBytes += blob.size
        updateProgress(task.file.size, uploadedBytes, startedAt, update)
        return { partNumber: part.partNumber, eTag }
      })
    )
    await apiFetch(`/uploads/${session.uploadSessionId}/complete`, {
      method: "POST",
      body: JSON.stringify({
        mutationId: crypto.randomUUID(),
        uploadSessionId: session.uploadSessionId,
        parts: completedParts.toSorted(
          (left, right) => left.partNumber - right.partNumber
        ),
      }),
    })
    return
  }

  await apiFetch(`/uploads/${session.uploadSessionId}/complete`, {
    method: "POST",
    body: JSON.stringify({
      mutationId: crypto.randomUUID(),
      uploadSessionId: session.uploadSessionId,
    }),
  })
}

async function putPartWithRetry(
  url: string,
  blob: Blob,
  abortController: AbortController
) {
  return putPartAttempt(url, blob, abortController, 0)
}

async function putPartAttempt(
  url: string,
  blob: Blob,
  abortController: AbortController,
  attempt: number
): Promise<Response> {
  try {
    const response = await fetch(url, {
      method: "PUT",
      body: blob,
      signal: abortController.signal,
    })
    if (response.ok) return response
    if (attempt >= 2) {
      throw new Error(
        `Multipart part upload failed with HTTP ${response.status}`
      )
    }
  } catch (error) {
    if (abortController.signal.aborted || attempt >= 2) {
      throw error
    }
  }

  return putPartAttempt(url, blob, abortController, attempt + 1)
}

function updateProgress(
  totalBytes: number,
  loadedBytes: number,
  startedAt: number,
  update: (patch: Partial<UploadTask>) => void
) {
  const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.1)
  const speedBytesPerSecond = loadedBytes / elapsedSeconds
  const remainingBytes = totalBytes - loadedBytes
  update({
    progress: loadedBytes / totalBytes,
    speedBytesPerSecond,
    etaSeconds:
      speedBytesPerSecond > 0 ? remainingBytes / speedBytesPerSecond : null,
  })
}

function putWithProgress(
  url: string,
  file: File,
  mimeType: string,
  abortController: AbortController,
  onProgress: (loaded: number) => void
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest()
    abortController.signal.addEventListener("abort", () => request.abort())
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded)
    })
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve()
      else reject(new Error(`Upload failed with HTTP ${request.status}`))
    })
    request.addEventListener("error", () =>
      reject(
        new Error(
          "Upload failed before S3 returned a response. Check the bucket CORS policy for http://localhost:5173 and allowed PUT headers."
        )
      )
    )
    request.addEventListener("abort", () =>
      reject(new Error("Upload cancelled"))
    )
    request.open("PUT", url)
    request.setRequestHeader("Content-Type", mimeType)
    request.send(file)
  })
}

export const useUploadStore = create<UploadState>((set, get) => ({
  tasks: [],
  addFiles: (files, parentId, options) => {
    get().addFileGroups([{ files, parentId }], options)
  },
  addFileGroups: (groups, options) => {
    const totalFiles = groups.reduce(
      (total, group) => total + group.files.length,
      0
    )
    const batchId =
      options?.toastLabel && totalFiles > 0
        ? createUploadBatch(options.toastLabel, totalFiles)
        : undefined
    set((state) => ({
      tasks: [
        ...state.tasks,
        ...groups.flatMap((group) =>
          group.files.map((file) => ({
            id: crypto.randomUUID(),
            file,
            parentId: group.parentId,
            batchId,
            status: "queued" as const,
            progress: 0,
            speedBytesPerSecond: 0,
            etaSeconds: null,
            abortController: new AbortController(),
          }))
        ),
      ],
    }))
    get().startNext()
  },
  retry: (taskId) => {
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              status: "queued",
              progress: 0,
              error: undefined,
              batchId: undefined,
              uploadSessionId: undefined,
              abortMutationId: undefined,
              abortController: new AbortController(),
            }
          : task
      ),
    }))
    get().startNext()
  },
  cancel: (taskId) => {
    const task = get().tasks.find((item) => item.id === taskId)
    task?.abortController.abort()
    if (task?.uploadSessionId) {
      const abortMutationId = task.abortMutationId ?? crypto.randomUUID()
      void apiFetch(`/uploads/${task.uploadSessionId}/abort`, {
        method: "POST",
        body: JSON.stringify({ mutationId: abortMutationId }),
      }).catch(() => undefined)
      set((state) => ({
        tasks: state.tasks.map((item) =>
          item.id === taskId ? { ...item, abortMutationId } : item
        ),
      }))
    }
    set((state) => ({
      tasks: state.tasks.map((item) =>
        item.id === taskId ? { ...item, status: "cancelled" } : item
      ),
    }))
  },
  startNext: () => {
    const state = get()
    const activeCount = state.tasks.filter(
      (task) => task.status === "uploading"
    ).length
    const slots = maxConcurrentUploads - activeCount
    const nextTasks = state.tasks
      .filter((task) => task.status === "queued")
      .slice(0, slots)

    for (const task of nextTasks) {
      set((current) => ({
        tasks: current.tasks.map((item) =>
          item.id === task.id ? { ...item, status: "uploading" } : item
        ),
      }))

      const promise = uploadFile(task, (patch) => {
        set((current) => ({
          tasks: current.tasks.map((item) =>
            item.id === task.id ? { ...item, ...patch } : item
          ),
        }))
      })

      const fileName = task.file.name

      if (!task.batchId) {
        toast.promise(promise, {
          loading: `Uploading ${fileName}`,
          success: `${fileName} uploaded`,
          error: (error) =>
            error instanceof Error
              ? error.message
              : `Failed to upload ${fileName}`,
        })
      }

      void promise
        .then(() => {
          set((current) => ({
            tasks: current.tasks.map((item) =>
              item.id === task.id
                ? { ...item, status: "complete", progress: 1, etaSeconds: 0 }
                : item
            ),
          }))
          settleUploadBatch(task.batchId, "complete")
          window.dispatchEvent(new CustomEvent("shelf:upload-complete"))
        })
        .catch((error: Error) => {
          set((current) => ({
            tasks: current.tasks.map((item) =>
              item.id === task.id && item.status !== "cancelled"
                ? { ...item, status: "failed", error: error.message }
                : item
            ),
          }))
          settleUploadBatch(task.batchId, "failed", error)
        })
        .finally(() => get().startNext())
    }
  },
}))
