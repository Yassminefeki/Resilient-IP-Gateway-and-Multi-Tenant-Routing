package main

import (
	"fmt"

	"github.com/pulumi/pulumi-openstack/sdk/v5/go/openstack/networking"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

// SecurityOutputs holds references to all 3 security groups.
type SecurityOutputs struct {
	GatewaySecGroup *networking.SecGroup
	SandboxSecGroup *networking.SecGroup
	MgmtSecGroup    *networking.SecGroup
}

// CreateSecurityGroups provisions sg-gateway, sg-sandbox, and sg-management with strict rule sets.
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

	// 2. sg-sandbox: 8080 reachable only from gateway path; no direct internet; no east-west between sandboxes
	sgSandbox, err := networking.NewSecGroup(ctx, "sg-sandbox", &networking.SecGroupArgs{
		Name:        pulumi.String("sg-sandbox"),
		Description: pulumi.String("Security group for isolated sandbox VMs"),
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
		RemoteIpPrefix:  pulumi.String(cfg.MgmtCIDR),
		Description:     pulumi.String("Allow HAProxy Data Plane API from management network"),
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

	return &SecurityOutputs{
		GatewaySecGroup: sgGateway,
		SandboxSecGroup: sgSandbox,
		MgmtSecGroup:    sgMgmt,
	}, nil
}
