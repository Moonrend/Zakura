package contextpack

import (
	"errors"
	"testing"
)

func TestIndependentContextRequestFieldsMustEachBeValidUTF8(t *testing.T) {
	req := request()
	// These bytes concatenate to a valid Chinese code point. They are not
	// valid independent query and prompt strings and must not be accepted.
	req.Query = "\xe4"
	req.Prompt = "\xb8\xad"
	if err := Validate(req); !errors.Is(err, ErrInvalid) {
		t.Fatalf("separately invalid UTF-8 request fields accepted: %v", err)
	}
}
