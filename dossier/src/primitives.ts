// Scalar types shared by every schema. Each one rejects anything outside its format.
import { z } from "zod"

/** ISO 8601 instant with an explicit offset or Z. All dataset times are UTC. */
export const IsoDateTime = z.string().datetime({ offset: true })
export type IsoDateTime = z.infer<typeof IsoDateTime>
/** Calendar date, YYYY-MM-DD. */
export const IsoDate = z.string().date()
/** IANA time zone such as Europe/Helsinki. */
export const IanaZone = z.string().regex(/^[A-Z][a-z]+\/[A-Za-z_]+$/)
/** Opening hours range, HH:MM-HH:MM, local to the site's zone. */
export const HoursRange = z.string().regex(/^\d\d:\d\d-\d\d:\d\d$/)
/** Record id: a lowercase slug with at least one dash. Whether it resolves is checked against the loaded index. */
export const Id = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/)
export type Id = z.infer<typeof Id>
/** Free text written by a person or system: messages, notes, summaries. Never parsed for facts by code. */
export const Text = z.string()
