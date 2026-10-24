import { readAttachmentManifest, sha256, type Attachment } from "../lib/attachments"

type ResponseBody = { attachments: (Attachment & { url: string })[] }

async function main(): Promise<void> {
  const manifest = await readAttachmentManifest()
  if (!manifest.length) throw new Error("Attachment manifest is empty")
  const samples = [...new Map(manifest.map((entry) => [entry.content_type, entry])).values()]
  const base = process.env.APP_URL ?? "http://localhost:3000"
  for (const sample of samples) {
    const response = await fetch(`${base}/api/orders/${sample.order_id}/attachments`)
    if (!response.ok) throw new Error(`Attachment API returned ${response.status} for ${sample.order_id}`)
    const data = await response.json() as ResponseBody
    const entry = data.attachments.find((item) => item.id === sample.id)
    if (!entry) throw new Error(`${sample.id} is missing from its order attachment API`)
    const file = await fetch(entry.url)
    if (!file.ok) throw new Error(`Signed attachment URL returned ${file.status} for ${sample.id}`)
    if (sha256(Buffer.from(await file.arrayBuffer())) !== sample.sha256) {
      throw new Error(`Downloaded bytes do not match ${sample.id}`)
    }
  }
  console.log(`Verified ${samples.length} attachment formats through the API and local object store.`)
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
