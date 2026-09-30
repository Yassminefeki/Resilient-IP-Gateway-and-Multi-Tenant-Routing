package main

import (
	"fmt"

	"github.com/pulumi/pulumi-openstack/sdk/v5/go/openstack/compute"
	"github.com/pulumi/pulumi-openstack/sdk/v5/go/openstack/networking"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

// GatewayPortsOutputs holds references to all 6 gateway ports and the server group.
type GatewayPortsOutputs struct {
	ServerGroup    *compute.ServerGroup
	GW1MgmtPort    *networking.Port
	GW1EdgePort    *networking.Port
	GW1SandboxPort *networking.Port
	GW2MgmtPort    *networking.Port
	GW2EdgePort    *networking.Port
	GW2SandboxPort *networking.Port

	GW1MgmtIP    pulumi.StringOutput
	GW1EdgeIP    pulumi.StringOutput
	GW1SandboxIP pulumi.StringOutput
	GW2MgmtIP    pulumi.StringOutput
	GW2EdgeIP    pulumi.StringOutput
	GW2SandboxIP pulumi.StringOutput
}

func extractFirstIP(port *networking.Port) pulumi.StringOutput {
	return port.AllFixedIps.Index(pulumi.Int(0))
}

// CreateServerGroup creates the Nova anti-affinity server group for GW1 and GW2.
func CreateServerGroup(ctx *pulumi.Context, cfg *Config) (*compute.ServerGroup, error) {
	sg, err := compute.NewServerGroup(ctx, "felcloud-gateway-antiaffinity", &compute.ServerGroupArgs{
		Name:     pulumi.String(cfg.ServerGroupName),
		Policies: pulumi.String("soft-anti-affinity"),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create server group %s: %w", cfg.ServerGroupName, err)
	}
	return sg, nil
}

// CreateGatewayPorts provisions the 3 ports for GW1 and 3 ports for GW2 with allowed-address-pairs on edge ports.
func CreateGatewayPorts(
	ctx *pulumi.Context,
	cfg *Config,
	nets *NetworkOutputs,
	sec *SecurityOutputs,
	vipAddress pulumi.StringOutput,
	serverGroup *compute.ServerGroup,
) (*GatewayPortsOutputs, error) {
	// 1. GW1 Management Port
	gw1Mgmt, err := networking.NewPort(ctx, "gw1-mgmt-port", &networking.PortArgs{
		Name:         pulumi.String("gw1-mgmt-port"),
		NetworkId:    nets.MgmtNetwork.ID(),
		AdminStateUp: pulumi.Bool(true),
		FixedIps: networking.PortFixedIpArray{
			&networking.PortFixedIpArgs{
				SubnetId: nets.MgmtSubnet.ID(),
			},
		},
		SecurityGroupIds: pulumi.StringArray{
			sec.MgmtSecGroup.ID(),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create gw1-mgmt-port: %w", err)
	}

	// 2. GW1 Edge Port (with VIP in allowed_address_pairs)
	gw1Edge, err := networking.NewPort(ctx, "gw1-edge-port", &networking.PortArgs{
		Name:         pulumi.String("gw1-edge-port"),
		NetworkId:    nets.EdgeNetwork.ID(),
		AdminStateUp: pulumi.Bool(true),
		FixedIps: networking.PortFixedIpArray{
			&networking.PortFixedIpArgs{
				SubnetId: nets.EdgeSubnet.ID(),
			},
		},
		SecurityGroupIds: pulumi.StringArray{
			sec.GatewaySecGroup.ID(),
		},
		AllowedAddressPairs: networking.PortAllowedAddressPairArray{
			&networking.PortAllowedAddressPairArgs{
				IpAddress: vipAddress,
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create gw1-edge-port: %w", err)
	}

	// 3. GW1 Sandbox Port
	gw1Sandbox, err := networking.NewPort(ctx, "gw1-sandbox-port", &networking.PortArgs{
		Name:         pulumi.String("gw1-sandbox-port"),
		NetworkId:    nets.SandboxNetwork.ID(),
		AdminStateUp: pulumi.Bool(true),
		FixedIps: networking.PortFixedIpArray{
			&networking.PortFixedIpArgs{
				SubnetId: nets.SandboxSubnet.ID(),
			},
		},
		SecurityGroupIds: pulumi.StringArray{
			sec.GatewaySecGroup.ID(),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create gw1-sandbox-port: %w", err)
	}

	// 4. GW2 Management Port
	gw2Mgmt, err := networking.NewPort(ctx, "gw2-mgmt-port", &networking.PortArgs{
		Name:         pulumi.String("gw2-mgmt-port"),
		NetworkId:    nets.MgmtNetwork.ID(),
		AdminStateUp: pulumi.Bool(true),
		FixedIps: networking.PortFixedIpArray{
			&networking.PortFixedIpArgs{
				SubnetId: nets.MgmtSubnet.ID(),
			},
		},
		SecurityGroupIds: pulumi.StringArray{
			sec.MgmtSecGroup.ID(),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create gw2-mgmt-port: %w", err)
	}

	// 5. GW2 Edge Port (with VIP in allowed_address_pairs)
	gw2Edge, err := networking.NewPort(ctx, "gw2-edge-port", &networking.PortArgs{
		Name:         pulumi.String("gw2-edge-port"),
		NetworkId:    nets.EdgeNetwork.ID(),
		AdminStateUp: pulumi.Bool(true),
		FixedIps: networking.PortFixedIpArray{
			&networking.PortFixedIpArgs{
				SubnetId: nets.EdgeSubnet.ID(),
			},
		},
		SecurityGroupIds: pulumi.StringArray{
			sec.GatewaySecGroup.ID(),
		},
		AllowedAddressPairs: networking.PortAllowedAddressPairArray{
			&networking.PortAllowedAddressPairArgs{
				IpAddress: vipAddress,
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create gw2-edge-port: %w", err)
	}

	// 6. GW2 Sandbox Port
	gw2Sandbox, err := networking.NewPort(ctx, "gw2-sandbox-port", &networking.PortArgs{
		Name:         pulumi.String("gw2-sandbox-port"),
		NetworkId:    nets.SandboxNetwork.ID(),
		AdminStateUp: pulumi.Bool(true),
		FixedIps: networking.PortFixedIpArray{
			&networking.PortFixedIpArgs{
				SubnetId: nets.SandboxSubnet.ID(),
			},
		},
		SecurityGroupIds: pulumi.StringArray{
			sec.GatewaySecGroup.ID(),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create gw2-sandbox-port: %w", err)
	}

	return &GatewayPortsOutputs{
		ServerGroup:    serverGroup,
		GW1MgmtPort:    gw1Mgmt,
		GW1EdgePort:    gw1Edge,
		GW1SandboxPort: gw1Sandbox,
		GW2MgmtPort:    gw2Mgmt,
		GW2EdgePort:    gw2Edge,
		GW2SandboxPort: gw2Sandbox,

		GW1MgmtIP:    extractFirstIP(gw1Mgmt),
		GW1EdgeIP:    extractFirstIP(gw1Edge),
		GW1SandboxIP: extractFirstIP(gw1Sandbox),
		GW2MgmtIP:    extractFirstIP(gw2Mgmt),
		GW2EdgeIP:    extractFirstIP(gw2Edge),
		GW2SandboxIP: extractFirstIP(gw2Sandbox),
	}, nil
}
