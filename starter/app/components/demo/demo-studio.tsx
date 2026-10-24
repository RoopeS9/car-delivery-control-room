"use client"

import { useCallback, useEffect, useState } from "react"
import type { CallData } from "../calls/call-section"
import { CallSimulator, DeskPhone, type PhoneFocus } from "../calls/call-simulator"
import { DriverApp } from "../../driver/driver-app"
import type { DriverJob, ThreadMessage } from "../../driver/data"
import phoneStyles from "../../driver/driver.module.css"
import { DemoPanel } from "./demo-panel"
import "./studio.css"

type Phone = { driver: { id: string; name: string }; jobs: DriverJob[]; job: DriverJob | null; thread: ThreadMessage[]; serverNow: string }

/**
 * Demo, one screen: make things happen on the left (scenarios, clock, reset),
 * watch the driver's phone in the middle, and see the calls with their
 * transcripts and claims on the right. Everything also shows on the map.
 */
export function DemoStudio({ calls, firstDriver }: { calls: CallData; firstDriver: { driverId: string; orderRef: string } | null }) {
  const [focus, setFocus] = useState<PhoneFocus | null>(firstDriver ? { kind: "driver", ...firstDriver } : null)
  const [phone, setPhone] = useState<Phone | null>(null)
  const [phoneError, setPhoneError] = useState("")

  const driverKey = focus?.kind === "driver" ? `${focus.driverId}|${focus.orderRef}` : null
  const loadPhone = useCallback(async (driverId: string, job: string | null) => {
    setPhoneError("")
    try {
      const response = await fetch(`/api/demo/driver?driver=${encodeURIComponent(driverId)}${job ? `&job=${encodeURIComponent(job)}` : ""}`, { cache: "no-store" })
      if (!response.ok) throw new Error()
      setPhone((await response.json()) as Phone)
    } catch {
      setPhoneError("The driver's phone could not be loaded.")
    }
  }, [])
  useEffect(() => {
    if (focus?.kind === "driver") void loadPhone(focus.driverId, focus.orderRef)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverKey, loadPhone])

  const onFocus = useCallback((next: PhoneFocus) => setFocus(next), [])

  return <main className="studio">
    <section className="studio-col studio-left" aria-label="Make things happen">
      <DemoPanel onFocus={(driverId, orderRef) => setFocus({ kind: "driver", driverId, orderRef: orderRef ?? "" })} />
    </section>

    <section className="studio-col studio-mid" aria-label="The phone">
      <p className="studio-caption">
        {focus?.kind === "driver" && phone ? <>{phone.driver.name}&apos;s phone{phone.job ? <> · <span className="mono">{phone.job.reference}</span></> : null}</>
          : focus?.kind === "desk" ? <>{focus.name}&apos;s phone</> : "Pick a scenario to see its phone"}
      </p>
      <div className={phoneStyles.phone}>
        {focus?.kind === "desk" ? <DeskPhone name={focus.name} call={focus.call} />
          : phone ? <DriverApp key={`${phone.driver.id}:${phone.job?.reference ?? "none"}`} driver={phone.driver} jobs={phone.jobs} job={phone.job}
            initialThread={phone.thread} serverNow={phone.serverNow} onJob={(reference) => setFocus({ kind: "driver", driverId: phone.driver.id, orderRef: reference })} />
          : <p className="studio-phone-empty">{phoneError || "Loading the phone…"}</p>}
      </div>
      <p className="studio-note">Call Road Desk opens the live VoiceChat line in a new tab. Everything else happens here and on the map.</p>
    </section>

    <section className="studio-col studio-right" aria-label="Calls">
      <CallSimulator {...calls} onFocus={onFocus} />
    </section>
  </main>
}
