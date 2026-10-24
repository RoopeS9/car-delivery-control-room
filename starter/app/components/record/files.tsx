"use client"

import { useEffect, useState } from "react"
import { label } from "@/lib/present/labels"
import { Icon } from "../icons"

type CaseFile = {
  id: string; kind: string; status: string; content_type: string; file_name: string; url: string
  related_record_type: string; evidence_note?: string
}

/** Sample files from the local object store, as a strip. Signed links expire after 15 minutes. */
export function OrderFiles({ orderId }: { orderId: string }) {
  const [files, setFiles] = useState<CaseFile[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/orders/${orderId}/attachments`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Could not load files"); return response.json() as Promise<{ attachments: CaseFile[] }> })
      .then((data) => { setFiles(data.attachments); setFailed(false) })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [orderId])
  if (failed) return <p className="empty">Sample files are unavailable. Check that the local object store is running and seeded.</p>
  if (!files?.length) return null
  return <div className="files-strip">{files.map((file) => <a key={file.id} href={file.url} target="_blank" rel="noopener noreferrer" className="file" title={file.evidence_note ?? undefined}>
    <span className="file-thumb">{file.content_type === "image/jpeg"
      // eslint-disable-next-line @next/next/no-img-element -- signed local object-store URL
      ? <img src={file.url} alt={file.evidence_note ?? `${label(file.kind)} case photo`} />
      : <Icon name="file" size={22} />}</span>
    <b>{label(file.kind)}</b>
    <small>{file.content_type === "application/pdf" ? "PDF" : "Photo"} · {label(file.status).toLowerCase()}</small>
  </a>)}</div>
}
