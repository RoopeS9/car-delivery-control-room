// Cut streamed text into speakable sentences so speech can start before the
// reply is finished. Strips anything that does not read aloud (markdown,
// lists). Safety tags ([[CALL_112]]) count as their own sentence.

const ABBREVIATIONS = /\b(Mr|Mrs|Ms|Dr|St|No|approx|e\.g|i\.e|etc)\.$/i

export function cleanSpoken(text: string): string {
  return text
    .replace(/[*_#`>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
}

export class SentenceSplitter {
  private buffer = ""

  /** Feed a delta; returns the sentences completed by it. */
  push(delta: string): string[] {
    this.buffer += delta
    const out: string[] = []
    for (;;) {
      const tag = this.buffer.match(/\[\[[A-Z_0-9\s]+\]\]/)
      const end = this.findEnd()
      if (tag && tag.index !== undefined && (end === -1 || tag.index < end)) {
        const before = cleanSpoken(this.buffer.slice(0, tag.index))
        if (before) out.push(before)
        out.push(tag[0])
        this.buffer = this.buffer.slice(tag.index + tag[0].length)
        continue
      }
      if (end === -1) break
      const sentence = cleanSpoken(this.buffer.slice(0, end + 1))
      this.buffer = this.buffer.slice(end + 1)
      if (sentence) out.push(sentence)
    }
    return out
  }

  /** Whatever is left when the stream ends. */
  flush(): string[] {
    const rest = cleanSpoken(this.buffer)
    this.buffer = ""
    return rest ? [rest] : []
  }

  private findEnd(): number {
    const pattern = /[.!?](?=\s|$)/g
    for (const match of this.buffer.matchAll(pattern)) {
      const index = match.index ?? 0
      // Need the following whitespace to be sure the sentence is over.
      if (index + 1 >= this.buffer.length) return -1
      const head = this.buffer.slice(0, index + 1)
      if (ABBREVIATIONS.test(head)) continue
      if (cleanSpoken(head).length < 8) continue
      return index
    }
    return -1
  }
}
