// The dossier: everything known about one order, grouped by information class, every item typed and graded.
// It is static context: built from records, loaded whole into a reasoning model, never fetched piecemeal by tool calls.
import { z } from "zod"
import { RECORDS, type CollectionName } from "./records.generated"
import { COLLECTION_CLASS, ClassId, Phase, type DatasetClassId } from "./classes"
import { Live } from "./live"
import { Id, IsoDateTime, Text } from "./primitives"
import { Strength, type RecordOf } from "./strength"

/** How the item reached this dossier: it names the order, it is joined through a link, or it might concern the order. */
export const Membership = z.enum(["DIRECT", "JOINED", "CANDIDATE"])
export type Membership = z.infer<typeof Membership>

export type DossierItem = {
  [C in CollectionName]: { collection: C; id: string; at: string | null; strength: Strength; membership: Membership; record: RecordOf<C> }
}[CollectionName]

const COLLECTIONS = Object.keys(RECORDS) as CollectionName[]
const itemSchema = (c: CollectionName) => z.object({
  collection: z.literal(c), id: Id, at: IsoDateTime.nullable(), strength: Strength, membership: Membership, record: RECORDS[c],
}).strict()
type ItemSchema = ReturnType<typeof itemSchema>
export const DossierItemSchema = z.discriminatedUnion("collection",
  COLLECTIONS.map(itemSchema) as unknown as [ItemSchema, ItemSchema, ...ItemSchema[]]) as unknown as z.ZodType<DossierItem>

export const DATASET_CLASSES = ClassId.options.filter((c): c is DatasetClassId => c !== "CALLS" && c !== "TELEMETRY" && c !== "OPERATOR")

const classesShape = Object.fromEntries(DATASET_CLASSES.map((k) => [k, z.array(DossierItemSchema)])) as Record<DatasetClassId, z.ZodArray<z.ZodType<DossierItem>>>

export const DanglingRef = z.object({ fromCollection: Text, fromId: Id, field: Text, id: Text }).strict()

export const Dossier = z.object({
  schemaVersion: z.literal(1),
  order: z.object({ id: Id, reference: z.string().regex(/^CD-\d{6}$/), customerId: Id }).strict(),
  asOf: IsoDateTime,
  builtAt: IsoDateTime,
  phase: z.object({ phase: Phase, basis: Text }).strict(),
  classes: z.object(classesShape).strict(),
  live: Live,
  integrity: z.object({ danglingRefs: z.array(DanglingRef) }).strict(),
}).strict().superRefine((d, ctx) => {
  // An item must sit in the class its collection belongs to, and appear once.
  const seen = new Set<string>()
  for (const cls of DATASET_CLASSES) {
    for (const item of d.classes[cls]) {
      if (COLLECTION_CLASS[item.collection] !== cls) ctx.addIssue({ code: "custom", message: `${item.collection} ${item.id} filed under ${cls}` })
      const key = `${item.collection}:${item.id}`
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: `duplicate ${key}` })
      seen.add(key)
    }
  }
})
export type Dossier = z.infer<typeof Dossier>
