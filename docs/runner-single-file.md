# Phase 2 Runner 单文件分发评估

日期：2026-09-19

## 结论

阶段 2 采用 `bun build apps/runner/src/cli.ts --compile` 作为单文件分发方案。Bun 1.4.2 能够为三类目标生成对应平台产物；当前 Linux x64 产物已实际执行 `status`，Darwin arm64 和 Windows x64 已完成产物类型检查，需在原生主机补运行 smoke。

## 产物验证

```text
Target              Format                         Size
bun-linux-x64       ELF x86-64                     81,651,168 bytes
bun-darwin-arm64   Mach-O arm64                   62,557,170 bytes
bun-windows-x64    PE32+ x86-64                   86,425,600 bytes
```

命令：

```bash
bun build apps/runner/src/cli.ts --compile --target=bun-linux-x64 --outfile=runner-linux-x64
bun build apps/runner/src/cli.ts --compile --target=bun-darwin-arm64 --outfile=runner-darwin-arm64
bun build apps/runner/src/cli.ts --compile --target=bun-windows-x64 --outfile=runner-windows-x64.exe
```

## 仍需发布前验证

- 在 macOS arm64 和 Windows x64 原生主机运行 `status`、`connect`、`repo add` 和 daemon WebSocket smoke；
- 生成 SHA-256 checksum；
- 代码签名、安装器和自动升级不属于当前 Phase 2 功能范围。
