// A slash command's ctx.ui.notify() output carries no command id, so notifications that
// arrive shortly after a submitted "/command" are attributed to it (timing-based).
const WINDOW_MS = 20_000
const EXTEND_MS = 3_000
let until = 0

export function openCommandNoticeWindow(): void { until = Date.now() + WINDOW_MS }
export function isCommandNoticeWindowOpen(): boolean { return Date.now() < until }
export function extendCommandNoticeWindow(): void { until = Math.max(until, Date.now() + EXTEND_MS) }
