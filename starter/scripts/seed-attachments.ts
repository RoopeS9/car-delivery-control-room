import "dotenv/config"
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { attachmentKey, attachmentPath, readAttachmentManifest, sha256 } from "../lib/attachments"
import { objectStore } from "../lib/object-store"

type LinkRow = { id: string; order_id?: string }

async function readRows(collection: string): Promise<LinkRow[]> {
  const path = join(process.cwd(), "..", "dataset", "data", `${collection}.jsonl`)
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as LinkRow)
}

async function checkLinks(manifest: Awaited<ReturnType<typeof readAttachmentManifest>>): Promise<void> {
  const collectionFor = (type: string): string => ({
    order: "orders", proof: "proofs", site_visit: "site_visits", address: "addresses",
  })[type] ?? `${type}s`
  const collections = new Set(["orders", ...manifest.map((entry) => collectionFor(entry.related_record_type))])
  const rows = new Map(await Promise.all([...collections].map(async (collection) => [
    collection, new Map((await readRows(collection)).map((row) => [row.id, row])),
  ] as const)))
  const orders = rows.get("orders")!
  for (const attachment of manifest) {
    if (!orders.has(attachment.order_id)) throw new Error(`${attachment.id} links to a missing order`)
    const related = rows.get(collectionFor(attachment.related_record_type))?.get(attachment.related_record_id)
    if (!related) throw new Error(`${attachment.id} links to a missing ${attachment.related_record_type}`)
    if (related.order_id && related.order_id !== attachment.order_id) {
      throw new Error(`${attachment.id} links to a record on a different order`)
    }
  }
}

async function main(): Promise<void> {
  const manifest = await readAttachmentManifest()
  await checkLinks(manifest)
  const files = await Promise.all(manifest.map(async (attachment) => {
    const bytes = await readFile(attachmentPath(attachment))
    if (sha256(bytes) !== attachment.sha256) throw new Error(`Checksum mismatch: ${attachment.id}`)
    return { attachment, bytes }
  }))

  // Check every file before creating or updating anything in the local store.
  const { client, bucket } = objectStore()
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }))
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      if (status !== 404) throw error
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
    }
    for (const { attachment, bytes } of files) {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: attachmentKey(attachment),
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: attachment.content_type,
        Metadata: { sha256: attachment.sha256, synthetic: "true" },
      }))
    }
    console.log(`Seeded ${files.length} fictional attachments into the local object store.`)
  } finally {
    client.destroy()
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
