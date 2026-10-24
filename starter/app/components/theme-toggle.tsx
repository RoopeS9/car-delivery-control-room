"use client"

import { useEffect, useState } from "react"
import { Icon } from "./icons"

type Choice = "system" | "light" | "dark"

const KEY = "cr-theme"
const NEXT: Record<Choice, Choice> = { system: "dark", dark: "light", light: "system" }
const LABEL: Record<Choice, string> = { system: "Theme: system", dark: "Theme: dark", light: "Theme: light" }

/** Runs before first paint (inlined in the layout) so a saved choice never flashes the other theme. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`

function apply(choice: Choice) {
  const root = document.documentElement
  if (choice === "system") delete root.dataset.theme
  else root.dataset.theme = choice
  try {
    if (choice === "system") localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  } catch {
    // Storage can be blocked; the theme still applies for this page view.
  }
}

/** Cycles system → dark → light. The choice is saved per browser. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>("system")

  useEffect(() => {
    const saved = document.documentElement.dataset.theme
    if (saved === "light" || saved === "dark") setChoice(saved)
  }, [])

  return <button
    type="button"
    className="theme-toggle"
    onClick={() => { const next = NEXT[choice]; apply(next); setChoice(next) }}
    aria-label={`${LABEL[choice]}. Change theme`}
    title={LABEL[choice]}
  >
    <Icon name={choice === "dark" ? "moon" : choice === "light" ? "sun" : "contrast"} size={15} />
    <span>{LABEL[choice]}</span>
  </button>
}
