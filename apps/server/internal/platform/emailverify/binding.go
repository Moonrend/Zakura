package emailverify

import (
	"encoding/json"
	"errors"
	"strings"
)

// Binding records the mutable account state an email-verification token proves.
type Binding struct {
	TargetEmail  string `json:"targetEmail"`
	EmailVersion int64  `json:"emailVersion"`
}

func Normalize(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func Encode(email string, version int64) string {
	raw, _ := json.Marshal(Binding{TargetEmail: Normalize(email), EmailVersion: version})
	return string(raw)
}

func Decode(raw string) (Binding, error) {
	var binding Binding
	if err := json.Unmarshal([]byte(raw), &binding); err != nil {
		return Binding{}, errors.New("invalid email verification binding")
	}
	if binding.TargetEmail == "" || binding.TargetEmail != Normalize(binding.TargetEmail) || binding.EmailVersion < 1 {
		return Binding{}, errors.New("invalid email verification binding")
	}
	return binding, nil
}
