# Repository Rules

## Isolated feature development

- **REQUIRED:** Every new feature, behavior change, or bug fix MUST be implemented in a dedicated Git branch and a separate Git worktree.
- **NEVER** implement feature work directly on `main` (or another shared integration branch).
- Before editing source files, create the branch and worktree, then perform all edits, tests, builds, and commits from that worktree.
- Use branch names in the form `feature/<slug>`, `fix/<slug>`, or `chore/<slug>` as appropriate.
- Keep the primary checkout available for integration work; do not reuse it as the feature worktree.
- Report the branch name, worktree path, and resulting commit when delivering the change.

## UI component library

- **REQUIRED:** Prefer components from the shadcn/ui library for UI work.
- If shadcn/ui does not provide a suitable component, implement a custom component and document why the shadcn/ui component was not used.
## LAN development access

- The Vite frontend dev server MUST bind to `0.0.0.0`, not loopback-only, so another device on the local network can open the UI.
- The API server used by that frontend MUST bind to a reachable interface and `PUBLIC_ORIGIN` MUST match the URL users open; otherwise login/CSRF and WebSocket proxying will fail.
- When starting the dev client, use the host's LAN address, for example `http://<lan-ip>:5173/`; do not document `localhost` as the only access URL.
- Production deployments do not use the Vite dev server; follow `docs/frontend.md` static hosting and deployment rules instead.
