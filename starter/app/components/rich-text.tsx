import { blocksOf, plainTokens, type Run } from "@/lib/present/text"

function Runs({ runs }: { runs: Run[] }) {
  return <>{runs.map((run, index) => run.bold ? <strong key={index}>{run.text}</strong> : <span key={index}>{run.text}</span>)}</>
}

/** The agent's light markdown (paragraphs, "- " bullets, **bold**) as plain elements, with code names in words. */
export function RichText({ text, className }: { text: string; className?: string }) {
  return <div className={className}>{blocksOf(plainTokens(text)).map((block, index) => block.type === "ul"
    ? <ul key={index}>{block.items.map((item, at) => <li key={at}><Runs runs={item} /></li>)}</ul>
    : <p key={index}><Runs runs={block.runs} /></p>)}</div>
}
