import { isNull } from "drizzle-orm"
import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { relatedRecords } from "@/lib/schema"

export const runtime = "nodejs"

export async function GET() {
  const rows = await db.select().from(relatedRecords).where(isNull(relatedRecords.orderId))
  return NextResponse.json({ related: Object.groupBy(rows, (row) => row.collection) })
}
