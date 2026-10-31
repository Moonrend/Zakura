//go:build !linux

package docker

import (
	"context"
	"fmt"
)

func GuardEgressHost(context.Context, string) error {
	return fmt.Errorf("egress host isolation requires Linux")
}
