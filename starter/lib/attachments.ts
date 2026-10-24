import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, isAbsolute, join, normalize, sep } from "node:path"

export type Attachment = {
  id: string
  order_id: string
  related_record_type: string
  related_record_id: string
  kind: string
  file_name: string
  content_type: string
  sha256: string
  status: string
  synthetic: true
}

export const attachmentsDir = process.env.ATTACHMENTS_DIR ?? join(process.cwd(), "..", "attachments")

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return ["id", "order_id", "related_record_type", "related_record_id", "kind", "file_name", "content_type", "status"]
    .every((field) => isString(row[field]))
    && typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256)
    && row.synthetic === true
}

export function attachmentPath(attachment: Attachment): string {
  const relative = normalize(attachment.file_name)
  if (isAbsolute(relative) || relative === ".." || relative.startsWith(`..${sep}`)) {
    throw new Error(`Attachment ${attachment.id} has a path outside attachments/`)
  }
  return join(attachmentsDir, relative)
}

export function attachmentKey(attachment: Attachment): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(attachment.id)) throw new Error(`Invalid attachment ID: ${attachment.id}`)
  return `${attachment.id}/${basename(attachment.file_name)}`
}

export async function readAttachmentManifest(): Promise<Attachment[]> {
  const parsed: unknown = JSON.parse(await readFile(join(attachmentsDir, "manifest.json"), "utf8"))
  if (!Array.isArray(parsed) || !parsed.every(isAttachment)) {
    throw new Error("attachments/manifest.json must be an array of fully synthetic attachment entries")
  }
  const ids = new Set<string>()
  for (const attachment of parsed) {
    attachmentPath(attachment)
    attachmentKey(attachment)
    if (ids.has(attachment.id)) throw new Error(`Duplicate attachment ID: ${attachment.id}`)
    ids.add(attachment.id)
  }
  return parsed
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}
