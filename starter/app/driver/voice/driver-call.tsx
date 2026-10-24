"use client"

import { useEffect } from "react"
import { CallScreen, type CallScreenProps } from "./call-screen"

/** Only a mounted call screen claims the driver; Next's link prefetch does not. */
export function DriverCall(props: CallScreenProps) {
  useEffect(() => {
    void fetch("/api/sim/driver", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ human: props.driverId }),
    }).catch(() => undefined)
  }, [props.driverId])
  return <CallScreen {...props} />
}
