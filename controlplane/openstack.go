package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gophercloud/gophercloud/v2"
	"github.com/gophercloud/gophercloud/v2/openstack"
	"github.com/gophercloud/gophercloud/v2/openstack/compute/v2/flavors"
	"github.com/gophercloud/gophercloud/v2/openstack/compute/v2/keypairs"
	"github.com/gophercloud/gophercloud/v2/openstack/compute/v2/servers"
	"github.com/gophercloud/gophercloud/v2/openstack/networking/v2/extensions/security/groups"
	"github.com/gophercloud/gophercloud/v2/openstack/networking/v2/networks"
	"github.com/gophercloud/gophercloud/v2/openstack/networking/v2/ports"
	"github.com/gophercloud/gophercloud/v2/pagination"
	"gopkg.in/yaml.v3"
)

type Provisioner interface {
	CreateSandbox(ctx context.Context, req CreateReq) (*SandboxResources, error)
	DeleteSandbox(ctx context.Context, serverID, portID string) error
	GetServer(ctx context.Context, serverID string) (status string, err error)
	ListSandboxPorts(ctx context.Context) ([]SandboxPort, error)
	FindSandboxResources(ctx context.Context, team string) (*SandboxResources, error)
	ListSandboxServers(ctx context.Context) ([]SandboxServer, error)
}

var ErrOpenStackNotFound = errors.New("OpenStack resource not found")
var ErrFixedIPInUse = errors.New("Neutron fixed IP is already in use")

type SandboxServer struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type SandboxPort struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	DeviceID string   `json:"device_id"`
	FixedIPs []string `json:"fixed_ips"`
}

type CreateReq struct {
	SandboxID    string `json:"sandbox_id,omitempty"`
	Team         string `json:"team,omitempty"`
	FixedIP      string `json:"-"`
	CustomDomain string `json:"custom_domain,omitempty"`
	TTL          int64  `json:"ttl,omitempty"`
}

type SandboxResources struct {
	ServerID               string `json:"server_id"`
	PortID                 string `json:"port_id"`
	FixedIP                string `json:"fixed_ip"`
	PortDurationMS         int64  `json:"-"`
	ServerCreateDurationMS int64  `json:"-"`
}

type ProvisionConfig struct {
	NetworkID     string
	NetworkName   string
	SubnetID      string
	SecurityGroup string
	Image         string
	Flavor        string
	Keypair       string
	Timeout       time.Duration
	MaxConcurrent int
}

type MockProvisioner struct {
	mu          sync.Mutex
	CreateErr   error
	ConflictIPs map[string]bool
	Created     int
	Statuses    []string
	StatusErr   error
	Deleted     []string
	NextIP      func() string
	Calls       map[string]int
	Failures    map[string]map[int]error
	Servers     map[string]bool
	Ports       []SandboxPort
}

func (m *MockProvisioner) failLocked(step string) error {
	if m.Calls == nil {
		m.Calls = map[string]int{}
	}
	m.Calls[step]++
	if byCall := m.Failures[step]; byCall != nil {
		return byCall[m.Calls[step]]
	}
	return nil
}

func (m *MockProvisioner) FailStep(step string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.failLocked(step)
}

func (m *MockProvisioner) CreateSandbox(_ context.Context, req CreateReq) (*SandboxResources, error) {
	m.mu.Lock()
	m.Created++
	if err := m.failLocked("create"); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	if m.ConflictIPs[req.FixedIP] {
		m.mu.Unlock()
		return nil, ErrFixedIPInUse
	}
	createErr := m.CreateErr
	m.mu.Unlock()
	if createErr != nil {
		return nil, createErr
	}
	ip := req.FixedIP
	if ip == "" {
		ip = "10.20.30.10"
	}
	if req.FixedIP == "" && m.NextIP != nil {
		ip = m.NextIP()
	}
	serverID, portID := "mock-server-"+req.Team, "mock-port-"+req.Team
	m.mu.Lock()
	if m.Servers == nil {
		m.Servers = map[string]bool{}
	}
	m.Servers[serverID] = true
	m.Ports = append(m.Ports, SandboxPort{ID: portID, Name: "sandbox-" + req.Team, DeviceID: serverID, FixedIPs: []string{ip}})
	m.mu.Unlock()
	return &SandboxResources{ServerID: serverID, PortID: portID, FixedIP: ip, PortDurationMS: 11, ServerCreateDurationMS: 22}, nil
}
func (m *MockProvisioner) DeleteSandbox(_ context.Context, serverID, portID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Deleted = append(m.Deleted, serverID, portID)
	if serverID != "" {
		if err := m.failLocked("delete_server"); err != nil {
			return err
		}
		delete(m.Servers, serverID)
	}
	if portID != "" {
		if err := m.failLocked("delete_port"); err != nil {
			return err
		}
		filtered := m.Ports[:0]
		for _, port := range m.Ports {
			if port.ID != portID {
				filtered = append(filtered, port)
			}
		}
		m.Ports = filtered
	}
	return nil
}
func (m *MockProvisioner) GetServer(_ context.Context, serverID string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.failLocked("get_server"); err != nil {
		return "", err
	}
	if m.Servers != nil && !m.Servers[serverID] {
		return "", ErrOpenStackNotFound
	}
	if m.StatusErr != nil {
		return "", m.StatusErr
	}
	if len(m.Statuses) == 0 {
		return "ACTIVE", nil
	}
	status := m.Statuses[0]
	if len(m.Statuses) > 1 {
		m.Statuses = m.Statuses[1:]
	}
	return status, nil
}

func (m *MockProvisioner) ListSandboxPorts(context.Context) ([]SandboxPort, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.failLocked("list_ports"); err != nil {
		return nil, err
	}
	ports := make([]SandboxPort, len(m.Ports))
	copy(ports, m.Ports)
	for i := range ports {
		ports[i].FixedIPs = append([]string(nil), ports[i].FixedIPs...)
	}
	return ports, nil
}

func (m *MockProvisioner) FindSandboxResources(_ context.Context, team string) (*SandboxResources, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	name := "sandbox-" + team
	resources := &SandboxResources{}
	for _, port := range m.Ports {
		if port.Name == name {
			resources.PortID = port.ID
			resources.FixedIP = firstFixedIP(port.FixedIPs)
			resources.ServerID = port.DeviceID
			return resources, nil
		}
	}
	if serverID := "mock-server-" + team; m.Servers[serverID] {
		resources.ServerID = serverID
		return resources, nil
	}
	return nil, ErrOpenStackNotFound
}

func (m *MockProvisioner) ListSandboxServers(context.Context) ([]SandboxServer, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var found []SandboxServer
	for id, exists := range m.Servers {
		if !exists || !strings.HasPrefix(id, "mock-server-") {
			continue
		}
		team := strings.TrimPrefix(id, "mock-server-")
		found = append(found, SandboxServer{ID: id, Name: "sandbox-" + team, Status: "ACTIVE"})
	}
	return found, nil
}

type OpenStackProvisioner struct {
	mu              sync.Mutex
	compute         *gophercloud.ServiceClient
	network         *gophercloud.ServiceClient
	cfg             ProvisionConfig
	securityGroupID string
}

var provisioner Provisioner
var provisionConfig ProvisionConfig
var provisionTimeout = 180 * time.Second
var provisionSemaphore chan struct{}
var mockFailStep string
var mockFailTeamPrefix string
var mockProvisionDelay time.Duration

func configureMockFailures(lookupEnv func(string) string) error {
	step := strings.TrimSpace(lookupEnv("MOCK_FAIL_STEP"))
	switch step {
	case "", "create", "server_error", "health", "sync", "timeout":
	default:
		return fmt.Errorf("MOCK_FAIL_STEP must be create, server_error, health, sync, timeout, or empty")
	}
	delay := time.Duration(0)
	if raw := strings.TrimSpace(lookupEnv("MOCK_PROVISION_DELAY_MS")); raw != "" {
		ms, err := strconv.Atoi(raw)
		if err != nil || ms < 0 || ms > 60000 {
			return fmt.Errorf("MOCK_PROVISION_DELAY_MS must be an integer from 0 to 60000")
		}
		delay = time.Duration(ms) * time.Millisecond
	}
	mockFailStep = step
	mockFailTeamPrefix = strings.TrimSpace(lookupEnv("MOCK_FAIL_TEAM_PREFIX"))
	mockProvisionDelay = delay
	return nil
}

func mockFailureMatches(team, step string) bool {
	return os.Getenv("PROVISIONER") == "mock" && mockFailStep == step &&
		(mockFailTeamPrefix == "" || strings.HasPrefix(team, mockFailTeamPrefix))
}

func loadProvisionConfig() (ProvisionConfig, error) {
	get := func(k string) string { return strings.TrimSpace(os.Getenv(k)) }
	netID := get("SANDBOX_NETWORK_ID")
	if netID == "" {
		netID = "7d1b48ee-0b28-449b-aba4-869364e72623"
	}
	netName := get("SANDBOX_NETWORK_NAME")
	if netName == "" {
		netName = "felcloud-sandbox"
	}
	subID := get("SANDBOX_SUBNET_ID")
	if subID == "" {
		subID = "e23529ba-f4f1-44ce-a2a2-3c9b788b9fbd"
	}
	sgName := get("SANDBOX_SG_NAME")
	if sgName == "" {
		sgName = "sg-sandbox"
	}
	img := get("SANDBOX_IMAGE")
	if img == "" {
		img = "a049a501-f812-4e6c-9c07-61aa3b08bb50"
	}
	flv := get("SANDBOX_FLAVOR")
	if flv == "" {
		flv = "1001"
	}
	kp := get("SANDBOX_KEYPAIR")
	if kp == "" {
		kp = "felcloud-resilient-v2"
	}
	cfg := ProvisionConfig{NetworkID: netID, NetworkName: netName, SubnetID: subID, SecurityGroup: sgName, Image: img, Flavor: flv, Keypair: kp, Timeout: 180 * time.Second, MaxConcurrent: 8}
	if v := get("PROVISION_TIMEOUT_SECONDS"); v != "" {
		n, e := strconv.Atoi(v)
		if e != nil || n < 1 || int64(n) > int64(^uint64(0)>>1)/int64(time.Second) {
			return cfg, fmt.Errorf("PROVISION_TIMEOUT_SECONDS must be a positive integer")
		}
		cfg.Timeout = time.Duration(n) * time.Second
	}
	if v := get("MAX_CONCURRENT_PROVISIONS"); v != "" {
		n, e := strconv.Atoi(v)
		if e != nil || n < 1 || n > 1024 {
			return cfg, fmt.Errorf("MAX_CONCURRENT_PROVISIONS must be an integer from 1 to 1024")
		}
		cfg.MaxConcurrent = n
	}
	if cfg.NetworkID == "" && cfg.NetworkName == "" {
		return cfg, errors.New("SANDBOX_NETWORK_ID or SANDBOX_NETWORK_NAME is required")
	}
	if cfg.SubnetID == "" || cfg.Image == "" || cfg.Flavor == "" || cfg.Keypair == "" {
		return cfg, errors.New("SANDBOX_SUBNET_ID, SANDBOX_IMAGE, SANDBOX_FLAVOR, and SANDBOX_KEYPAIR are required")
	}
	return cfg, nil
}

func configureProvisioner(ctx context.Context) error {
	if err := configureHealthProbe(); err != nil {
		return err
	}
	if err := configureHealthProbeTimeout(); err != nil {
		return err
	}
	if os.Getenv("PROVISIONER") == "mock" {
		if err := configureMockFailures(os.Getenv); err != nil {
			return err
		}
		healthProbeMode = "skip"
		provisioner = &MockProvisioner{}
		gatewaySyncFunc = func(bool) (bool, string) { return true, "mock gateway sync" }
		provisionTimeout = 180 * time.Second
		if v := os.Getenv("PROVISION_TIMEOUT_SECONDS"); v != "" {
			n, e := strconv.Atoi(v)
			if e != nil || n < 1 || int64(n) > int64(^uint64(0)>>1)/int64(time.Second) {
				return fmt.Errorf("PROVISION_TIMEOUT_SECONDS must be a positive integer")
			}
			provisionTimeout = time.Duration(n) * time.Second
		}
		max := 8
		if v := os.Getenv("MAX_CONCURRENT_PROVISIONS"); v != "" {
			n, e := strconv.Atoi(v)
			if e != nil || n < 1 || n > 1024 {
				return fmt.Errorf("MAX_CONCURRENT_PROVISIONS must be an integer from 1 to 1024")
			}
			max = n
		}
		provisionSemaphore = make(chan struct{}, max)
		return nil
	}
	gatewaySyncFunc = func(dryRun bool) (bool, string) { return syncHAProxyDualGateways(dryRun) }
	cfg, err := loadProvisionConfig()
	if err != nil {
		return err
	}
	p, err := newOpenStackProvisioner(ctx, cfg)
	if err != nil {
		return err
	}
	provisionConfig = cfg
	provisionTimeout = cfg.Timeout
	provisionSemaphore = make(chan struct{}, cfg.MaxConcurrent)
	provisioner = p
	return nil
}

func configureHealthProbeTimeout() error {
	healthProbeTimeout = 90 * time.Second
	v := strings.TrimSpace(os.Getenv("HEALTH_PROBE_TIMEOUT_SECONDS"))
	if v == "" {
		return nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || int64(n) > int64(^uint64(0)>>1)/int64(time.Second) {
		return errors.New("HEALTH_PROBE_TIMEOUT_SECONDS must be a positive integer")
	}
	healthProbeTimeout = time.Duration(n) * time.Second
	return nil
}

// authFromEnvironment supports OS_* variables and a named cloud from clouds.yaml.
func authFromEnvironment() (gophercloud.AuthOptions, string, error) {
	if os.Getenv("OS_AUTH_URL") != "" {
		opts, e := openstack.AuthOptionsFromEnv()
		if e != nil {
			return opts, "", fmt.Errorf("OpenStack environment auth: %w", e)
		}
		if projectDomain := os.Getenv("OS_PROJECT_DOMAIN_NAME"); projectDomain != "" && os.Getenv("OS_PROJECT_NAME") != "" {
			opts.Scope = &gophercloud.AuthScope{ProjectName: os.Getenv("OS_PROJECT_NAME"), DomainName: projectDomain}
		}
		return opts, os.Getenv("OS_REGION_NAME"), nil
	}
	cloudName := os.Getenv("OS_CLOUD")
	if cloudName == "" {
		cloudName = "felcloud"
	}
	paths := []string{filepath.Join(os.Getenv("HOME"), ".config/openstack/clouds.yaml"), "/etc/openstack/clouds.yaml"}
	if p := os.Getenv("OS_CLIENT_CONFIG_FILE"); p != "" {
		paths = append([]string{p}, paths...)
	}
	var doc struct {
		Clouds map[string]struct {
			Auth      map[string]string `yaml:"auth"`
			Region    string            `yaml:"region_name"`
			Interface string            `yaml:"interface"`
		} `yaml:"clouds"`
	}
	for _, p := range paths {
		data, e := os.ReadFile(p)
		if e != nil {
			continue
		}
		if yaml.Unmarshal(data, &doc) != nil {
			continue
		}
		c, ok := doc.Clouds[cloudName]
		if !ok {
			continue
		}
		a := c.Auth
		opts := gophercloud.AuthOptions{
			IdentityEndpoint:            a["auth_url"],
			Username:                    a["username"],
			Password:                    a["password"],
			TenantID:                    a["project_id"],
			TenantName:                  a["project_name"],
			DomainName:                  a["user_domain_name"],
			ApplicationCredentialID:     a["application_credential_id"],
			ApplicationCredentialName:   a["application_credential_name"],
			ApplicationCredentialSecret: a["application_credential_secret"],
			AllowReauth:                 true,
		}
		if a["project_domain_name"] != "" && a["project_name"] != "" {
			opts.Scope = &gophercloud.AuthScope{ProjectName: a["project_name"], DomainName: a["project_domain_name"]}
		}
		passwordAuth := opts.Username != "" && opts.Password != ""
		appCredentialAuth := opts.ApplicationCredentialID != "" && opts.ApplicationCredentialSecret != ""
		if opts.IdentityEndpoint == "" || (!passwordAuth && !appCredentialAuth) {
			return opts, "", errors.New("clouds.yaml auth requires auth_url and either username/password or application credential ID/secret")
		}
		return opts, c.Region, nil
	}
	return gophercloud.AuthOptions{}, "", fmt.Errorf("cloud %q not found in clouds.yaml", cloudName)
}

func newOpenStackProvisioner(ctx context.Context, cfg ProvisionConfig) (*OpenStackProvisioner, error) {
	auth, region, err := authFromEnvironment()
	if err != nil {
		return nil, err
	}
	provider, err := openstack.AuthenticatedClient(ctx, auth)
	if err != nil {
		return nil, fmt.Errorf("OpenStack Keystone authentication failed: %w", err)
	}
	if v := os.Getenv("OS_REGION_NAME"); v != "" {
		region = v
	}
	endpoint := gophercloud.EndpointOpts{Region: region}
	compute, err := openstack.NewComputeV2(provider, endpoint)
	if err != nil {
		return nil, fmt.Errorf("Nova endpoint: %w", err)
	}
	network, err := openstack.NewNetworkV2(provider, endpoint)
	if err != nil {
		return nil, fmt.Errorf("Neutron endpoint: %w", err)
	}
	p := &OpenStackProvisioner{compute: compute, network: network, cfg: cfg}
	if cfg.NetworkID == "" {
		pager := networks.List(network, networks.ListOpts{Name: cfg.NetworkName})
		err = pager.EachPage(ctx, func(_ context.Context, page pagination.Page) (bool, error) {
			list, e := networks.ExtractNetworks(page)
			if e != nil {
				return false, e
			}
			for _, n := range list {
				if n.Name == cfg.NetworkName {
					p.cfg.NetworkID = n.ID
					return false, nil
				}
			}
			return true, nil
		})
		if err != nil {
			return nil, fmt.Errorf("resolve sandbox network: %w", err)
		}
		if p.cfg.NetworkID == "" {
			return nil, fmt.Errorf("sandbox network %q not found", cfg.NetworkName)
		}
	}
	_ = p.resolveFlavor(ctx)
	return p, nil
}

func (p *OpenStackProvisioner) resolveFlavor(ctx context.Context) error {
	pages, err := flavors.ListDetail(p.compute, flavors.ListOpts{}).AllPages(ctx)
	if err != nil {
		return err
	}
	flist, err := flavors.ExtractFlavors(pages)
	if err != nil {
		return err
	}
	for _, f := range flist {
		if f.Name == p.cfg.Flavor {
			p.cfg.Flavor = f.ID
			return nil
		}
	}
	return nil
}

func (p *OpenStackProvisioner) resolveSecurityGroup(ctx context.Context) (string, error) {
	var id string
	err := groups.List(p.network, groups.ListOpts{Name: p.cfg.SecurityGroup}).EachPage(ctx, func(_ context.Context, page pagination.Page) (bool, error) {
		gs, e := groups.ExtractGroups(page)
		if e != nil {
			return false, e
		}
		for _, g := range gs {
			if g.Name == p.cfg.SecurityGroup {
				id = g.ID
				return false, nil
			}
		}
		return true, nil
	})
	if err != nil {
		return "", err
	}
	if id == "" {
		return "", fmt.Errorf("security group %q not found", p.cfg.SecurityGroup)
	}
	return id, nil
}

func cloudInitHTTP() []byte {
	// Input-independent script: team names never enter cloud-init or shell syntax.
	// systemd unit survives reboots; no package install (sandbox network has no internet).
	script := `#cloud-config
write_files:
  - path: /etc/systemd/system/sandbox-http.service
    content: |
      [Unit]
      Description=Sandbox HTTP
      After=network.target
      [Service]
      ExecStart=/usr/bin/python3 -m http.server 80 --directory /var/www/sandbox
      Restart=always
      [Install]
      WantedBy=multi-user.target
runcmd:
  - |
    mkdir -p /var/www/sandbox
    ip=""
    for i in $(seq 1 30); do
      ip=$(hostname -I | awk '{print $1}')
      [ -n "$ip" ] && break
      sleep 1
    done
    echo "FelCloud sandbox ready ($ip)" > /var/www/sandbox/index.html
  - [systemctl, daemon-reload]
  - [systemctl, enable, --now, sandbox-http.service]
`
	return []byte(script)
}

func (p *OpenStackProvisioner) CreateSandbox(ctx context.Context, req CreateReq) (*SandboxResources, error) {
	p.mu.Lock()
	if p.securityGroupID == "" {
		id, e := p.resolveSecurityGroup(ctx)
		if e != nil {
			p.mu.Unlock()
			return nil, e
		}
		p.securityGroupID = id
	}
	securityGroupID := p.securityGroupID
	p.mu.Unlock()
	sec := []string{securityGroupID}
	up := true
	portStart := time.Now()
	pr := ports.Create(ctx, p.network, ports.CreateOpts{NetworkID: p.cfg.NetworkID, Name: "sandbox-" + req.Team, AdminStateUp: &up, FixedIPs: []map[string]string{{"subnet_id": p.cfg.SubnetID, "ip_address": req.FixedIP}}, SecurityGroups: &sec})
	port, err := pr.Extract()
	if err != nil {
		if gophercloud.ResponseCodeIs(err, http.StatusConflict) || strings.Contains(strings.ToLower(err.Error()), "ipaddressinuse") {
			return nil, fmt.Errorf("%w: %v", ErrFixedIPInUse, err)
		}
		return nil, fmt.Errorf("create neutron port: %w", err)
	}
	portDuration := time.Since(portStart).Milliseconds()
	fixedIP := ""
	if len(port.FixedIPs) > 0 {
		fixedIP = port.FixedIPs[0].IPAddress
	}
	if fixedIP == "" {
		return &SandboxResources{PortID: port.ID, PortDurationMS: portDuration}, errors.New("Neutron port did not return a fixed IP")
	}
	createOpts := servers.CreateOpts{Name: "sandbox-" + req.Team, ImageRef: p.cfg.Image, FlavorRef: p.cfg.Flavor, Networks: []servers.Network{{Port: port.ID}}, UserData: cloudInitHTTP()}
	serverCreateStart := time.Now()
	res := servers.Create(ctx, p.compute, keypairs.CreateOptsExt{CreateOptsBuilder: createOpts, KeyName: p.cfg.Keypair}, nil)
	serverCreateDuration := time.Since(serverCreateStart).Milliseconds()
	srv, err := res.Extract()
	if err != nil {
		return &SandboxResources{PortID: port.ID, FixedIP: fixedIP, PortDurationMS: portDuration, ServerCreateDurationMS: serverCreateDuration}, fmt.Errorf("create nova server: %w", err)
	}
	return &SandboxResources{ServerID: srv.ID, PortID: port.ID, FixedIP: fixedIP, PortDurationMS: portDuration, ServerCreateDurationMS: serverCreateDuration}, nil
}

func (p *OpenStackProvisioner) DeleteSandbox(ctx context.Context, serverID, portID string) error {
	var errs []error
	if serverID != "" {
		err := servers.Delete(ctx, p.compute, serverID).ExtractErr()
		if err != nil && !gophercloud.ResponseCodeIs(err, 404) {
			errs = append(errs, err)
		}
	}
	if portID != "" {
		err := ports.Delete(ctx, p.network, portID).ExtractErr()
		if err != nil && !gophercloud.ResponseCodeIs(err, 404) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
func (p *OpenStackProvisioner) GetServer(ctx context.Context, serverID string) (string, error) {
	r := servers.Get(ctx, p.compute, serverID)
	s, e := r.Extract()
	if e != nil {
		if gophercloud.ResponseCodeIs(e, 404) {
			return "", ErrOpenStackNotFound
		}
		return "", e
	}
	return s.Status, nil
}

func (p *OpenStackProvisioner) ListSandboxPorts(ctx context.Context) ([]SandboxPort, error) {
	var found []SandboxPort
	err := ports.List(p.network, ports.ListOpts{NetworkID: p.cfg.NetworkID}).EachPage(ctx, func(_ context.Context, page pagination.Page) (bool, error) {
		list, err := ports.ExtractPorts(page)
		if err != nil {
			return false, err
		}
		for _, port := range list {
			entry := SandboxPort{ID: port.ID, Name: port.Name, DeviceID: port.DeviceID}
			for _, fixed := range port.FixedIPs {
				entry.FixedIPs = append(entry.FixedIPs, fixed.IPAddress)
			}
			found = append(found, entry)
		}
		return true, nil
	})
	return found, err
}

func (p *OpenStackProvisioner) FindSandboxResources(ctx context.Context, team string) (*SandboxResources, error) {
	name := "sandbox-" + team
	resources := &SandboxResources{}
	ports, err := p.ListSandboxPorts(ctx)
	if err != nil {
		return nil, err
	}
	for _, port := range ports {
		if port.Name == name {
			resources.PortID = port.ID
			resources.FixedIP = firstFixedIP(port.FixedIPs)
			resources.ServerID = port.DeviceID
			break
		}
	}
	serversFound, err := p.ListSandboxServers(ctx)
	if err != nil {
		return nil, err
	}
	for _, server := range serversFound {
		if server.Name == name {
			resources.ServerID = server.ID
			break
		}
	}
	if resources.ServerID == "" && resources.PortID == "" {
		return nil, ErrOpenStackNotFound
	}
	return resources, nil
}

func (p *OpenStackProvisioner) ListSandboxServers(ctx context.Context) ([]SandboxServer, error) {
	var found []SandboxServer
	err := servers.List(p.compute, servers.ListOpts{}).EachPage(ctx, func(_ context.Context, page pagination.Page) (bool, error) {
		list, err := servers.ExtractServers(page)
		if err != nil {
			return false, err
		}
		for _, server := range list {
			if strings.HasPrefix(server.Name, "sandbox-") {
				found = append(found, SandboxServer{ID: server.ID, Name: server.Name, Status: server.Status})
			}
		}
		return true, nil
	})
	return found, err
}
