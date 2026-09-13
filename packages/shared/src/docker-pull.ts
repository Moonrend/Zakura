/** Docker layer progress shared by local Docker and remote Go runners. */
export interface DockerPullEvent {
  id?: string;
  status?: string;
  progress?: string;
  progressDetail?: { current?: number; total?: number };
  error?: string;
  errorDetail?: { message?: string };
  zakura?: {
    phase?: "queued" | "pulling" | "present";
    image?: string;
    deduplicated?: boolean;
  };
}
