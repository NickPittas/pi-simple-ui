/** Subsequence fuzzy score: higher is better, null means no match. Case-insensitive; rewards consecutive and word-start hits. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  let score = 0, ti = 0, streak = 0
  for (const ch of q) {
    const at = t.indexOf(ch, ti)
    if (at < 0) return null
    streak = at === ti && ti > 0 ? streak + 1 : 0
    const wordStart = at === 0 || /[\s/_.:-]/.test(t[at - 1]!)
    score += 1 + streak * 2 + (wordStart ? 3 : 0) - Math.min(at - ti, 5) * 0.1
    ti = at + 1
  }
  return score - t.length * 0.01
}

/** Filters and ranks items by best fuzzy score across the given fields; stable for ties and an empty query. */
export function fuzzyFilter<T>(items: readonly T[], query: string, fields: (item: T) => readonly string[]): T[] {
  if (!query.trim()) return [...items]
  return items
    .map((item, index) => {
      const scores = fields(item).map((field) => fuzzyScore(query, field)).filter((s): s is number => s !== null)
      return { item, index, best: scores.length ? Math.max(...scores) : null }
    })
    .filter((entry): entry is { item: T; index: number; best: number } => entry.best !== null)
    .sort((a, b) => b.best - a.best || a.index - b.index)
    .map((entry) => entry.item)
}
