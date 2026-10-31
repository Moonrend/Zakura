package docker

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
)

// Egress control: containers join an internal Docker network that has no route
// out of the host. The only way out is the node's filtering proxy, bound on that
// network's gateway, which enforces the administrator's policy.

const EgressNetworkName = "zakura-egress"

// EgressBridge is the host interface of the internal network. A fixed name lets
// the node firewall it: containers may reach the proxy port and nothing else on
// the host (an internal network still routes to services bound on the gateway).
const EgressBridge = "zk-egress0"

var (
	egressMu    sync.RWMutex
	egressNet   string
	egressProxy string
)

// SetEgress records the active internal network and proxy address. An empty
// network disables enforcement (containers use the default bridge).
func SetEgress(network, proxyURL string) {
	egressMu.Lock()
	egressNet, egressProxy = network, proxyURL
	egressMu.Unlock()
}

func egressNetwork() string {
	egressMu.RLock()
	defer egressMu.RUnlock()
	return egressNet
}

func egressProxyEnv() map[string]string {
	egressMu.RLock()
	defer egressMu.RUnlock()
	if egressProxy == "" {
		return nil
	}
	env := map[string]string{}
	for _, key := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"} {
		env[key] = egressProxy
	}
	// Only loopback bypasses the proxy: the internal network has no other route.
	noProxy := "localhost,127.0.0.1,::1"
	env["NO_PROXY"], env["no_proxy"] = noProxy, noProxy
	return env
}

// EnsureEgressNetwork creates the internal network if needed and returns its
// gateway address, where the node binds the proxy.
func EnsureEgressNetwork(ctx context.Context) (string, error) {
	if err := Require(); err != nil {
		return "", err
	}
	gateway, err := egressGateway(ctx)
	if err == nil && gateway != "" {
		return gateway, nil
	}
	out, err := exec.CommandContext(ctx, dockerBin(), "network", "create", "--driver", "bridge", "--internal",
		"--label", "zakura.purpose=egress", "-o", "com.docker.network.bridge.enable_icc=false",
		"-o", "com.docker.network.bridge.name="+EgressBridge, EgressNetworkName).CombinedOutput()
	if err != nil && !strings.Contains(string(out), "already exists") {
		return "", fmt.Errorf("create egress network: %s", strings.TrimSpace(string(out)))
	}
	return egressGateway(ctx)
}

func egressGateway(ctx context.Context) (string, error) {
	out, err := exec.CommandContext(ctx, dockerBin(), "network", "inspect", "-f", "{{.Internal}} {{range .IPAM.Config}}{{.Gateway}}{{end}}", EgressNetworkName).Output()
	if err != nil {
		return "", err
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) != 2 || fields[0] != "true" {
		return "", fmt.Errorf("network %s exists but is not internal", EgressNetworkName)
	}
	return fields[1], nil
}
