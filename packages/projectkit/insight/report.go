// SPDX-License-Identifier: AGPL-3.0-or-later
package insight

import (
	"fmt"
	"strings"
)

// Markdown exports derived evidence only. It intentionally excludes prompts,
// model messages, operation arguments/results and filesystem contents.
func Markdown(run RunInsight) string {
	var out strings.Builder
	fmt.Fprintf(&out, "# Project execution evidence\n\nRun: %s\n\nProject: %s\n\nFrozen plan version: %d\n\nStatus: %s\n\n", markdownText(run.RunID), markdownText(run.ProjectID), run.PlanVersion, markdownText(run.Status))
	fmt.Fprintf(&out, "Run usage: %d tokens, %d model calls, %d tool calls.\n\n", run.Usage.Tokens, run.Usage.ModelCalls, run.Usage.ToolCalls)
	fmt.Fprintf(&out, "Unattributed usage: %d tokens, %d model calls, %d tool calls.\n\n", run.UnattributedUsage.Tokens, run.UnattributedUsage.ModelCalls, run.UnattributedUsage.ToolCalls)
	fmt.Fprintf(&out, "Event evidence: %d records; complete: %t.\n\n", run.EventCount, run.EvidenceComplete)
	fmt.Fprintf(&out, "Measured run elapsed: %s.\n\n", secondsText(run.ElapsedSeconds))
	fmt.Fprintf(&out, "Dependency critical path: %s.\n\n", markdownText(strings.Join(run.CriticalPath.TaskIDs, " → ")))
	fmt.Fprintf(&out, "Critical duration: %s; observed lower bound: %.3f s.\n\n", secondsText(run.CriticalPath.Seconds), run.CriticalPath.KnownLowerBoundSeconds)
	if len(run.CriticalPath.UnknownTaskIDs) > 0 {
		fmt.Fprintf(&out, "Unknown task durations: %s.\n\n", markdownText(strings.Join(run.CriticalPath.UnknownTaskIDs, ", ")))
	}
	out.WriteString("## Tasks\n\n| Task | Status | Execution span | Complete sample | Tokens | Model calls | Tool calls | Retries | Recoveries |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n")
	for _, task := range run.Tasks {
		fmt.Fprintf(&out, "| %s | %s | %s | %t | %d | %d | %d | %d | %d |\n", markdownText(task.SpecID), markdownText(task.Status), secondsText(task.ObservedSeconds), task.DurationComplete, task.Usage.Tokens, task.Usage.ModelCalls, task.Usage.ToolCalls, task.RetryRequests, task.Recoveries)
	}
	for _, task := range run.Tasks {
		fmt.Fprintf(&out, "\n### %s — %s\n\n", markdownText(task.SpecID), markdownText(task.Title))
		if len(task.Intervals) == 0 {
			out.WriteString("No start/end event pair is available.\n\n")
		}
		for _, interval := range task.Intervals {
			end := "open"
			if interval.End != nil {
				end = interval.End.UTC().Format("2006-01-02T15:04:05.000Z")
			}
			fmt.Fprintf(&out, "- Event %d → %d: %s → %s; %s; outcome %s.\n", interval.StartSequence, interval.EndSequence, interval.Start.UTC().Format("2006-01-02T15:04:05.000Z"), end, secondsText(interval.Seconds), markdownText(interval.Outcome))
		}
		if len(task.Intervals) > 0 {
			out.WriteByte('\n')
		}
		if task.ReviewSeconds != nil {
			fmt.Fprintf(&out, "Measured review waiting: %s.\n\n", secondsText(task.ReviewSeconds))
		}
		for _, blocker := range task.Blockers {
			fmt.Fprintf(&out, "- %s (%s): %s; chain %s.\n", markdownText(blocker.Code), markdownText(blocker.Evidence), markdownText(blocker.Message), markdownText(strings.Join(blocker.Chain, " → ")))
		}
		if len(task.Blockers) > 0 {
			out.WriteByte('\n')
		}
		for _, warning := range task.Warnings {
			fmt.Fprintf(&out, "- Evidence warning: %s.\n", markdownText(warning.Message))
		}
	}
	out.WriteString("\n## Evidence limitations\n\n")
	for _, warning := range run.Warnings {
		fmt.Fprintf(&out, "- %s: %s\n", markdownText(warning.Code), markdownText(warning.Message))
	}
	out.WriteString("\nExecution spans measure wall time from durable events. They are not CPU time or a controlled benchmark. Open, missing and reversed-clock intervals have no fabricated duration. Heartbeat timestamps are not used as execution boundaries.\n")
	return out.String()
}

func secondsText(value *float64) string {
	if value == nil {
		return "unknown"
	}
	return fmt.Sprintf("%.3f s", *value)
}
func markdownText(value string) string {
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r", " "), "\n", " ")
	replacer := strings.NewReplacer("\\", "\\\\", "|", "\\|", "<", "&lt;", ">", "&gt;", "[", "\\[", "]", "\\]", "*", "\\*", "_", "\\_", "#", "\\#")
	return replacer.Replace(value)
}
