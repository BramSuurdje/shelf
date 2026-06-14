import { describe, expect, test } from "bun:test"

import {
  completeUploadSchema,
  createFolderSchema,
  publicLinkToken,
  setupSchema,
  sha256Hex,
  usernameSchema,
} from "./packages/shared/src/index"
import { openSecret, sealSecret } from "./packages/config/src/index"
import {
  completeMultipartUpload,
  createObjectKey,
  createThumbnailObjectKey,
  defaultPartSizeBytes,
  multipartThresholdBytes,
  signedUrlExpiresSeconds,
  type S3Settings,
} from "./packages/storage/src/index"
import { logger } from "./packages/logger/src/index"

const testS3Settings: S3Settings = {
  endpoint: "https://storage.example.com",
  region: "auto",
  bucket: "bucket",
  accessKeyId: "access",
  secretAccessKey: "secret",
  forcePathStyle: false,
}

describe("Shelf shared contracts", () => {
  test("validates usernames with the v1 URL-safe contract", () => {
    expect(usernameSchema.parse("bram_123")).toBe("bram_123")
    expect(() => usernameSchema.parse("Bram")).toThrow()
    expect(() => usernameSchema.parse("no")).toThrow()
  })

  test("requires mutation ids for node writes", () => {
    expect(
      createFolderSchema.parse({
        mutationId: "mutation-1",
        parentId: null,
        name: "Projects",
      })
    ).toMatchObject({ name: "Projects" })

    expect(() =>
      createFolderSchema.parse({
        parentId: null,
        name: "Projects",
      })
    ).toThrow()
  })

  test("validates first-run setup input", () => {
    expect(
      setupSchema.parse({
        appName: "Shelf",
        mutationId: "setup-mutation-1",
        publicAppUrl: "http://localhost:5173",
        owner: {
          name: "Owner",
          email: "owner@example.com",
          username: "owner_user",
          password: "long-password",
        },
        storage: {
          endpoint: "https://storage.railway.app",
          region: "auto",
          bucket: "bucket",
          accessKeyId: "access",
          secretAccessKey: "secret",
          forcePathStyle: false,
        },
        quotas: {
          defaultUserQuotaBytes: 1_000_000,
        },
        registrationMode: "invite_only",
        oauth: {
          githubEnabled: false,
          googleEnabled: false,
        },
        smtpEnabled: false,
      })
    ).toMatchObject({ appName: "Shelf" })
  })

  test("requires mutation ids for setup and upload completion writes", () => {
    expect(() =>
      setupSchema.parse({
        appName: "Shelf",
        publicAppUrl: "http://localhost:5173",
        owner: {
          name: "Owner",
          email: "owner@example.com",
          username: "owner_user",
          password: "long-password",
        },
        storage: {
          endpoint: "https://storage.railway.app",
          region: "auto",
          bucket: "bucket",
          accessKeyId: "access",
          secretAccessKey: "secret",
          forcePathStyle: false,
        },
        quotas: {
          defaultUserQuotaBytes: 1_000_000,
        },
        registrationMode: "invite_only",
        oauth: {
          githubEnabled: false,
          googleEnabled: false,
        },
        smtpEnabled: false,
      })
    ).toThrow()

    expect(() =>
      completeUploadSchema.parse({
        uploadSessionId: "upl_1",
        parts: [{ partNumber: 1, eTag: "etag" }],
      })
    ).toThrow()
  })

  test("creates public link tokens that hash deterministically", async () => {
    const token = publicLinkToken()
    expect(token).toHaveLength(64)
    await expect(sha256Hex(token)).resolves.toHaveLength(64)
  })

  test("seals and opens encrypted settings", async () => {
    const secret = "a".repeat(32)
    const sealed = await sealSecret("s3-secret-value", secret)
    expect(sealed).not.toContain("s3-secret-value")
    await expect(openSecret(sealed, secret)).resolves.toBe("s3-secret-value")
  })

  test("creates opaque storage object and thumbnail keys", () => {
    const first = createObjectKey("user_1")
    const second = createObjectKey("user_1")

    expect(first).toStartWith("objects/user_1/obj_")
    expect(second).toStartWith("objects/user_1/obj_")
    expect(first).not.toBe(second)
    expect(first).not.toContain("report.pdf")
    expect(createThumbnailObjectKey("ver_1")).toBe("thumbnails/ver_1/square.webp")
  })

  test("uses the upload timing and multipart defaults from the plan", () => {
    expect(multipartThresholdBytes).toBe(64 * 1024 * 1024)
    expect(defaultPartSizeBytes).toBe(16 * 1024 * 1024)
    expect(signedUrlExpiresSeconds).toBe(15 * 60)
  })

  test("sorts multipart parts before completing an upload", async () => {
    const calls: unknown[] = []
    const client = {
      send(command: { input?: unknown }) {
        calls.push(command.input)
        return Promise.resolve({})
      },
    }

    await completeMultipartUpload(
      client as never,
      testS3Settings,
      {
        objectKey: "objects/user_1/obj_1",
        uploadId: "upload-1",
        parts: [
          { PartNumber: 3, ETag: "three" },
          { PartNumber: 1, ETag: "one" },
          { PartNumber: 2, ETag: "two" },
        ],
      }
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      Bucket: "bucket",
      Key: "objects/user_1/obj_1",
      UploadId: "upload-1",
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: "one" },
          { PartNumber: 2, ETag: "two" },
          { PartNumber: 3, ETag: "three" },
        ],
      },
    })
  })

  test("redacts sensitive logger fields recursively", () => {
    const originalLog = console.log
    const lines: string[] = []
    console.log = (line: string) => {
      lines.push(line)
    }

    try {
      logger.info("redaction test", {
        accessKeyId: "visible-key",
        nested: {
          password: "secret-password",
          publicValue: "safe",
        },
      })
    } finally {
      console.log = originalLog
    }

    const payload = JSON.parse(lines[0] ?? "{}") as {
      accessKeyId?: string
      nested?: { password?: string; publicValue?: string }
    }
    expect(payload.accessKeyId).toBe("[redacted]")
    expect(payload.nested?.password).toBe("[redacted]")
    expect(payload.nested?.publicValue).toBe("safe")
  })
})
