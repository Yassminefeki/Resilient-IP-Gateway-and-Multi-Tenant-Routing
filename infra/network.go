package main

import (
	"fmt"

	"github.com/pulumi/pulumi-openstack/sdk/v5/go/openstack/networking"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

// NetworkOutputs holds references to all created networks and subnets.
type NetworkOutputs struct {
	EdgeNetwork    *networking.Network
	EdgeSubnet     *networking.Subnet
	SandboxNetwork *networking.Network
	SandboxSubnet  *networking.Subnet
	MgmtNetwork    *networking.Network
	MgmtSubnet     *networking.Subnet
}

// CreateNetworks provisions the 3 isolated networks and their corresponding subnets.
func CreateNetworks(ctx *pulumi.Context, cfg *Config) (*NetworkOutputs, error) {
	// 1. Edge Network & Subnet (10.20.20.0/24)
	edgeNet, err := networking.NewNetwork(ctx, "felcloud-edge", &networking.NetworkArgs{
		Name:         pulumi.String("felcloud-edge"),
		AdminStateUp: pulumi.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create felcloud-edge network: %w", err)
	}

	edgeSubnet, err := networking.NewSubnet(ctx, "felcloud-edge-subnet", &networking.SubnetArgs{
		Name:      pulumi.String("felcloud-edge-subnet"),
		NetworkId: edgeNet.ID(),
		Cidr:      pulumi.String(cfg.EdgeCIDR),
		IpVersion: pulumi.Int(4),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create felcloud-edge-subnet: %w", err)
	}

	// 2. Sandbox Network & Subnet (10.20.30.0/24) - strictly isolated, never attached to router
	sandboxNet, err := networking.NewNetwork(ctx, "felcloud-sandbox", &networking.NetworkArgs{
		Name:         pulumi.String("felcloud-sandbox"),
		AdminStateUp: pulumi.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create felcloud-sandbox network: %w", err)
	}

	sandboxSubnet, err := networking.NewSubnet(ctx, "felcloud-sandbox-subnet", &networking.SubnetArgs{
		Name:      pulumi.String("felcloud-sandbox-subnet"),
		NetworkId: sandboxNet.ID(),
		Cidr:      pulumi.String(cfg.SandboxCIDR),
		IpVersion: pulumi.Int(4),
		// NoGateway prevents DHCP from advertising a default route on this isolated network,
		// avoiding competing default routes on multi-NIC gateway instances.
		NoGateway: pulumi.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create felcloud-sandbox-subnet: %w", err)
	}

	// 3. Mgmt Network & Subnet (10.20.10.0/24)
	mgmtNet, err := networking.NewNetwork(ctx, "felcloud-mgmt", &networking.NetworkArgs{
		Name:         pulumi.String("felcloud-mgmt"),
		AdminStateUp: pulumi.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create felcloud-mgmt network: %w", err)
	}

	mgmtSubnet, err := networking.NewSubnet(ctx, "felcloud-mgmt-subnet", &networking.SubnetArgs{
		Name:      pulumi.String("felcloud-mgmt-subnet"),
		NetworkId: mgmtNet.ID(),
		Cidr:      pulumi.String(cfg.MgmtCIDR),
		IpVersion: pulumi.Int(4),
		// NoGateway prevents DHCP from advertising a default route on this control-plane network.
		NoGateway: pulumi.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create felcloud-mgmt-subnet: %w", err)
	}

	return &NetworkOutputs{
		EdgeNetwork:    edgeNet,
		EdgeSubnet:     edgeSubnet,
		SandboxNetwork: sandboxNet,
		SandboxSubnet:  sandboxSubnet,
		MgmtNetwork:    mgmtNet,
		MgmtSubnet:     mgmtSubnet,
	}, nil
}
