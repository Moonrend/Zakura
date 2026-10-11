# Project merge signoff API

All paths below are relative to `/project-executions/{projectId}`. They inherit
the existing project/tenant/space authorization. Voting, withdrawal and policy
configuration require a human session; API keys and OAuth cannot vote. This
feature applies only to final immutable merge artifacts, not task reviews.

```ts
type SignoffRules = {
  minApprovals: number; // 1..10
  eligibleReviewerIds: string[]; // <=32 active tenant users; [] means any eligible role
  eligibleRoles: ('owner'|'admin'|'member')[];
  disallowProjectCreator: boolean;
  expirySeconds: number; // 0 disabled, otherwise <=604800
};
type SignoffPolicy = SignoffRules & {
  revision: number; hash: string; configured: boolean;
  updatedBy?: string; updatedAt?: string;
};
type SignoffMember = { userId: string; name: string; role: string };
type SignoffBinding = {
  previewId: string; runId: string; snapshotId: string; evidenceHash: string;
};
type SignoffVote = {
  id: string; userId: string; role: string; policyHash: string;
  policyRevision: number; binding: SignoffBinding; previewRevision: number;
  decision: 'approved'|'rejected'; comment: string; status: 'active'|'withdrawn';
  sequence: number; createdAt: string; withdrawnAt?: string;
  withdrawalSequence?: number;
};
type SignoffEvidence = {
  policyRevision: number; policyHash: string; binding: SignoffBinding; required: number;
  participants: { userId: string; voteId: string; createdAt: string; snapshotId: string }[];
};
type SignoffSummary = {
  policy: SignoffPolicy; binding: SignoffBinding; approvals: number; required: number;
  eligibleCount: number; quorum: boolean; rejected: boolean; canReachQuorum: boolean;
  evaluatedAt: string; evidence?: SignoffEvidence; legacyApproval?: boolean;
  votes: (SignoffVote & { counted: boolean; reason:
    'counted'|'withdrawn'|'policy_changed'|'artifact_changed'|'future_timestamp'|
    'expired'|'inactive_member'|'ineligible_member'|'duplicate_reviewer'|
    'rejected'|'invalid_decision' })[];
};
```

- `GET /review-policy` returns `{policy,members,membersTruncated,currentUserId,currentRole,humanSession,canConfigure}`.
  Default unconfigured policy has revision 0, minApprovals 1, all human roles.
  Members is the first 500 active users, sorted by ID. A truncated list is
  explicitly indicated; configured reviewer IDs remain visible in the policy.
- `PUT /review-policy` body is `{...SignoffRules,expectedRevision}`. Owner/admin
  human only, including a fresh database role check. Returns
  `{policy,resetPreviews:number}`. Insufficient active eligible reviewers reject
  the update. Each change increments policy revision, changes its hash and bumps
  every ready/approved preview revision. Their approval proof is cleared and
  status becomes ready. Votes and policy versions remain in audit history.
- `GET /review-policy/history` returns the latest 100 policy versions, newest first.
- `GET /merges/{previewId}/signoffs?runId={runId}` returns
  `{preview:ProjectMergePreview,summary:SignoffSummary}` from one read snapshot.
  Historical pre-policy receipts with no vote records report `legacyApproval:true`;
  their single approval counts only while the original human remains active and
  eligible. No vote timestamp or aggregate evidence is invented. First policy
  configuration clears these old receipts just like current single approvals.
- `POST /merges/{previewId}/signoffs?runId={runId}` body
  `{expectedRevision,snapshotId,policyHash,decision:'approved'|'rejected',comment}`.
  Comment required, <=16000 bytes. Returns updated `ProjectMergePreview`.
  First positive vote keeps ready until quorum. A negative vote rejects the
  preview permanently; create a new preview to request another review. Current active reviewer eligibility, artifact checks and requirements
  are checked in the same project mutation transaction.
- `POST /merges/{previewId}/signoffs/{voteId}/withdraw?runId={runId}` body
  `{expectedRevision,snapshotId,policyHash}`. Only the vote's human owner may
  withdraw, and only while preview is ready/approved. Returns updated preview;
  losing quorum clears receipt/evidence and returns ready. Repeated withdrawal
  fails. Applying/applied/unknown are immutable effect histories.

Every mutation uses exact current preview revision and policy hash; a conflict
requires refresh and renewed user confirmation, never an automatic retry with
new revisions. `ProjectMergePreview.reviewEvidence` is the aggregate evidence;
it is included in delivery metadata as **unsigned, untrusted provenance**. It
cannot approve an import. Source publication rechecks quorum/expiry/member
eligibility under transaction locks, even if preview status is approved.
Historical snapshots already applying/applied remain historical under policy
changes. Policy updates do not modify task approval behavior or send messages.
