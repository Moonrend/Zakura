package workspace

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}

type contextWriter struct {
	ctx    context.Context
	writer io.Writer
}

func (w contextWriter) Write(buffer []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	return w.writer.Write(buffer)
}

func (r *Repository) Export(ctx context.Context, id string, output io.Writer) error {
	if output == nil {
		return errors.New("workspace: archive writer is required")
	}
	return r.locked(ctx, func() error {
		snapshot, err := r.getSnapshot(ctx, id)
		if err != nil {
			return err
		}
		writer := tar.NewWriter(contextWriter{ctx, output})
		manifest, err := json.Marshal(snapshot)
		if err != nil {
			return err
		}
		if err = writer.WriteHeader(&tar.Header{Name: "manifest.json", Mode: 0600, Size: int64(len(manifest)), Typeflag: tar.TypeReg}); err != nil {
			return err
		}
		if _, err = writer.Write(manifest); err != nil {
			return err
		}
		objects := map[string]int64{}
		for _, entry := range snapshot.Entries {
			objects[entry.Hash] = entry.Size
		}
		hashes := make([]string, 0, len(objects))
		for hash := range objects {
			hashes = append(hashes, hash)
		}
		sort.Strings(hashes)
		for _, hash := range hashes {
			data, err := r.readObject(hash, objects[hash])
			if err != nil {
				return err
			}
			if err = writer.WriteHeader(&tar.Header{Name: "objects/" + hash, Mode: 0600, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
				return err
			}
			if _, err = writer.Write(data); err != nil {
				return err
			}
		}
		return writer.Close()
	})
}

func (r *Repository) Import(ctx context.Context, input io.Reader) (snapshot Snapshot, err error) {
	if input == nil {
		return Snapshot{}, errors.New("workspace: archive reader is required")
	}
	err = r.locked(ctx, func() error {
		temporary, e := os.MkdirTemp(filepath.Join(r.root, "tmp"), "import-")
		if e != nil {
			return e
		}
		defer os.RemoveAll(temporary)
		// Logical file bytes bound object payload; per-entry metadata and tar
		// headers have separate bounded overhead. No archive entry is extracted.
		overhead := int64(r.opts.MaxFiles)*(int64(r.opts.MaxPathBytes)+1024) + 1<<20
		if overhead < 0 || overhead > 256<<20 {
			overhead = 256 << 20
		}
		budget := r.opts.MaxTotalBytes + overhead
		if budget < r.opts.MaxTotalBytes {
			return ErrLimit
		}
		bounded := &io.LimitedReader{R: contextReader{ctx, input}, N: budget + 1}
		reader := tar.NewReader(bounded)
		header, e := reader.Next()
		if e != nil {
			return e
		}
		if header.Name != "manifest.json" || header.Typeflag != tar.TypeReg || header.Size < 0 || header.Size > overhead {
			return ErrCorrupt
		}
		manifest, e := io.ReadAll(io.LimitReader(reader, header.Size+1))
		if e != nil {
			return e
		}
		decoder := json.NewDecoder(strings.NewReader(string(manifest)))
		decoder.DisallowUnknownFields()
		if e = decoder.Decode(&snapshot); e != nil {
			return ErrCorrupt
		}
		var trailing any
		if decoder.Decode(&trailing) != io.EOF {
			return ErrCorrupt
		}
		total, e := r.validateEntriesContext(ctx, snapshot.Entries, false)
		if e != nil {
			return e
		}
		for i := 1; i < len(snapshot.Entries); i++ {
			if snapshot.Entries[i-1].Path >= snapshot.Entries[i].Path {
				return ErrCorrupt
			}
		}
		if !validHash(snapshot.ID) || snapshot.TotalBytes != total || snapshotHash(snapshot.Entries, total) != snapshot.ID {
			return ErrCorrupt
		}
		expected := map[string]int64{}
		for _, entry := range snapshot.Entries {
			if size, exists := expected[entry.Hash]; exists && size != entry.Size {
				return ErrCorrupt
			}
			expected[entry.Hash] = entry.Size
		}
		seen := map[string]bool{}
		for {
			header, e = reader.Next()
			if e == io.EOF {
				break
			}
			if e != nil {
				return e
			}
			if header.Typeflag != tar.TypeReg || !strings.HasPrefix(header.Name, "objects/") {
				return ErrCorrupt
			}
			hash := strings.TrimPrefix(header.Name, "objects/")
			size, exists := expected[hash]
			if !exists || !validHash(hash) || seen[hash] || header.Size != size {
				return ErrCorrupt
			}
			data, e := io.ReadAll(io.LimitReader(reader, size+1))
			if e != nil {
				return e
			}
			if int64(len(data)) != size || hashBytes(data) != hash {
				return ErrCorrupt
			}
			if e = atomicBytes(filepath.Join(temporary, hash), data, 0600); e != nil {
				return e
			}
			seen[hash] = true
		}
		if len(seen) != len(expected) || bounded.N <= 0 {
			return ErrCorrupt
		}
		// The complete archive was verified above. Publishing object bytes may
		// leave harmless unreferenced objects on a crash; the manifest is last.
		for hash, size := range expected {
			if e := ctx.Err(); e != nil {
				return e
			}
			data, e := os.ReadFile(filepath.Join(temporary, hash))
			if e != nil {
				return e
			}
			if int64(len(data)) != size || hashBytes(data) != hash {
				return ErrCorrupt
			}
			if _, e = r.putObject(ctx, data); e != nil {
				return e
			}
		}
		stored, e := r.saveSnapshot(ctx, snapshot.Entries)
		if e != nil {
			return e
		}
		if stored.ID != snapshot.ID {
			return ErrCorrupt
		}
		snapshot = stored
		return nil
	})
	if err != nil {
		return Snapshot{}, err
	}
	return
}
