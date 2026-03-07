---
description: 发布新版本（打 tag + 推送，触发跨平台构建）
---

## 发布前检查

1. 确认所有改动已提交，工作区干净：
```bash
git status
```

2. 确认 CI 全部通过（main 分支绿灯）

3. 更新版本号（一条命令自动同步 package.json → tauri.conf.json → Cargo.toml → docs/index.html）：
// turbo
```bash
npm run version:set 1.2.3
```

4. 更新 `CHANGELOG.md`，在顶部加入本次版本的变更记录

5. 提交版本更新：
```bash
git add -A
git commit -m "chore: release v1.2.3"
git push origin main
```

## 打 tag 并触发发布

```bash
git tag v1.2.3
git push origin v1.2.3
```

推送 tag 后，GitHub Actions 会自动：
- 并行构建 macOS ARM64 / macOS Intel / Linux / Windows 四个平台
- 创建 GitHub Release 并上传安装包
- 所有平台构建完成后统一写入 Release Notes

## 查看构建进度

前往仓库 **Actions** 页面，找到 `Release` 工作流查看实时日志。

## 手动触发（不打 tag）

在 GitHub Actions 页面手动触发 `Release` 工作流，输入版本号（如 `v1.2.3`）。

## 发布后验证

- [ ] Release 页面出现四个平台的安装包
- [ ] Release Notes 内容正确（有下载表格 + changelog）
- [ ] 下载 Windows EXE 安装验证可用
- [ ] `latest` 标签指向新 Release

## 回滚

如果发布有问题，在 GitHub Releases 页面将该 Release 设为 Draft 或删除，然后修复后重新打 tag：
```bash
git tag -d v1.2.3
git push origin :refs/tags/v1.2.3
# 修复问题后
git tag v1.2.3
git push origin v1.2.3
```
