package main

import (
	"fmt"

	"github.com/pulumi/pulumi-openstack/sdk/v5/go/openstack/networking"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

// VIPOutputs holds references to the unbound VIP reservation port and its auto-assigned IP address.
type VIPOutputs struct {
	VIPPort    *networking.Port
	VIPAddress pulumi.StringOutput
}

// CreateVIPPort provisions an unbound port on felcloud-edge with auto-assigned fixed IP and disabled port security.
func CreateVIPPort(ctx *pulumi.Context, edgeNet *networking.Network, edgeSubnet *networking.Subnet) (*VIPOutputs, error) {
	vipPort, err := networking.NewPort(ctx, "felcloud-vip-port", &networking.PortArgs{
		Name:                pulumi.String("felcloud-vip-port"),
		NetworkId:           edgeNet.ID(),
		AdminStateUp:        pulumi.Bool(true),
		NoSecurityGroups:    pulumi.Bool(true),
		PortSecurityEnabled: pulumi.Bool(false),
		FixedIps: networking.PortFixedIpArray{
			&networking.PortFixedIpArgs{
				SubnetId: edgeSubnet.ID(),
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create unbound VIP port: %w", err)
	}

	// AllFixedIps contains the auto-assigned IP address returned by Neutron
	vipAddress := vipPort.AllFixedIps.Index(pulumi.Int(0))

	return &VIPOutputs{
		VIPPort:    vipPort,
		VIPAddress: vipAddress,
	}, nil
}
