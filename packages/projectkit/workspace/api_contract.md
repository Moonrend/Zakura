# Workspace repository contract

Module import: `github.com/Moonrend/Zakura/packages/projectkit/workspace`.

The repository owns content-addressed files, validated immutable manifests,
branch metadata, branch worktrees, merge plans and recovery journals. Give each
tenant/project scope its own repository directory, outside the original project.
The library does not authorize users or coordinate unrelated writes to an
original project: the runner must hold its project filesystem lock during
`ApplyToDirectory`, including recovery.

Public API (all ID arguments are immutable snapshot IDs unless named branch):

```go
New(root string, options Options) (*Repository, error)
(*Repository).Snapshot(ctx context.Context, sourceRoot string) (Snapshot, error)
(*Repository).GetSnapshot(ctx context.Context, id string) (Snapshot, error)
(*Repository).ReadSnapshot(ctx context.Context, id, path string) ([]byte, error)
(*Repository).CreateBranch(ctx context.Context, id, baseSnapshot string) (Branch, error)
(*Repository).GetBranch(ctx context.Context, id string) (Branch, error)
(*Repository).ListBranches(ctx context.Context) ([]Branch, error)
(*Repository).BranchRoot(ctx context.Context, id string) (string, error)
(*Repository).CaptureBranch(ctx context.Context, id, expectedHead string) (Snapshot, error)
(*Repository).DeleteBranch(ctx context.Context, id, expectedHead string) error
(*Repository).List(ctx context.Context, branch, path string) ([]Entry, error)
(*Repository).Read(ctx context.Context, branch, path string) ([]byte, error)
(*Repository).Write(ctx context.Context, branch, path string, content []byte, mode uint32) error
(*Repository).Remove(ctx context.Context, branch, path string) error
(*Repository).Rename(ctx context.Context, branch, oldPath, newPath string) error
(*Repository).Diff(ctx context.Context, base, target string) ([]Change, error)
(*Repository).PlanMerge(ctx context.Context, base, ours, theirs string) (MergePlan, error)
(*Repository).GetMergePlan(ctx context.Context, id string) (MergePlan, error)
(*Repository).DeleteMergePlan(ctx context.Context, id string) error
(*Repository).ApplyMerge(ctx context.Context, plan MergePlan, resolutions []Resolution, targetBranch, expectedHead string) (ApplyResult, error)
(*Repository).Compose(ctx context.Context, base string, heads []string) (Composition, error)
(*Repository).ApplyToDirectory(ctx context.Context, base, target, directory string) (ApplyResult, error)
(*Repository).Materialize(ctx context.Context, snapshot, emptyDirectory string) error
(*Repository).VerifyArtifacts(ctx context.Context, manifest ArtifactManifest) error
(*Repository).Export(ctx context.Context, snapshot string, output io.Writer) error
(*Repository).Import(ctx context.Context, input io.Reader) (Snapshot, error)
(*Repository).Recover(ctx context.Context) ([]ApplyResult, error)
(*Repository).GC(ctx context.Context, options GCOptions) (GCResult, error)
```

`CaptureBranch` commits current mutable branch files using head CAS. External
processes may write only inside the branch root while the runner holds its branch
lock. Do not capture while a process is still running. Read/write APIs reject
symlinks, special files, invalid UTF-8, traversal, Windows drive paths, NUL/control
characters and overlong paths. Snapshots contain regular files only, preserving
safe permission bits with owner-read access, so the owning runner can verify a
worktree again after a crash. Unreadable modes are rejected before installation;
empty directories are intentionally not versioned.

Merge plans retain ours at unresolved conflicts and are previews until resolved.
Resolution choices: `ours`, `theirs`, `base`, `delete`, `content`; provide the
exact conflict ID. `content` includes bytes and optional permission bits.
`Destination` can resolve rename destinations. All conflicts must be addressed,
and unsupported/duplicate resolutions fail. ApplyMerge loads the stored plan,
requires expectedHead==plan.Ours, verifies mutable worktree equals that baseline,
then atomically materializes files and commits branch metadata through a journal.

Compose merges independent heads against a common base in order. It does not
execute tasks and never claims conflicted output is runnable: consumers must
require zero conflicts. Binary files are never treated as text; rename/delete,
mode and overlapping edits become explicit conflicts.

ApplyToDirectory compares the complete current directory with base, prepares a
sibling staging tree and durable journal, then swaps directories with rollback
storage. Recovery finishes confirmed swaps or rolls back incomplete ones; it
does not rerun external tools. Call Recover before starting new runner work.
Installing into an existing directory preserves local directory access modes
and local ownership, including provable renamed files. New files inherit the
nearest existing directory owner. Portable file modes come from the target
snapshot. Ownership changes that the runner cannot perform fail during staging,
before the original tree is exchanged.
New invokes recovery for repository-owned branch journals; original-directory
journals require explicit Recover under the runner filesystem lock.

Export/import use a bounded tar containing one manifest and referenced objects.
Import validates all bytes before publishing the manifest. VerifyArtifacts
checks exact metadata against the snapshot and verifies underlying bytes.
GC preserves branch bases/heads, stored merge-plan roots, active journal roots
and explicit KeepSnapshots; age protection applies to unreferenced data.
Generated data, schema, fixtures and this documentation are not production SLOC.
