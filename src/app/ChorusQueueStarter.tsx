"use client";

import { useEffect } from "react";
import { ensureChorusDetectionStarted } from "@/lib/chorusDetectionQueue";

// Mounted once in the root layout (a Server Component, since it exports
// `metadata`) purely so every page load — create, quiz list, a live game's
// host screen — gets a chance to resume any songs still awaiting background
// chorus detection. Renders nothing.
export default function ChorusQueueStarter() {
  useEffect(() => {
    ensureChorusDetectionStarted();
  }, []);
  return null;
}
