import { PutBucketCorsCommand } from "@aws-sdk/client-s3"

import { loadEnv } from "@shelf/config"
import { loadS3SettingsFromDb } from "@shelf/db"
import { createS3Client } from "@shelf/storage"

const extraOrigins = process.argv.slice(2)
const env = loadEnv()
const s3 = await loadS3SettingsFromDb()
const origins = [
  env.PUBLIC_APP_URL,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...extraOrigins,
].filter((value, index, array) => value && array.indexOf(value) === index)

const client = createS3Client(s3)

await client.send(
  new PutBucketCorsCommand({
    Bucket: s3.bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedHeaders: ["*"],
          AllowedMethods: ["GET", "PUT", "POST", "HEAD"],
          AllowedOrigins: origins,
          ExposeHeaders: ["ETag"],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  })
)

console.log("Bucket CORS configured for origins:")
for (const origin of origins) {
  console.log(`  - ${origin}`)
}
