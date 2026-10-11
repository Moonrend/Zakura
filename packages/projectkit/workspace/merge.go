package workspace

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// Diff describes file changes between two immutable manifests. Rename detection
// deliberately requires a unique removed/added hash match; ambiguous copies are
// reported as additions and deletions rather than guessed renames.
func (r *Repository) Diff(ctx context.Context, base, target string) (changes []Change, err error) {
	err = r.locked(ctx, func() error {
		before, e := r.getSnapshot(ctx, base)
		if e != nil {
			return e
		}
		after, e := r.getSnapshot(ctx, target)
		if e != nil {
			return e
		}
		changes = diffEntries(before.Entries, after.Entries)
		return nil
	})
	return changes, err
}

func entryIndex(entries []Entry) map[string]Entry {
	result := make(map[string]Entry, len(entries))
	for _, entry := range entries {
		result[entry.Path] = entry
	}
	return result
}

func entryPointer(entry Entry) *Entry { return &entry }

func sameEntry(a, b *Entry) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func diffEntries(before, after []Entry) []Change {
	old, next := entryIndex(before), entryIndex(after)
	removed, added := make(map[string][]Entry), make(map[string][]Entry)
	for _, entry := range before {
		if _, present := next[entry.Path]; !present {
			removed[entry.Hash] = append(removed[entry.Hash], entry)
		}
	}
	for _, entry := range after {
		if _, present := old[entry.Path]; !present {
			added[entry.Hash] = append(added[entry.Hash], entry)
		}
	}
	usedOld, usedNew := make(map[string]bool), make(map[string]bool)
	changes := make([]Change, 0)
	for hash, entries := range removed {
		matches := added[hash]
		if len(entries) == 1 && len(matches) == 1 && entries[0].Size == matches[0].Size {
			a, b := entries[0], matches[0]
			changes = append(changes, Change{Kind: "rename", Path: b.Path, OldPath: a.Path, Before: entryPointer(a), After: entryPointer(b)})
			usedOld[a.Path], usedNew[b.Path] = true, true
		}
	}
	for _, entry := range before {
		n, present := next[entry.Path]
		if !present {
			if !usedOld[entry.Path] {
				changes = append(changes, Change{Kind: "delete", Path: entry.Path, Before: entryPointer(entry)})
			}
			continue
		}
		if entry != n {
			kind := "modify"
			if entry.Hash == n.Hash && entry.Size == n.Size {
				kind = "mode"
			}
			changes = append(changes, Change{Kind: kind, Path: n.Path, Before: entryPointer(entry), After: entryPointer(n)})
		}
	}
	for _, entry := range after {
		if _, present := old[entry.Path]; !present && !usedNew[entry.Path] {
			changes = append(changes, Change{Kind: "add", Path: entry.Path, After: entryPointer(entry)})
		}
	}
	sort.Slice(changes, func(i, j int) bool {
		if changes[i].Path != changes[j].Path {
			return changes[i].Path < changes[j].Path
		}
		return changes[i].Kind < changes[j].Kind
	})
	return changes
}

type mergeItem struct {
	path                         string
	base, ours, theirs, selected *Entry
	conflict                     *Conflict
}

// sideEntries follows only provable renames and separates genuinely new files.
func sideEntries(base, side Snapshot) (map[string]*Entry, map[string]*Entry) {
	b, s := entryIndex(base.Entries), entryIndex(side.Entries)
	lineage, additions := make(map[string]*Entry), make(map[string]*Entry)
	consumed := make(map[string]bool)
	for _, change := range diffEntries(base.Entries, side.Entries) {
		if change.Kind == "rename" {
			lineage[change.OldPath] = change.After
			consumed[change.Path] = true
		}
	}
	for _, entry := range base.Entries {
		if _, moved := lineage[entry.Path]; !moved {
			if present, ok := s[entry.Path]; ok {
				lineage[entry.Path] = entryPointer(present)
			}
		}
	}
	for _, entry := range side.Entries {
		if _, present := b[entry.Path]; !present && !consumed[entry.Path] {
			additions[entry.Path] = entryPointer(entry)
		}
	}
	return lineage, additions
}

func (r *Repository) PlanMerge(ctx context.Context, base, ours, theirs string) (plan MergePlan, err error) {
	err = r.locked(ctx, func() error {
		var e error
		plan, e = r.planMerge(ctx, base, ours, theirs)
		return e
	})
	return plan, err
}

func (r *Repository) planMerge(ctx context.Context, baseID, oursID, theirsID string) (MergePlan, error) {
	base, err := r.getSnapshot(ctx, baseID)
	if err != nil {
		return MergePlan{}, err
	}
	ours, err := r.getSnapshot(ctx, oursID)
	if err != nil {
		return MergePlan{}, err
	}
	theirs, err := r.getSnapshot(ctx, theirsID)
	if err != nil {
		return MergePlan{}, err
	}
	o, oa := sideEntries(base, ours)
	t, ta := sideEntries(base, theirs)
	items := make([]*mergeItem, 0, len(base.Entries)+len(oa)+len(ta))
	budget := int64(8_000_000)
	for _, entry := range base.Entries {
		if err := ctx.Err(); err != nil {
			return MergePlan{}, err
		}
		item := &mergeItem{path: entry.Path, base: entryPointer(entry), ours: o[entry.Path], theirs: t[entry.Path]}
		if err := r.mergeEntry(ctx, item, &budget); err != nil {
			return MergePlan{}, err
		}
		items = append(items, item)
	}
	paths := make(map[string]bool)
	for path := range oa {
		paths[path] = true
	}
	for path := range ta {
		paths[path] = true
	}
	for _, path := range sortedMapKeys(paths) {
		item := &mergeItem{path: path, ours: oa[path], theirs: ta[path]}
		switch {
		case item.ours == nil:
			item.selected = item.theirs
		case item.theirs == nil || sameEntry(item.ours, item.theirs):
			item.selected = item.ours
		default:
			markConflict(item, "add/add", "")
		}
		items = append(items, item)
	}
	// A proposed rename or addition may collide with an unrelated path. Falling
	// every involved lineage back to ours makes the preview a valid manifest.
	// Each pass freezes at least one new item, so this terminates in O(files) passes.
	collisionBudget := int64(8_000_000)
	for {
		if err := ctx.Err(); err != nil {
			return MergePlan{}, err
		}
		collisionBudget -= int64(len(items))
		if collisionBudget < 0 {
			return MergePlan{}, fmt.Errorf("%w: collision propagation budget", ErrLimit)
		}
		collisions := selectedCollisions(items)
		if len(collisions) == 0 {
			break
		}
		changed := false
		for _, index := range collisions {
			item := items[index]
			if item.conflict == nil || !strings.Contains(item.conflict.Kind, "path-collision") {
				markConflict(item, "path-collision", "")
				changed = true
			}
		}
		if !changed {
			return MergePlan{}, fmt.Errorf("%w: colliding ours manifest", ErrCorrupt)
		}
	}
	entries := make([]Entry, 0, len(items))
	conflicts := make([]Conflict, 0)
	previewBudget := 16 << 20
	for _, item := range items {
		if item.selected != nil {
			entries = append(entries, *item.selected)
		}
		if item.conflict != nil {
			// File-sized previews are useful individually, but a plan with many
			// conflicts must not multiply their size into an unbounded document.
			if len(item.conflict.Preview) > previewBudget {
				item.conflict.Preview = ""
			} else {
				previewBudget -= len(item.conflict.Preview)
			}
			item.conflict.ID = conflictDigest(*item.conflict)
			conflicts = append(conflicts, *item.conflict)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	sort.Slice(conflicts, func(i, j int) bool {
		if conflicts[i].Path != conflicts[j].Path {
			return conflicts[i].Path < conflicts[j].Path
		}
		return conflicts[i].ID < conflicts[j].ID
	})
	result, err := r.saveSnapshot(ctx, entries)
	if err != nil {
		return MergePlan{}, err
	}
	plan := MergePlan{Base: baseID, Ours: oursID, Theirs: theirsID, Result: result, Conflicts: conflicts}
	if !boundedPlan(plan) {
		return MergePlan{}, fmt.Errorf("%w: merge plan size", ErrLimit)
	}
	plan.ID = planDigest(plan)
	if err := atomicJSON(filepath.Join(r.root, "plans", plan.ID+".json"), plan); err != nil {
		return MergePlan{}, err
	}
	return plan, nil
}

func sortedMapKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func markConflict(item *mergeItem, kind, preview string) {
	if item.conflict == nil {
		path := item.path
		if item.selected != nil {
			path = item.selected.Path
		}
		item.conflict = &Conflict{Kind: kind, Path: path, Base: item.base, Ours: item.ours, Theirs: item.theirs, Preview: preview}
	} else if !strings.Contains(item.conflict.Kind, kind) {
		item.conflict.Kind += "+" + kind
	}
	item.selected = item.ours
}

func selectedCollisions(items []*mergeItem) []int {
	paths := make(map[string][]int)
	for index, item := range items {
		if item.selected != nil {
			paths[item.selected.Path] = append(paths[item.selected.Path], index)
		}
	}
	bad := make(map[int]bool)
	for path, indices := range paths {
		if len(indices) > 1 {
			for _, index := range indices {
				bad[index] = true
			}
		}
		for offset := strings.IndexByte(path, '/'); offset >= 0; {
			if ancestors, present := paths[path[:offset]]; present {
				for _, index := range indices {
					bad[index] = true
				}
				for _, index := range ancestors {
					bad[index] = true
				}
			}
			next := strings.IndexByte(path[offset+1:], '/')
			if next < 0 {
				break
			}
			offset += next + 1
		}
	}
	result := make([]int, 0, len(bad))
	for index := range bad {
		result = append(result, index)
	}
	sort.Ints(result)
	return result
}

func (r *Repository) mergeEntry(ctx context.Context, item *mergeItem, budget *int64) error {
	b, o, t := item.base, item.ours, item.theirs
	switch {
	case sameEntry(o, t):
		item.selected = o
		return nil
	case sameEntry(o, b):
		item.selected = t
		return nil
	case sameEntry(t, b):
		item.selected = o
		return nil
	case o == nil || t == nil:
		kind := "delete/modify"
		if (o != nil && o.Path != b.Path) || (t != nil && t.Path != b.Path) {
			kind = "rename/delete"
		}
		markConflict(item, kind, "")
		return nil
	}
	selected := *o
	item.selected = &selected
	if o.Path != t.Path {
		switch {
		case o.Path == b.Path:
			selected.Path = t.Path
		case t.Path == b.Path:
			selected.Path = o.Path
		default:
			markConflict(item, "rename/rename", "")
		}
	}
	if o.Mode != t.Mode {
		switch {
		case o.Mode == b.Mode:
			selected.Mode = t.Mode
		case t.Mode == b.Mode:
			selected.Mode = o.Mode
		default:
			markConflict(item, "mode", "")
		}
	}
	if o.Hash != t.Hash {
		switch {
		case o.Hash == b.Hash:
			selected.Hash, selected.Size = t.Hash, t.Size
		case t.Hash == b.Hash:
			selected.Hash, selected.Size = o.Hash, o.Size
		default:
			content, kind, preview, err := r.mergeText(ctx, b, o, t, budget)
			if err != nil {
				return err
			}
			if kind != "" {
				markConflict(item, kind, preview)
				if item.conflict.Preview == "" {
					item.conflict.Preview = preview
				}
			} else {
				hash, err := r.putObject(ctx, content)
				if err != nil {
					return err
				}
				selected.Hash, selected.Size = hash, int64(len(content))
			}
		}
	}
	if item.conflict == nil {
		item.selected = &selected
	} else {
		item.selected = o
	}
	return nil
}

func conflictDigest(conflict Conflict) string {
	conflict.ID = ""
	payload, _ := json.Marshal(conflict)
	hash := sha256.Sum256(payload)
	return hex.EncodeToString(hash[:])
}

func planDigest(plan MergePlan) string {
	plan.ID = ""
	payload, _ := json.Marshal(plan)
	hash := sha256.Sum256(payload)
	return hex.EncodeToString(hash[:])
}

// Bound serialized metadata before marshaling it. Six bytes per source byte
// covers JSON escaping, and the fixed allowances cover field names and numbers.
func boundedPlan(plan MergePlan) bool {
	const limit = int64(128 << 20)
	estimated := int64(1024)
	entrySize := func(entry Entry) int64 { return 256 + 6*int64(len(entry.Path)) }
	for _, entry := range plan.Result.Entries {
		estimated += entrySize(entry)
		if estimated > limit {
			return false
		}
	}
	for _, conflict := range plan.Conflicts {
		estimated += 512 + 6*int64(len(conflict.Path)+len(conflict.Preview)+len(conflict.Kind)+len(conflict.Source))
		for _, entry := range []*Entry{conflict.Base, conflict.Ours, conflict.Theirs} {
			if entry != nil {
				estimated += entrySize(*entry)
			}
		}
		if estimated > limit {
			return false
		}
	}
	return true
}

func validMergeID(id string) bool {
	if len(id) != sha256.Size*2 {
		return false
	}
	decoded, err := hex.DecodeString(id)
	return err == nil && hex.EncodeToString(decoded) == id
}

func (r *Repository) GetMergePlan(ctx context.Context, id string) (plan MergePlan, err error) {
	err = r.locked(ctx, func() error {
		var e error
		plan, e = r.getMergePlan(ctx, id)
		return e
	})
	return plan, err
}

func (r *Repository) getMergePlan(ctx context.Context, id string) (MergePlan, error) {
	if !validMergeID(id) {
		return MergePlan{}, fmt.Errorf("%w: merge plan ID", ErrUnsafePath)
	}
	var plan MergePlan
	if err := loadJSON(filepath.Join(r.root, "plans", id+".json"), &plan); err != nil {
		return MergePlan{}, err
	}
	if plan.ID != id || planDigest(plan) != id {
		return MergePlan{}, fmt.Errorf("%w: merge plan checksum", ErrCorrupt)
	}
	manifests := make(map[string]Snapshot)
	for _, root := range []string{plan.Base, plan.Ours, plan.Theirs, plan.Result.ID} {
		if _, present := manifests[root]; present {
			continue
		}
		snapshot, err := r.getSnapshot(ctx, root)
		if err != nil {
			return MergePlan{}, err
		}
		manifests[root] = snapshot
	}
	a, _ := json.Marshal(manifests[plan.Result.ID])
	b, _ := json.Marshal(plan.Result)
	if !bytes.Equal(a, b) {
		return MergePlan{}, fmt.Errorf("%w: merge result manifest", ErrCorrupt)
	}
	seen := make(map[string]bool)
	base, ours, theirs := entryIndex(manifests[plan.Base].Entries), entryIndex(manifests[plan.Ours].Entries), entryIndex(manifests[plan.Theirs].Entries)
	for _, conflict := range plan.Conflicts {
		if err := validatePath(conflict.Path); err != nil {
			return MergePlan{}, err
		}
		if seen[conflict.ID] || conflictDigest(conflict) != conflict.ID {
			return MergePlan{}, fmt.Errorf("%w: conflict identity", ErrCorrupt)
		}
		seen[conflict.ID] = true
		for _, pair := range []struct {
			entry    *Entry
			manifest map[string]Entry
		}{{conflict.Base, base}, {conflict.Ours, ours}, {conflict.Theirs, theirs}} {
			if pair.entry != nil {
				entry, present := pair.manifest[pair.entry.Path]
				if !present || entry != *pair.entry {
					return MergePlan{}, fmt.Errorf("%w: conflict entry", ErrCorrupt)
				}
			}
		}
	}
	return plan, nil
}

// Compose merges each independent head against the common base, preserving
// conflict provenance. Its snapshot is a preview whenever Conflicts is nonempty.
func (r *Repository) Compose(ctx context.Context, base string, heads []string) (composition Composition, err error) {
	err = r.locked(ctx, func() error {
		if len(heads) > 256 {
			return fmt.Errorf("%w: composition heads", ErrLimit)
		}
		current, e := r.getSnapshot(ctx, base)
		if e != nil {
			return e
		}
		composition = Composition{Snapshot: current, Plans: []MergePlan{}, Conflicts: []Conflict{}}
		seen := make(map[string]bool)
		for _, head := range heads {
			if seen[head] {
				return fmt.Errorf("%w: duplicate composition head", ErrConflict)
			}
			seen[head] = true
			plan, e := r.planMerge(ctx, base, current.ID, head)
			if e != nil {
				return e
			}
			composition.Plans = append(composition.Plans, plan)
			for _, conflict := range plan.Conflicts {
				conflict.Source = head
				composition.Conflicts = append(composition.Conflicts, conflict)
			}
			current = plan.Result
		}
		composition.Snapshot = current
		return nil
	})
	return composition, err
}

// resolvePlan runs inside the caller's repository lock. It first removes the
// complete ours-side conflict set, then adds resolutions, so rename choices do
// not depend on caller order and never silently overwrite unrelated files.
func (r *Repository) resolvePlan(ctx context.Context, plan MergePlan, resolutions []Resolution) (Snapshot, error) {
	if len(resolutions) != len(plan.Conflicts) {
		return Snapshot{}, ErrUnresolved
	}
	byID := make(map[string]Resolution, len(resolutions))
	for _, resolution := range resolutions {
		if _, duplicate := byID[resolution.ConflictID]; duplicate {
			return Snapshot{}, fmt.Errorf("%w: duplicate resolution", ErrUnresolved)
		}
		byID[resolution.ConflictID] = resolution
	}
	entries := entryIndex(plan.Result.Entries)
	for _, conflict := range plan.Conflicts {
		if _, present := byID[conflict.ID]; !present {
			return Snapshot{}, fmt.Errorf("%w: missing conflict resolution", ErrUnresolved)
		}
		if conflict.Ours != nil {
			if entry, present := entries[conflict.Ours.Path]; present && entry == *conflict.Ours {
				delete(entries, conflict.Ours.Path)
			}
		}
	}
	for _, conflict := range plan.Conflicts {
		if err := ctx.Err(); err != nil {
			return Snapshot{}, err
		}
		resolution := byID[conflict.ID]
		var selected *Entry
		switch resolution.Choice {
		case "ours":
			selected = conflict.Ours
		case "theirs":
			selected = conflict.Theirs
		case "base":
			selected = conflict.Base
		case "delete":
			if resolution.Destination != "" {
				return Snapshot{}, fmt.Errorf("%w: delete destination", ErrUnresolved)
			}
		case "content":
			if r.opts.MaxFileBytes > 0 && int64(len(resolution.Content)) > r.opts.MaxFileBytes {
				return Snapshot{}, ErrLimit
			}
			mode, path := uint32(0644), conflict.Path
			for _, candidate := range []*Entry{conflict.Ours, conflict.Theirs, conflict.Base} {
				if candidate != nil {
					mode, path = candidate.Mode, candidate.Path
					break
				}
			}
			if resolution.Mode != 0 {
				mode = resolution.Mode
			}
			if mode & ^uint32(0777) != 0 {
				return Snapshot{}, fmt.Errorf("%w: content permission bits", ErrUnsafePath)
			}
			hash, err := r.putObject(ctx, resolution.Content)
			if err != nil {
				return Snapshot{}, err
			}
			selected = &Entry{Path: path, Hash: hash, Size: int64(len(resolution.Content)), Mode: mode}
		default:
			return Snapshot{}, fmt.Errorf("%w: unsupported resolution choice", ErrUnresolved)
		}
		if resolution.Choice != "content" && (len(resolution.Content) != 0 || resolution.Mode != 0) {
			return Snapshot{}, fmt.Errorf("%w: content fields on non-content choice", ErrUnresolved)
		}
		if selected == nil {
			if resolution.Destination != "" {
				return Snapshot{}, fmt.Errorf("%w: absent entry destination", ErrUnresolved)
			}
			continue
		}
		entry := *selected
		if resolution.Destination != "" {
			entry.Path = resolution.Destination
		}
		if err := validatePath(entry.Path); err != nil {
			return Snapshot{}, err
		}
		if _, collision := entries[entry.Path]; collision {
			return Snapshot{}, fmt.Errorf("%w: resolution path collision", ErrUnresolved)
		}
		entries[entry.Path] = entry
	}
	for _, path := range sortedMapKeys(entries) {
		parts := strings.Split(path, "/")
		for size := 1; size < len(parts); size++ {
			if _, collision := entries[strings.Join(parts[:size], "/")]; collision {
				return Snapshot{}, fmt.Errorf("%w: resolution prefix collision", ErrUnresolved)
			}
		}
	}
	result := make([]Entry, 0, len(entries))
	for _, path := range sortedMapKeys(entries) {
		result = append(result, entries[path])
	}
	return r.saveSnapshot(ctx, result)
}

type textEdit struct {
	start, end int
	lines      []string
}

func textLines(content []byte) []string {
	if len(content) == 0 {
		return nil
	}
	lines := strings.SplitAfter(string(content), "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func textual(content []byte) bool {
	if !utf8.Valid(content) {
		return false
	}
	for _, value := range content {
		if value < 32 && value != '\n' && value != '\r' && value != '\t' {
			return false
		}
	}
	return true
}

func textEdits(ctx context.Context, base, side []string, budget *int64) ([]textEdit, bool, error) {
	rows, columns := len(base)+1, len(side)+1
	cells := int64(rows) * int64(columns)
	if len(base) > 8192 || len(side) > 8192 || cells > *budget {
		return nil, false, nil
	}
	*budget -= cells
	table := make([]uint32, int(cells))
	for i := len(base) - 1; i >= 0; i-- {
		if i&127 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, false, err
			}
		}
		for j := len(side) - 1; j >= 0; j-- {
			offset := i*columns + j
			if base[i] == side[j] {
				table[offset] = table[offset+columns+1] + 1
			} else if table[offset+columns] >= table[offset+1] {
				table[offset] = table[offset+columns]
			} else {
				table[offset] = table[offset+1]
			}
		}
	}
	edits := make([]textEdit, 0)
	i, j := 0, 0
	var pending *textEdit
	flush := func() {
		if pending != nil {
			edits = append(edits, *pending)
			pending = nil
		}
	}
	for i < len(base) || j < len(side) {
		if i < len(base) && j < len(side) && base[i] == side[j] {
			flush()
			i++
			j++
			continue
		}
		if pending == nil {
			pending = &textEdit{start: i, end: i}
		}
		if i < len(base) && (j == len(side) || table[(i+1)*columns+j] >= table[i*columns+j+1]) {
			i++
			pending.end = i
		} else {
			pending.lines = append(pending.lines, side[j])
			j++
		}
	}
	flush()
	return edits, true, nil
}

func equalEdit(a, b textEdit) bool {
	if a.start != b.start || a.end != b.end || len(a.lines) != len(b.lines) {
		return false
	}
	for index := range a.lines {
		if a.lines[index] != b.lines[index] {
			return false
		}
	}
	return true
}

func overlappingEdits(a, b textEdit) bool {
	if a.start == a.end && b.start == b.end {
		return a.start == b.start
	}
	if a.start == a.end {
		return b.start < a.start && a.start < b.end
	}
	if b.start == b.end {
		return a.start < b.start && b.start < a.end
	}
	return a.start < b.end && b.start < a.end
}

func conflictPreview(base, ours, theirs []byte) string {
	clip := func(content []byte) string {
		const limit = 4096
		if len(content) <= limit {
			return string(content)
		}
		end := limit
		for end > 0 && !utf8.Valid(content[:end]) {
			end--
		}
		return string(content[:end]) + "\n[preview truncated]\n"
	}
	return "<<<<<<< ours\n" + clip(ours) + "\n||||||| base\n" + clip(base) + "\n=======\n" + clip(theirs) + "\n>>>>>>> theirs\n"
}

func (r *Repository) mergeText(ctx context.Context, base, ours, theirs *Entry, budget *int64) ([]byte, string, string, error) {
	limit := r.opts.MaxTextBytes
	if limit <= 0 {
		limit = 1 << 20
	}
	if base.Size > limit || ours.Size > limit || theirs.Size > limit {
		return nil, "text-limit", "", nil
	}
	b, err := r.readObject(base.Hash, base.Size)
	if err != nil {
		return nil, "", "", err
	}
	o, err := r.readObject(ours.Hash, ours.Size)
	if err != nil {
		return nil, "", "", err
	}
	t, err := r.readObject(theirs.Hash, theirs.Size)
	if err != nil {
		return nil, "", "", err
	}
	if !textual(b) || !textual(o) || !textual(t) {
		return nil, "binary", "", nil
	}
	lines := textLines(b)
	a, ok, err := textEdits(ctx, lines, textLines(o), budget)
	if err != nil {
		return nil, "", "", err
	}
	if !ok {
		return nil, "text-limit", conflictPreview(b, o, t), nil
	}
	c, ok, err := textEdits(ctx, lines, textLines(t), budget)
	if err != nil {
		return nil, "", "", err
	}
	if !ok {
		return nil, "text-limit", conflictPreview(b, o, t), nil
	}
	comparisons := int64(len(a)) * int64(len(c))
	if comparisons > *budget {
		return nil, "text-limit", conflictPreview(b, o, t), nil
	}
	*budget -= comparisons
	combined := append([]textEdit(nil), a...)
	for _, theirsEdit := range c {
		duplicate := false
		for _, oursEdit := range a {
			if equalEdit(oursEdit, theirsEdit) {
				duplicate = true
				break
			}
			if overlappingEdits(oursEdit, theirsEdit) {
				return nil, "text", conflictPreview(b, o, t), nil
			}
		}
		if !duplicate {
			combined = append(combined, theirsEdit)
		}
	}
	sort.Slice(combined, func(i, j int) bool {
		if combined[i].start != combined[j].start {
			return combined[i].start < combined[j].start
		}
		return combined[i].end < combined[j].end
	})
	var output bytes.Buffer
	position := 0
	for _, edit := range combined {
		if edit.start < position {
			return nil, "text", conflictPreview(b, o, t), nil
		}
		for _, line := range lines[position:edit.start] {
			output.WriteString(line)
		}
		for _, line := range edit.lines {
			output.WriteString(line)
		}
		position = edit.end
		if int64(output.Len()) > limit || (r.opts.MaxFileBytes > 0 && int64(output.Len()) > r.opts.MaxFileBytes) {
			return nil, "text-limit", "", nil
		}
	}
	for _, line := range lines[position:] {
		output.WriteString(line)
	}
	if int64(output.Len()) > limit || (r.opts.MaxFileBytes > 0 && int64(output.Len()) > r.opts.MaxFileBytes) {
		return nil, "text-limit", "", nil
	}
	return output.Bytes(), "", "", nil
}
