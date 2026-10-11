// SPDX-License-Identifier: AGPL-3.0-or-later
package mission

import "fmt"

// Scheduling is live control-plane policy, separate from a run's frozen plan.
// Weight controls relative claim opportunities, not model quality or CPU shares.
type Scheduling struct {
	Priority int `json:"priority"`
	Weight   int `json:"weight"`
}

func (s Scheduling) Normalized() Scheduling {
	if s.Weight == 0 {
		s.Weight = 1
	}
	return s
}

func (s Scheduling) Validate() error {
	if s.Priority < -20 || s.Priority > 20 {
		return fmt.Errorf("scheduling priority must be between -20 and 20")
	}
	if s.Weight < 0 || s.Weight > 100 {
		return fmt.Errorf("scheduling weight must be between 1 and 100, or zero for the default")
	}
	return nil
}

// ServiceStride uses integer virtual time. Positive priorities receive more
// opportunities but every positive weight retains a finite service stride.
func (s Scheduling) ServiceStride() (int64, error) {
	if err := s.Validate(); err != nil {
		return 0, err
	}
	s = s.Normalized()
	return 1000000 / int64(s.Weight*(s.Priority+21)), nil
}
