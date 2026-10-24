"use client"

import type { TelemetryStripView } from "@/lib/present/types"
import { Icon } from "../icons"

const MIL_TEXT = { FLASHING: "Check-engine light flashing", ON: "Check-engine light on", OFF: "No warning light" } as const

/** What the car itself reports: warning light, codes in plain words, key values, and where the phone says it is. */
export function TelemetryStrip({ telemetry }: { telemetry: TelemetryStripView }) {
  const { mil } = telemetry
  return <section className="tstrip" aria-label="What the car reports">
    <div className="tstrip-row">
      {mil && <span className={`tstrip-mil mil-${mil.toLowerCase()}`}><span className="mil-dot" />{MIL_TEXT[mil]}</span>}
      {telemetry.codes.map((code) => <span key={code.code} className="tstrip-code" data-tone={code.tone} title={code.severity ?? undefined}>
        <b className="mono">{code.code}</b>{code.title ?? "Code not in our guide"}{code.severity && <em> · {code.severity}</em>}
      </span>)}
    </div>
    {telemetry.values.length > 0 && <dl className="tstrip-values">{telemetry.values.map((value) => <div key={value.label} data-tone={value.tone}><dt>{value.label}</dt><dd>{value.value}</dd></div>)}</dl>}
    <p className="tstrip-source">
      {telemetry.at && <>OBD dongle, simulated · <span className={telemetry.stale ? "stale" : undefined}>{telemetry.stale ? `last reading ${telemetry.ageLabel}` : telemetry.ageLabel}</span></>}
      {telemetry.position && <>{telemetry.at && " · "}<Icon name="pin" size={12} />{telemetry.position.label} <span className="muted">(phone GPS, simulated{telemetry.position.ageLabel ? `, ${telemetry.position.ageLabel}` : ""})</span></>}
      {telemetry.electric && <> · Electric car: standard OBD data is thin.</>}
      {" "}A code is a signal from the car, not a diagnosis.
    </p>
  </section>
}
