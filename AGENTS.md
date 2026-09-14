# Repository Rules

## Isolated feature development

- **REQUIRED:** Every new feature, behavior change, or bug fix MUST be implemented in a dedicated Git branch and a separate Git worktree.
- **NEVER** implement feature work directly on `main` (or another shared integration branch).
- Before editing source files, create the branch and worktree, then perform all edits, tests, builds, and commits from that worktree.
- Use branch names in the form `feature/<slug>`, `fix/<slug>`, or `chore/<slug>` as appropriate.
- Keep the primary checkout available for integration work; do not reuse it as the feature worktree.
- Report the branch name, worktree path, and resulting commit when delivering the change.
