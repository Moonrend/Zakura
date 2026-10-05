package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/config"
	platformdb "github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/db"
	"github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/migrations"
	platformserver "github.com/momo-mnsjtxy/Zakura/zakura-go-backend/internal/platform/server"
)

type requiredRoute struct{ Method, Path, Source, PriorEvidence string }

func main() {
	ref := flag.String("reference", "../zakura-rewrite/docs/ROUTE_ACCEPTANCE.md", "pinned route manifest")
	saasDir := flag.String("saas-dir", "../zakura-rewrite/packages/saas/src/server", "pinned dynamically loaded SaaS route source")
	serverDir := flag.String("server-dir", "../zakura-rewrite/apps/server/src", "pinned server source containing mounted subrouters and protocol entrypoints")
	out := flag.String("output", "docs/ROUTE_PARITY.md", "output ledger")
	flag.Parse()
	required, err := readReference(*ref)
	must(err)
	coreCount := len(required)
	saas, err := readSaaSRoutes(*saasDir)
	must(err)
	required = append(required, saas...)
	mounted, err := readMountedRoutes(*serverDir)
	must(err)
	required = append(required, mounted...)
	dir, err := os.MkdirTemp("", "zakura-routes-")
	must(err)
	defer os.RemoveAll(dir)
	conn, err := platformdb.Open(context.Background(), "file:"+filepath.Join(dir, "routes.db"))
	must(err)
	defer conn.DB.Close()
	must(migrations.Apply(context.Background(), conn.DB, conn.Dialect, conn.Rebind))
	cfg := config.Config{Secret: "0123456789abcdef0123456789abcdef", PublicURL: "http://localhost:8787", WebURL: "http://localhost:3000", Edition: "saas", MultiTenant: true}
	deps := platformserver.NewDependencies(cfg, conn.DB, conn.Dialect, conn.Rebind)
	handler := platformserver.Router(cfg, deps, slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError})))
	routes, ok := handler.(chi.Routes)
	if !ok {
		panic("router does not expose chi routes")
	}
	implemented := map[string]bool{}
	must(chi.Walk(routes, func(method, path string, h http.Handler, m ...func(http.Handler) http.Handler) error {
		implemented[key(method, path)] = true
		return nil
	}))
	tests := readTests(".")
	var b strings.Builder
	fmt.Fprintf(&b, "# Zakura Go route parity ledger\n\nGenerated from the pinned %d-row core-handler manifest plus %d routes dynamically loaded from the SaaS package and %d routes hidden behind mounted Hono subrouters. `registered` proves the native Go router exposes the method/path. `focused HTTP test` means a Go test contains a concrete URL matching the route pattern; it does not by itself claim complete semantic parity. Duplicate upstream registrations remain separate rows.\n\nThe route table is only one acceptance dimension. Non-literal/configurable protocol surfaces (Socket.IO/Engine.IO, runner-hub and desktop/terminal WebSockets, MCP Streamable HTTP, and the stdio MCP bridge) are tracked separately in `PROTOCOL_PARITY.md`.\n\n| Method | Required path | Registered | Focused HTTP test | Pinned source | Prior evidence |\n|---|---|---:|---:|---|---|\n", coreCount, len(saas), len(mounted))
	regCount, testCount := 0, 0
	for _, r := range required {
		registered := implemented[key(r.Method, r.Path)] || r.Method == "ALL" && anyMethod(implemented, r.Path) || loopExpansionImplemented(implemented, r.Method, r.Path)
		tested := routeTested(tests, r.Path)
		if registered {
			regCount++
		}
		if tested {
			testCount++
		}
		fmt.Fprintf(&b, "| %s | `%s` | %s | %s | `%s` | %s |\n", r.Method, r.Path, yesNo(registered), yesNo(tested), strings.ReplaceAll(r.Source, "|", "\\|"), strings.ReplaceAll(r.PriorEvidence, "|", "\\|"))
	}
	header := fmt.Sprintf("Required rows: **%d**; registered rows: **%d**; rows with focused Go HTTP URL evidence: **%d**.\n\n", len(required), regCount, testCount)
	text := strings.Replace(b.String(), "\n\n| Method", "\n\n"+header+"| Method", 1)
	must(os.MkdirAll(filepath.Dir(*out), 0o755))
	must(os.WriteFile(*out, []byte(text), 0o644))
	fmt.Printf("core=%d saas=%d mounted=%d required=%d registered=%d focused_test=%d\n", coreCount, len(saas), len(mounted), len(required), regCount, testCount)
}

// The original manifest was produced by matching direct app.method("/path")
// calls. Hono subrouters register short paths and are mounted later, so their
// public URLs were silently absent. Keep the mount map explicit and derive the
// leaf methods from the pinned sources so future additions cannot disappear
// from the acceptance ledger again.
func readMountedRoutes(serverDir string) ([]requiredRoute, error) {
	mounts := []struct {
		file, prefix string
	}{
		{"api/zakurabot-app-routes.ts", "/api/zakurabot"},
		{"api/zakurabot-session-routes.ts", "/api/zakurabot/sessions"},
	}
	re := regexp.MustCompile(`api\.(get|post|put|patch|delete)\("([^"]+)"`)
	seen := map[string]bool{}
	var out []requiredRoute
	for _, mount := range mounts {
		path := filepath.Join(serverDir, filepath.FromSlash(mount.file))
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		for _, match := range re.FindAllStringSubmatch(string(raw), -1) {
			method := strings.ToUpper(match[1])
			routePath := normalize(strings.TrimRight(mount.prefix, "/") + "/" + strings.TrimLeft(match[2], "/"))
			k := key(method, routePath)
			if seen[k] {
				continue
			}
			seen[k] = true
			out = append(out, requiredRoute{Method: method, Path: routePath, Source: "apps/server/src/" + mount.file, PriorEvidence: "mounted subrouter route omitted by literal manifest"})
		}
	}
	sort.Slice(out, func(i, j int) bool { return key(out[i].Method, out[i].Path) < key(out[j].Method, out[j].Path) })
	return out, nil
}

func readSaaSRoutes(dir string) ([]requiredRoute, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	re := regexp.MustCompile(`app\.(get|post|put|patch|delete)\("([^"]+)"`)
	seen := map[string]bool{}
	out := []requiredRoute{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".ts") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil, readErr
		}
		for _, match := range re.FindAllStringSubmatch(string(raw), -1) {
			method, routePath := strings.ToUpper(match[1]), normalize(match[2])
			k := key(method, routePath)
			if seen[k] {
				continue
			}
			seen[k] = true
			out = append(out, requiredRoute{Method: method, Path: routePath, Source: "packages/saas/src/server/" + entry.Name(), PriorEvidence: "dynamically loaded SaaS route"})
		}
	}
	sort.Slice(out, func(i, j int) bool { return key(out[i].Method, out[i].Path) < key(out[j].Method, out[j].Path) })
	return out, nil
}
func readReference(path string) ([]requiredRoute, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []requiredRoute
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := s.Text()
		if !strings.HasPrefix(line, "| ") {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 7 {
			continue
		}
		method := strings.TrimSpace(parts[1])
		if method != "GET" && method != "POST" && method != "PUT" && method != "PATCH" && method != "DELETE" && method != "ALL" {
			continue
		}
		path := strings.Trim(strings.TrimSpace(parts[2]), "`")
		path = normalize(path)
		out = append(out, requiredRoute{method, path, strings.Trim(strings.TrimSpace(parts[4]), "`"), strings.TrimSpace(parts[5])})
	}
	return out, s.Err()
}
func normalize(path string) string {
	re := regexp.MustCompile(`:([A-Za-z][A-Za-z0-9_]*)`)
	return re.ReplaceAllString(path, `{$1}`)
}
func key(method, path string) string { return strings.ToUpper(method) + " " + normalize(path) }
func anyMethod(routes map[string]bool, path string) bool {
	suffix := " " + normalize(path)
	for k := range routes {
		if strings.HasSuffix(k, suffix) {
			return true
		}
	}
	return false
}
func loopExpansionImplemented(routes map[string]bool, method, path string) bool {
	if !strings.Contains(path, "${action}") {
		return false
	}
	for _, action := range []string{"start", "stop", "restart", "health"} {
		if !routes[key(method, strings.Replace(path, "${action}", action, 1))] {
			return false
		}
	}
	return true
}
func readTests(root string) string {
	var paths []string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(path, "_test.go") {
			paths = append(paths, path)
		}
		return nil
	})
	sort.Strings(paths)
	var b strings.Builder
	for _, p := range paths {
		raw, _ := os.ReadFile(p)
		b.Write(raw)
		b.WriteByte('\n')
	}
	return b.String()
}
func routeTested(tests, path string) bool {
	pattern := regexp.QuoteMeta(path)
	pattern = regexp.MustCompile(`\\\{[^}]+\\\}`).ReplaceAllString(pattern, `[^\"'?[:space:]/]+`)
	pattern = strings.ReplaceAll(pattern, `\\*`, `.*`)
	return regexp.MustCompile(pattern).FindStringIndex(tests) != nil
}
func yesNo(v bool) string {
	if v {
		return "yes"
	}
	return "no"
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
