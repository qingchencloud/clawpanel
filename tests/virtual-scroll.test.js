import { describe, it, expect } from 'vitest'
import { buildPrefixHeights, computeVirtualRange, getSpacerHeights } from '../src/lib/virtual-scroll.js'

describe('virtual scroll helpers', () => {
  it('builds prefix heights with avg fallback', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const heights = new Map([['b', 80]])
    const prefix = buildPrefixHeights(items, heights, 50)
    expect(prefix).toEqual([0, 50, 130, 180])
  })

  it('computes range with window cap', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: String(i) }))
    const heights = new Map()
    const { start, end } = computeVirtualRange(items, 0, 600, 30, 20, 40, heights)
    expect(end - start).toBeLessThanOrEqual(80)
  })

  it('spacer heights sum to total', () => {
    const prefix = [0, 50, 100, 150]
    const { top, bottom, total } = getSpacerHeights(prefix, 1, 2)
    expect(top + bottom + (prefix[2] - prefix[1])).toBe(total)
  })
})
