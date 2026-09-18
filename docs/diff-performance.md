# Diff 性能基准

日期：2026-09-19

基准命令：

```bash
node --import tsx scripts/benchmark-diff.mjs
```

结果：

```json
{
  "fileCount": 50,
  "additions": 3000,
  "patchBytes": 99560,
  "elapsedMs": 1.36,
  "passed": true
}
```

结论：当前 `parseUnifiedDiff` 在 50 个文件、3000 行新增 patch 上远低于 1 秒交互前解析门槛，不切换到 `@git-diff-view/react`。该脚本是解析基准，不等同于浏览器 GPU、React 挂载和真实首屏交互基准；浏览器性能回归仍应在发布前用实际构建产物复测。
