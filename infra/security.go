package main

import (
	"fmt"

	"github.com/pulumi/pulumi-openstack/sdk/v5/go/openstack/networking"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

// SecurityOutputs holds references to the gateway, sandbox, management, and control-plane groups.
type SecurityOutputs struct {
	GatewaySecGroup      *networking.SecGroup
	SandboxSecGroup      *networking.SecGroup
	MgmtSecGroup         *networking.SecGroup
	ControlPlaneSecGroup *networking.SecGroup
}

// CreateSecurityGroups provisions the gateway, sandbox, management, and control-plane groups.
func CreateSecurityGroups(ctx *pulumi.Context, cfg *Config) (*SecurityOutputs, error) {
	// 1. sg-gateway: 80/443 open; 22 closed by default; VRRP protocol between GW1<->GW2 edge ports
	sgGateway, err := networking.NewSecGroup(ctx, "sg-gateway", &networking.SecGroupArgs{
		Name:        pulumi.String("sg-gateway"),
		Description: pulumi.String("Security group for edge gateways GW1 and GW2"),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create sg-gateway: %w", err)
	}

	// Ingress HTTP (80/tcp)
	_, err = networking.NewSecGroupRule(ctx, "sg-gateway-rule-http", &networking.SecGroupRuleArgs{
		SecurityGroupId: sgGateway.ID(),
		Direction:       pulumi.String("ingress"),
		Ethertype:       pulumi.String("IPv4"),
		Protocol:        pulumi.String("tcp"),
		PortRangeMin:    pulumi.Int(80),
		PortRangeMax:    pulumi.Int(80),
		RemoteIpPrefix:  pulumi.String("0.0.0.0/0"),
		Description:     pulumi.String("Allow inbound HTTP from internet"),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create sg-gateway HTTP rule: %w", err)
	}

	// Ingress HTTPS (443/tcp)
	_, err = networking.NewSecGroupRule(ctx, "sg-gateway-rule-https", &networking.SecGroupRuleArgs{
		SecurityGroupId: sgGateway.ID(),
		Direction:       pulumi.String("ingress"),
		Ethertype:       pulumi.String("IPv4"),
		Protocol:        pulumi.String("tcp"),
		PortRangeMin:    pulumi.Int(443),
		PortRangeMax:    pulumi.Int(443),
		RemoteIpPrefix:  pulumi.String("0.0.0.0/0"),
		Description:     pulumi.String("Allow inbound HTTPS from internet"),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create sg-gateway HTTPS rule: %w", err)
	}

	// VRRP Protocol (protocol 112 / vrrp) between edge ports
	_, err = networking.NewSecGroupRule(ctx, "sg-gateway-rule-vrrp", &networking.SecGroupRuleArgs{
		SecurityGroupId: sgGateway.ID(),
		Direction:       pulumi.String("ingress"),
		Ethertype:       pulumi.String("IPv4"),
		Protocol:        pulumi.String("vrrp"),
		RemoteIpPrefix:  pulumi.String(cfg.EdgeCIDR),
		Description:     pulumi.String("Allow VRRP between gateway edge ports"),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create sg-gateway VRRP rule: %w", err)
	}

	// Optional / Conditional SSH for sg-gateway
	if cfg.AdminSSHCIDR != "" {
		_, err = networking.NewSecGroupRule(ctx, "sg-gateway-rule-ssh", &networking.SecGroupRuleArgs{
			SecurityGroupId: sgGateway.ID(),
			Direction:       pulumi.String("ingress"),
			Ethertype:       pulumi.String("IPv4"),
			Protocol:        pulumi.String("tcp"),
			PortRangeMin:    pulumi.Int(22),
			PortRangeMax:    pulumi.Int(22),
			RemoteIpPrefix:  pulumi.String(cfg.AdminSSHCIDR),
			Description:     pulumi.String("Temporary admin SSH access"),
		})
		if err != nil {
			return nil, fmt.Errorf("failed to create sg-gateway SSH rule: %w", err)
		}
	}

	// 2. sg-sandbox: gateway-only ingress and explicit DNS/web/gateway egress.
	sgSandbox, err := networking.NewSecGroup(ctx, "sg-sandbox", &networking.SecGroupArgs{
		Name:               pulumi.String("sg-sandbox"),
		Description:        pulumi.String("Security group for isolated sandbox VMs"),
		DeleteDefaultRules: pulumi.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create sg-sandbox: %w", err)
	}

	// Ingress 8080/tcp from gateway security group only
	_, err = networking.NewSecGroupRule(ctx, "sg-sandbox-rule-http8080-from-gw", &networking.SecGroupRuleArgs{
		SecurityGroupId: sgSandbox.ID(),
		Direction:       pulumi.String("ingress"),
		Ethertype:       pulumi.String("IPv4"),
		Protocol:        pulumi.String("tcp"),
		PortRangeMin:    pulumi.Int(8080),
		PortRangeMax:    pulumi.Int(8080),
		RemoteGroupId:   sgGateway.ID(),
		Description:     pulumi.String("Allow 8080 only from gateway instances"),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create sg-sandbox 8080 rule: %w", err)
	}

	// Ingress 80/tcp from gateway security group
	_, err = networking.NewSecGroupRule(ctx, "sg-sandbox-rule-http80-from-gw", &networking.SecGroupRuleArgs{
		SecurityGroupId: sgSandbox.ID(),
		Direction:       pulumi.String("ingress"),
		Ethertype:       pulumi.String("IPv4"),
		Protocol:        pulumi.String("tcp"),
		PortRangeMin:    pulumi.Int(80),
		PortRangeMax:    pulumi.Int(80),
		RemoteGroupId:   sgGateway.ID(),
		Description:     pulumi.String("Allow HTTP port 80 from gateway instances"),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create sg-sandbox HTTP 80 rule: %w", err)
	}

	// Explicit sandbox egress allowlist. The gateway-group rule excludes management
	// ports because sg-gateway is attached only to gateway edge/sandbox ports.
	sandboxEgressRules := []struct {
		name        string
		protocol    string
		port        int
		remoteCIDR  string
		description string
	}{
		{name: "dns-udp", protocol: "udp", port: 53, remoteCIDR: "0.0.0.0/0", description: "Sandbox DNS queries"},
		{name: "dns-tcp", protocol: "tcp", port: 53, remoteCIDR: "0.0.0.0/0", description: "Sandbox DNS TCP queries"},
		{name: "http", protocol: "tcp", port: 80, remoteCIDR: "0.0.0.0/0", description: "Sandbox HTTP package mirrors"},
		{name: "https", protocol: "tcp", port: 443, remoteCIDR: "0.0.0.0/0", description: "Sandbox HTTPS package mirrors"},
	}
	for _, rule := range sandboxEgressRules {
		_, err = networking.NewSecGroupRule(ctx, "sg-sandbox-egress-"+rule.name, &networking.SecGroupRuleArgs{
			SecurityGroupId: sgSandbox.ID(),
			Direction:       pulumi.String("egress"),
			Ethertype:       pulumi.String("IPv4"),
			Protocol:        pulumi.String(rule.protocol),
			PortRangeMin:    pulumi.Int(rule.port),
			PortRangeMax:    pulumi.Int(rule.port),
			RemoteIpPrefix:  pulumi.String(rule.remoteCIDR),
			Description:     pulumi.String(rule.description),
		})
		if err != nil {
			return nil, fmt.Errorf("failed to create sg-sandbox %s egress rule: %w", rule.name, err)
		}
	}
	_, err = networking.NewSecGroupRule(ctx, "sg-sandbox-egress-gateways", &networking.SecGroupRuleArgs{
		SecurityGroupId: sgSandbox.ID(),
		Direction:       pulumi.String("egress"),
		Ethertype:       pulumi.String("IPv4"),
		RemoteGroupId:   sgGateway.ID(),
		Description:     pulumi.String("Sandbox traffic to gateway ports only; no management subnet access"),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create sg-sandbox gateway egress rule: %w", err)
	}

	// 3. sg-management: control-plane <-> gateway mgmt-net only; SSH closed by default
	sgMgmt, err := networking.NewSecGroup(ctx, "sg-management", &networking.SecGroupArgs{
		Name:        pulumi.String("sg-management"),
		Description: pulumi.String("Security group for control plane and gateway management"),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create sg-management: %w", err)
	}

	// Ingress on management network for Data Plane API (5555/tcp)
	_, err = networking.NewSecGroupRule(ctx, "sg-mgmt-rule-dpa", &networking.SecGroupRuleArgs{
		SecurityGroupId: sgMgmt.ID(),
		Direction:       pulumi.String("ingress"),
		Ethertype:       pulumi.String("IPv4"),
		Protocol:        pulumi.String("tcp"),
		PortRangeMin:    pulumi.Int(5555),
		PortRangeMax:    pulumi.Int(5555),
		RemoteIpPrefix:  pulumi.String(cfg.ControlPlaneCIDR),
		Description:     pulumi.String("Allow HAProxy Data Plane API from control-plane host only"),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create sg-management DPA rule: %w", err)
	}

	// Ingress within management network for internal mgmt communication
	_, err = networking.NewSecGroupRule(ctx, "sg-mgmt-rule-internal", &networking.SecGroupRuleArgs{
		SecurityGroupId: sgMgmt.ID(),
		Direction:       pulumi.String("ingress"),
		Ethertype:       pulumi.String("IPv4"),
		RemoteIpPrefix:  pulumi.String(cfg.MgmtCIDR),
		Description:     pulumi.String("Allow management subnet internal communication"),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create sg-management internal rule: %w", err)
	}

	// Optional / Conditional SSH for sg-management
	if cfg.AdminSSHCIDR != "" {
		_, err = networking.NewSecGroupRule(ctx, "sg-mgmt-rule-ssh", &networking.SecGroupRuleArgs{
			SecurityGroupId: sgMgmt.ID(),
			Direction:       pulumi.String("ingress"),
			Ethertype:       pulumi.String("IPv4"),
			Protocol:        pulumi.String("tcp"),
			PortRangeMin:    pulumi.Int(22),
			PortRangeMax:    pulumi.Int(22),
			RemoteIpPrefix:  pulumi.String(cfg.AdminSSHCIDR),
			Description:     pulumi.String("Temporary admin SSH access on management network"),
		})
		if err != nil {
			return nil, fmt.Errorf("failed to create sg-management SSH rule: %w", err)
		}
	}

	// Dedicated control-plane SG. The control-plane host is not created in this
	// Pulumi stack, so its exported ID must be attached to that host's port.
	sgControlPlane, err := networking.NewSecGroup(ctx, "sg-control-plane", &networking.SecGroupArgs{
		Name:        pulumi.String("sg-control-plane"),
		Description: pulumi.String("Control-plane host ingress from gateway management network"),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create sg-control-plane: %w", err)
	}
	_, err = networking.NewSecGroupRule(ctx, "sg-control-plane-rule-api8081-from-gateways", &networking.SecGroupRuleArgs{
		SecurityGroupId: sgControlPlane.ID(),
		Direction:       pulumi.String("ingress"),
		Ethertype:       pulumi.String("IPv4"),
		Protocol:        pulumi.String("tcp"),
		PortRangeMin:    pulumi.Int(8081),
		PortRangeMax:    pulumi.Int(8081),
		RemoteIpPrefix:  pulumi.String(cfg.MgmtCIDR),
		Description:     pulumi.String("Allow gateway management hosts to reach control-plane API"),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create sg-control-plane API rule: %w", err)
	}

	return &SecurityOutputs{
		GatewaySecGroup:      sgGateway,
		SandboxSecGroup:      sgSandbox,
		MgmtSecGroup:         sgMgmt,
		ControlPlaneSecGroup: sgControlPlane,
	}, nil
}
