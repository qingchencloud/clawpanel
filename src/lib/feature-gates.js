/**
 * 功能版本门控 — 向后兼容适配层
 *
 * 从 ClawPanel 0.15.0 开始，内核版本门控逻辑迁移到 `./kernel.js`，
 * 本文件仅作为 **别名**，保持旧调用代码可用而无需立刻修改所有页面。
 *
 * 新代码请直接 `import { hasFeature, onKernelChange, getKernelSnapshot } from './kernel.js'`
 *
 * 迁移指南：
 *   isFeatureAvailable(id)    → hasFeature(id)
 *   initFeatureGates()        → initKernelGates()
 *   getCachedVersion()        → getKernelSnapshot()?.version
 *   invalidateVersionCache()  → refreshKernelSnapshot()
 */
export {
  isFeatureAvailable,
  initFeatureGates,
  getCachedVersion,
  invalidateVersionCache,
  getAllFeatureStatus,
  hasFeature,
  hasFeatureStrict,
  getKernelSnapshot,
  isAboveFloor,
  onKernelChange,
  refreshKernelSnapshot,
  initKernelGates,
  parseVersion,
  versionGte,
} from './kernel.js'

// 为兼容旧代码中 `checkFeatureAvailable`（异步版）导出一个异步包装
import { hasFeature as _hasFeature } from './kernel.js'
export async function checkFeatureAvailable(featureId) {
  return _hasFeature(featureId)
}
