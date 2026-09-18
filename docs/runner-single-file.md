# Phase 2 Runner 单文件分发评估

日期：2026-09-18

## 结论

阶段 2 采用 `bun build apps/runner/src/cli.ts --compile` 作为 Linux x64 单文件分发候选。当前方案在 Node.js 22、Bun 1.4.2 和 Linux x64 上完成编译与启动 smoke；暂不切换 Node SEA。

## 验证

```text
node --version                       v22.23.2
bun --version                        1.4.2
bun build ... --compile              成功
产物                                  ELF x86-64，约 81.7 MB
产物 status                          成功输出 Runner 配置
```

## 取舍

- 优点：命令简单、能把 TypeScript/依赖打进单文件、当前 Runner 的 Node 22 运行路径无需改代码。
- 代价：产物体积约 81.7 MB；编译产物是平台相关 ELF，必须按 Linux/macOS/Windows 分别构建；Bun 仍是发布构建工具，Runner 运行时不依赖 Bun。
- 暂不做：跨平台矩阵、签名、自动更新、npm 包与单文件安装器并行发布。这些属于发布工程，不阻塞阶段 2 功能收口。

## 发布门槛

正式发布前仍需在每个目标平台执行 `connect`、`repo add`、`status`、daemon WebSocket 连接和 Agent 进程启动 smoke；生产构建固定 Bun 版本并保存平台产物 checksum。
