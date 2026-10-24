import type { NextConfig } from "next"

// One id per build, written by Next to .next/BUILD_ID and inlined into the
// browser bundle, so an open tab can tell when the server has moved on.
const buildId = `b${Date.now().toString(36)}`

const config: NextConfig = {
  devIndicators: false,
  generateBuildId: () => buildId,
  env: { ROAD_DESK_BUILD: buildId },
}

export default config
