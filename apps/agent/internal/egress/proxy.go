package egress

import (
	"bufio"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Decision is one audited connection attempt.
type Decision struct {
	Time    time.Time `json:"time"`
	Client  string    `json:"client"`
	Host    string    `json:"host"`
	Port    int       `json:"port"`
	Allowed bool      `json:"allowed"`
	Reason  string    `json:"reason"`
}

// Proxy is an HTTP forward proxy (CONNECT for TLS, absolute-form for plain
// HTTP). It never terminates TLS: filtering is by destination host, port and
// resolved address, which is what the policy expresses.
type Proxy struct {
	mu       sync.RWMutex
	policy   Policy
	rules    compiled
	noUp     []rule
	upstream *upstream
	resolver *net.Resolver
	dialer   net.Dialer

	listener net.Listener
	server   *http.Server

	auditMu sync.Mutex
	audit   []Decision
	allowed atomic.Int64
	denied  atomic.Int64
}

const auditCapacity = 500

func New() *Proxy {
	p := &Proxy{resolver: net.DefaultResolver, dialer: net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}}
	_ = p.SetPolicy(Policy{Mode: "allow"})
	return p
}

func (p *Proxy) SetPolicy(policy Policy) error {
	if err := policy.Validate(); err != nil {
		return err
	}
	rules, err := compile(policy)
	if err != nil {
		return err
	}
	var noUp []rule
	for _, raw := range policy.NoUpstream {
		r, _ := parseRule(raw)
		noUp = append(noUp, r)
	}
	var up *upstream
	if policy.Upstream != "" {
		if up, err = parseUpstream(policy.Upstream); err != nil {
			return err
		}
	}
	p.mu.Lock()
	p.policy, p.rules, p.noUp, p.upstream = policy, rules, noUp, up
	p.mu.Unlock()
	return nil
}

func (p *Proxy) Policy() Policy {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.policy
}

// Listen binds the proxy. Callers pass the internal network's gateway address so
// the proxy is unreachable from any other interface.
func (p *Proxy) Listen(addr string) error {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	p.mu.Lock()
	if p.listener != nil {
		_ = p.listener.Close()
	}
	p.listener = l
	p.server = &http.Server{Handler: p, ReadHeaderTimeout: 15 * time.Second}
	server := p.server
	p.mu.Unlock()
	go func() { _ = server.Serve(l) }()
	return nil
}

func (p *Proxy) Addr() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.listener == nil {
		return ""
	}
	return p.listener.Addr().String()
}

func (p *Proxy) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.server == nil {
		return nil
	}
	err := p.server.Close()
	p.server, p.listener = nil, nil
	return err
}

// Audit returns recent decisions, newest last, plus running totals.
func (p *Proxy) Audit() ([]Decision, int64, int64) {
	p.auditMu.Lock()
	out := append([]Decision(nil), p.audit...)
	p.auditMu.Unlock()
	return out, p.allowed.Load(), p.denied.Load()
}

func (p *Proxy) record(d Decision, logAllowed bool) {
	if d.Allowed {
		p.allowed.Add(1)
		if !logAllowed {
			return
		}
	} else {
		p.denied.Add(1)
		log.Printf("egress denied client=%s host=%s port=%d reason=%s", d.Client, d.Host, d.Port, d.Reason)
	}
	p.auditMu.Lock()
	p.audit = append(p.audit, d)
	if len(p.audit) > auditCapacity {
		p.audit = p.audit[len(p.audit)-auditCapacity:]
	}
	p.auditMu.Unlock()
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.serveConnect(w, r)
		return
	}
	if r.URL.Scheme != "http" || r.URL.Host == "" {
		http.Error(w, "zakura egress proxy: only absolute http:// requests and CONNECT are supported", http.StatusBadRequest)
		return
	}
	p.serveForward(w, r)
}

// authorize resolves the destination and returns the exact address to dial, so
// the checked address and the connected address cannot differ.
func (p *Proxy) authorize(ctx context.Context, client, hostport string, defaultPort int) (string, int, []netip.Addr, error) {
	host, portText, err := net.SplitHostPort(hostport)
	if err != nil {
		host, portText = hostport, strconv.Itoa(defaultPort)
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, nil, fmt.Errorf("invalid destination port")
	}
	host = strings.Trim(host, "[]")
	var addrs []netip.Addr
	if addr, err := netip.ParseAddr(host); err == nil {
		addrs = []netip.Addr{addr.Unmap()}
	} else {
		resolved, err := p.resolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			p.mu.RLock()
			viaUpstream := p.upstream != nil && !matchesAny(p.noUp, strings.ToLower(host), port, nil)
			p.mu.RUnlock()
			if !viaUpstream {
				p.record(Decision{Time: time.Now(), Client: client, Host: host, Port: port, Reason: "dns: " + err.Error()}, true)
				return "", 0, nil, fmt.Errorf("cannot resolve %s", host)
			}
			// Behind a corporate proxy the node may not resolve public names;
			// only name rules apply and the parent proxy resolves.
		}
		for _, addr := range resolved {
			addrs = append(addrs, addr.Unmap())
		}
	}
	p.mu.RLock()
	rules, logAllowed := p.rules, p.policy.LogAllowed
	p.mu.RUnlock()
	ok, reason := rules.decide(host, port, addrs)
	p.record(Decision{Time: time.Now(), Client: client, Host: host, Port: port, Allowed: ok, Reason: reason}, logAllowed)
	if !ok {
		return "", 0, nil, fmt.Errorf("blocked by egress policy: %s", reason)
	}
	return host, port, addrs, nil
}

func (p *Proxy) dial(ctx context.Context, host string, port int, addrs []netip.Addr) (net.Conn, error) {
	p.mu.RLock()
	up, noUp := p.upstream, p.noUp
	p.mu.RUnlock()
	if up != nil && !matchesAny(noUp, strings.ToLower(host), port, addrs) {
		return up.dial(ctx, &p.dialer, net.JoinHostPort(host, strconv.Itoa(port)))
	}
	var lastErr error = errors.New("no address")
	for _, addr := range addrs {
		conn, err := p.dialer.DialContext(ctx, "tcp", net.JoinHostPort(addr.String(), strconv.Itoa(port)))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func (p *Proxy) serveConnect(w http.ResponseWriter, r *http.Request) {
	host, port, addrs, err := p.authorize(r.Context(), r.RemoteAddr, r.Host, 443)
	if err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	upstreamConn, err := p.dial(r.Context(), host, port, addrs)
	if err != nil {
		http.Error(w, "zakura egress proxy: "+err.Error(), http.StatusBadGateway)
		return
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		_ = upstreamConn.Close()
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		_ = upstreamConn.Close()
		return
	}
	_, _ = client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
	if buffered.Reader.Buffered() > 0 {
		pending, _ := buffered.Reader.Peek(buffered.Reader.Buffered())
		_, _ = upstreamConn.Write(pending)
	}
	pipe(client, upstreamConn)
}

var hopHeaders = []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade"}

func (p *Proxy) serveForward(w http.ResponseWriter, r *http.Request) {
	host, port, addrs, err := p.authorize(r.Context(), r.RemoteAddr, r.URL.Host, 80)
	if err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	transport := &http.Transport{
		DialContext:           func(ctx context.Context, _, _ string) (net.Conn, error) { return p.dial(ctx, host, port, addrs) },
		Proxy:                 nil,
		ResponseHeaderTimeout: 60 * time.Second,
	}
	defer transport.CloseIdleConnections()
	out := r.Clone(r.Context())
	out.RequestURI = ""
	for _, h := range hopHeaders {
		out.Header.Del(h)
	}
	resp, err := transport.RoundTrip(out)
	if err != nil {
		http.Error(w, "zakura egress proxy: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for _, h := range hopHeaders {
		resp.Header.Del(h)
	}
	for k, values := range resp.Header {
		for _, v := range values {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func pipe(a, b net.Conn) {
	var once sync.Once
	closeBoth := func() { _ = a.Close(); _ = b.Close() }
	go func() { _, _ = io.Copy(a, b); once.Do(closeBoth) }()
	_, _ = io.Copy(b, a)
	once.Do(closeBoth)
}

type upstream struct {
	scheme string
	addr   string
	auth   *url.Userinfo
}

func parseUpstream(raw string) (*upstream, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("invalid upstream proxy %q", raw)
	}
	switch u.Scheme {
	case "http", "socks5", "socks5h":
	default:
		return nil, fmt.Errorf("upstream proxy must be http:// or socks5://")
	}
	addr := u.Host
	if u.Port() == "" {
		addr = net.JoinHostPort(u.Hostname(), map[string]string{"http": "80", "socks5": "1080", "socks5h": "1080"}[u.Scheme])
	}
	return &upstream{scheme: u.Scheme, addr: addr, auth: u.User}, nil
}

func (u *upstream) dial(ctx context.Context, d *net.Dialer, target string) (net.Conn, error) {
	conn, err := d.DialContext(ctx, "tcp", u.addr)
	if err != nil {
		return nil, fmt.Errorf("upstream proxy: %w", err)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	}
	if u.scheme == "http" {
		err = u.httpConnect(conn, target)
	} else {
		err = u.socks5Connect(conn, target)
	}
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("upstream proxy: %w", err)
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

func (u *upstream) httpConnect(conn net.Conn, target string) error {
	req := "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n"
	if u.auth != nil {
		password, _ := u.auth.Password()
		req += "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(u.auth.Username()+":"+password)) + "\r\n"
	}
	if _, err := conn.Write([]byte(req + "\r\n")); err != nil {
		return err
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: http.MethodConnect})
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("CONNECT %s: %s", target, resp.Status)
	}
	return nil
}

func (u *upstream) socks5Connect(conn net.Conn, target string) error {
	host, portText, err := net.SplitHostPort(target)
	if err != nil {
		return err
	}
	port, _ := strconv.Atoi(portText)
	methods := []byte{0x00}
	if u.auth != nil {
		methods = []byte{0x02, 0x00}
	}
	if _, err := conn.Write(append([]byte{0x05, byte(len(methods))}, methods...)); err != nil {
		return err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return err
	}
	if reply[0] != 0x05 {
		return errors.New("socks5: bad version")
	}
	switch reply[1] {
	case 0x00:
	case 0x02:
		if u.auth == nil {
			return errors.New("socks5: authentication required")
		}
		password, _ := u.auth.Password()
		user := u.auth.Username()
		if len(user) > 255 || len(password) > 255 {
			return errors.New("socks5: credentials too long")
		}
		msg := append([]byte{0x01, byte(len(user))}, user...)
		msg = append(append(msg, byte(len(password))), password...)
		if _, err := conn.Write(msg); err != nil {
			return err
		}
		if _, err := io.ReadFull(conn, reply); err != nil {
			return err
		}
		if reply[1] != 0x00 {
			return errors.New("socks5: authentication failed")
		}
	default:
		return errors.New("socks5: no acceptable authentication method")
	}
	req := []byte{0x05, 0x01, 0x00}
	if addr, err := netip.ParseAddr(host); err == nil && addr.Is4() {
		b := addr.As4()
		req = append(append(req, 0x01), b[:]...)
	} else if err == nil {
		b := addr.As16()
		req = append(append(req, 0x04), b[:]...)
	} else {
		if len(host) > 255 {
			return errors.New("socks5: host too long")
		}
		req = append(append(req, 0x03, byte(len(host))), host...)
	}
	req = append(req, byte(port>>8), byte(port))
	if _, err := conn.Write(req); err != nil {
		return err
	}
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		return err
	}
	if head[1] != 0x00 {
		return fmt.Errorf("socks5: connect failed (code %d)", head[1])
	}
	var skip int
	switch head[3] {
	case 0x01:
		skip = 4
	case 0x04:
		skip = 16
	case 0x03:
		l := make([]byte, 1)
		if _, err := io.ReadFull(conn, l); err != nil {
			return err
		}
		skip = int(l[0])
	default:
		return errors.New("socks5: bad address type")
	}
	_, err = io.ReadFull(conn, make([]byte, skip+2))
	return err
}
