import {
  AbortMultipartUploadCommand,
  type CompletedPart,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

import { createId } from "@shelf/shared"

export interface S3Settings {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  publicBaseUrl?: string
}

export const multipartThresholdBytes = 64 * 1024 * 1024
export const signedUrlExpiresSeconds = 15 * 60
export const defaultPartSizeBytes = 16 * 1024 * 1024

export function createS3Client(settings: S3Settings) {
  return new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
  })
}

export function createObjectKey(ownerId: string) {
  return `objects/${ownerId}/${createId("obj")}`
}

export function createThumbnailObjectKey(fileVersionId: string) {
  return `thumbnails/${fileVersionId}/square.webp`
}

export async function presignSinglePutUpload(
  client: S3Client,
  settings: S3Settings,
  input: {
    objectKey: string
    contentType: string
    sizeBytes: number
  }
) {
  const command = new PutObjectCommand({
    Bucket: settings.bucket,
    Key: input.objectKey,
    ContentType: input.contentType,
    ContentLength: input.sizeBytes,
  })

  return getSignedUrl(client, command, { expiresIn: signedUrlExpiresSeconds })
}

export async function putObjectBytes(
  client: S3Client,
  settings: S3Settings,
  input: {
    objectKey: string
    body: Uint8Array
    contentType: string
  }
) {
  await client.send(
    new PutObjectCommand({
      Bucket: settings.bucket,
      Key: input.objectKey,
      Body: input.body,
      ContentType: input.contentType,
      ContentLength: input.body.byteLength,
    })
  )
}

export async function presignGetObject(
  client: S3Client,
  settings: S3Settings,
  objectKey: string
) {
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: settings.bucket,
      Key: objectKey,
    }),
    { expiresIn: signedUrlExpiresSeconds }
  )
}

export async function createMultipartUpload(
  client: S3Client,
  settings: S3Settings,
  input: {
    objectKey: string
    contentType: string
  }
) {
  const response = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: settings.bucket,
      Key: input.objectKey,
      ContentType: input.contentType,
    })
  )

  if (!response.UploadId) {
    throw new Error("S3 did not return a multipart upload id")
  }

  return response.UploadId
}

export async function presignMultipartPart(
  client: S3Client,
  settings: S3Settings,
  input: {
    objectKey: string
    uploadId: string
    partNumber: number
  }
) {
  const command = new UploadPartCommand({
    Bucket: settings.bucket,
    Key: input.objectKey,
    UploadId: input.uploadId,
    PartNumber: input.partNumber,
  })

  return getSignedUrl(client, command, { expiresIn: signedUrlExpiresSeconds })
}

export async function completeMultipartUpload(
  client: S3Client,
  settings: S3Settings,
  input: {
    objectKey: string
    uploadId: string
    parts: CompletedPart[]
  }
) {
  return client.send(
    new CompleteMultipartUploadCommand({
      Bucket: settings.bucket,
      Key: input.objectKey,
      UploadId: input.uploadId,
      MultipartUpload: {
        Parts: input.parts.sort(
          (a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0)
        ),
      },
    })
  )
}

export async function abortMultipartUpload(
  client: S3Client,
  settings: S3Settings,
  input: {
    objectKey: string
    uploadId: string
  }
) {
  await client.send(
    new AbortMultipartUploadCommand({
      Bucket: settings.bucket,
      Key: input.objectKey,
      UploadId: input.uploadId,
    })
  )
}

export async function deleteObject(
  client: S3Client,
  settings: S3Settings,
  objectKey: string
) {
  await client.send(
    new DeleteObjectCommand({
      Bucket: settings.bucket,
      Key: objectKey,
    })
  )
}

export async function headObject(
  client: S3Client,
  settings: S3Settings,
  objectKey: string
) {
  return client.send(
    new HeadObjectCommand({
      Bucket: settings.bucket,
      Key: objectKey,
    })
  )
}

export async function getObjectStream(
  client: S3Client,
  settings: S3Settings,
  objectKey: string
) {
  return client.send(
    new GetObjectCommand({
      Bucket: settings.bucket,
      Key: objectKey,
    })
  )
}

export async function testS3Connection(settings: S3Settings) {
  const client = createS3Client(settings)
  await client.send(new HeadBucketCommand({ Bucket: settings.bucket }))
  return true
}
