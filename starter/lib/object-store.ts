import { S3Client } from "@aws-sdk/client-s3"

export function objectStore(): { client: S3Client; bucket: string } {
  const endpoint = process.env.S3_ENDPOINT
  const accessKeyId = process.env.S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
  const bucket = process.env.S3_BUCKET
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("Set the S3_* variables from starter/.env.example")
  }
  return {
    bucket,
    client: new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    }),
  }
}
