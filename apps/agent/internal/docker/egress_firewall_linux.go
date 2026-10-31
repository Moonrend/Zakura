//go:build linux

package docker

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// GuardEgressHost confines traffic arriving from the internal network at the
// host itself: only the proxy port is accepted, everything else (sshd, the
// control plane, databases bound on all interfaces) is dropped. Forwarded
// traffic is already blocked by Docker for internal networks.
func GuardEgressHost(ctx context.Context, proxyPort string) error {
	rules := [][]string{
		{"-i", EgressBridge, "-p", "tcp", "--dport", proxyPort, "-j", "ACCEPT"},
		{"-i", EgressBridge, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"},
		{"-i", EgressBridge, "-j", "DROP"},
	}
	for _, binary := range []string{"iptables", "ip6tables"} {
		if _, err := exec.LookPath(binary); err != nil {
			if binary == "iptables" {
				return fmt.Errorf("iptables is required to isolate the egress network from host services")
			}
			continue
		}
		// Insert in reverse so the final order is ACCEPT proxy, ACCEPT related, DROP.
		for i := len(rules) - 1; i >= 0; i-- {
			rule := rules[i]
			if exec.CommandContext(ctx, binary, append([]string{"-C", "INPUT"}, rule...)...).Run() == nil {
				continue
			}
			if out, err := exec.CommandContext(ctx, binary, append([]string{"-I", "INPUT", "1"}, rule...)...).CombinedOutput(); err != nil {
				return fmt.Errorf("%s: %s", binary, strings.TrimSpace(string(out)))
			}
		}
	}
	return nil
}
