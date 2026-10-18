// Command check-results prints go test -json output and rejects incomplete,
// failed, skipped, malformed, or empty required test results. No external tools
// or PostgreSQL connections are needed.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: check-results results.json")
		os.Exit(2)
	}
	file, err := os.Open(os.Args[1])
	if err == nil {
		defer file.Close()
		err = checkResults(file, os.Stdout)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Required PostgreSQL suite:", err)
		os.Exit(1)
	}
}

func checkResults(input io.Reader, output io.Writer) error {
	decoder := json.NewDecoder(input)
	passed := 0
	skipped, failed := false, false
	packages := map[string]bool{}
	for {
		var event struct {
			Action  string
			Package string
			Test    string
			Output  string
		}
		if err := decoder.Decode(&event); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return fmt.Errorf("invalid go test JSON: %w", err)
		}
		if _, err := io.WriteString(output, event.Output); err != nil {
			return err
		}
		if event.Package != "" {
			if _, seen := packages[event.Package]; !seen {
				packages[event.Package] = false
			}
		}
		switch event.Action {
		case "skip":
			skipped = true
		case "fail":
			failed = true
		case "pass":
			if event.Test != "" {
				passed++
			} else if event.Package != "" {
				packages[event.Package] = true
			}
		}
	}
	if skipped {
		return errors.New("skipped a required test or package")
	}
	if failed {
		return errors.New("test or package failed")
	}
	if passed == 0 {
		return errors.New("ran no passing tests")
	}
	if len(packages) == 0 {
		return errors.New("missing package results")
	}
	for name, completed := range packages {
		if !completed {
			return fmt.Errorf("package %s did not complete successfully", name)
		}
	}
	return nil
}
