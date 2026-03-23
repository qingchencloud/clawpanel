export function getItemHeight(items, idx, heights, avgHeight) {
  const id = items[idx]?.id
  return heights.get(id) || avgHeight
}

export function buildPrefixHeights(items, heights, avgHeight) {
  const prefix = [0]
  for (let i = 0; i < items.length; i++) {
    prefix[i + 1] = prefix[i] + getItemHeight(items, i, heights, avgHeight)
  }
  return prefix
}

export function findStartIndex(prefix, scrollTop) {
  let lo = 0, hi = prefix.length - 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (prefix[mid] <= scrollTop) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, lo - 1)
}

export function computeVirtualRange(items, scrollTop, viewportHeight, avgHeight, overscan, windowSize, heights) {
  const prefix = buildPrefixHeights(items, heights, avgHeight)
  const start = Math.max(0, findStartIndex(prefix, scrollTop) - overscan)
  const end = Math.min(items.length, start + windowSize + overscan * 2)
  return { start, end, prefix }
}

export function getSpacerHeights(prefix, start, end) {
  const top = prefix[start]
  const total = prefix[prefix.length - 1]
  const bottom = Math.max(0, total - prefix[end])
  return { top, bottom, total }
}
