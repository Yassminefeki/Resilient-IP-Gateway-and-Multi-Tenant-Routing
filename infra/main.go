package main

import (
	"fmt"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		cfg, err := LoadConfig(ctx)
		if err != nil {
			return fmt.Errorf("config load error: %w", err)
		}

		// Phase 1: Networks and Subnets
		nets, err := CreateNetworks(ctx, cfg)
		if err != nil {
			return fmt.Errorf("networks creation error: %w", err)
		}

		// Export Phase 1 network IDs
		ctx.Export("edgeNetworkId", nets.EdgeNetwork.ID())
		ctx.Export("edgeSubnetId", nets.EdgeSubnet.ID())
		ctx.Export("sandboxNetworkId", nets.SandboxNetwork.ID())
		ctx.Export("sandboxSubnetId", nets.SandboxSubnet.ID())
		ctx.Export("mgmtNetworkId", nets.MgmtNetwork.ID())
		ctx.Export("mgmtSubnetId", nets.MgmtSubnet.ID())

		// Phase 2: Router and Floating / Public Gateway IP
		routerOut, err := CreateRouter(ctx, cfg, nets.EdgeSubnet)
		if err != nil {
			return fmt.Errorf("router creation error: %w", err)
		}

		fipOut := ResolvePublicIP(routerOut.ExternalIP)

		// Export Phase 2 IDs and IP address
		ctx.Export("routerId", routerOut.Router.ID())
		ctx.Export("routerInterfaceId", routerOut.RouterInterface.ID())
		ctx.Export("floatingIpAddress", fipOut.Address)

		// Phase 3: Security Groups
		secOut, err := CreateSecurityGroups(ctx, cfg)
		if err != nil {
			return fmt.Errorf("security groups creation error: %w", err)
		}

		// Export Phase 3 Security Group IDs
		ctx.Export("gatewaySecGroupId", secOut.GatewaySecGroup.ID())
		ctx.Export("sandboxSecGroupId", secOut.SandboxSecGroup.ID())
		ctx.Export("mgmtSecGroupId", secOut.MgmtSecGroup.ID())

		// Phase 4: VIP Port, Server Group & Gateway Ports
		vipOut, err := CreateVIPPort(ctx, nets.EdgeNetwork, nets.EdgeSubnet)
		if err != nil {
			return fmt.Errorf("VIP port creation error: %w", err)
		}

		serverGroup, err := CreateServerGroup(ctx, cfg)
		if err != nil {
			return fmt.Errorf("server group creation error: %w", err)
		}

		gwPorts, err := CreateGatewayPorts(ctx, cfg, nets, secOut, vipOut.VIPAddress, serverGroup)
		if err != nil {
			return fmt.Errorf("gateway ports creation error: %w", err)
		}

		// Export Phase 4 Outputs
		ctx.Export("vipPortId", vipOut.VIPPort.ID())
		ctx.Export("vipAddress", vipOut.VIPAddress)
		ctx.Export("serverGroupId", serverGroup.ID())

		ctx.Export("gw1MgmtPortId", gwPorts.GW1MgmtPort.ID())
		ctx.Export("gw1EdgePortId", gwPorts.GW1EdgePort.ID())
		ctx.Export("gw1SandboxPortId", gwPorts.GW1SandboxPort.ID())
		ctx.Export("gw2MgmtPortId", gwPorts.GW2MgmtPort.ID())
		ctx.Export("gw2EdgePortId", gwPorts.GW2EdgePort.ID())
		ctx.Export("gw2SandboxPortId", gwPorts.GW2SandboxPort.ID())

		ctx.Export("gw1MgmtIp", gwPorts.GW1MgmtIP)
		ctx.Export("gw1EdgeIp", gwPorts.GW1EdgeIP)
		ctx.Export("gw1SandboxIp", gwPorts.GW1SandboxIP)
		ctx.Export("gw2MgmtIp", gwPorts.GW2MgmtIP)
		ctx.Export("gw2EdgeIp", gwPorts.GW2EdgeIP)
		ctx.Export("gw2SandboxIp", gwPorts.GW2SandboxIP)

		// Phase 5: Gateway Instances & Bastion VM
		gwInstances, err := CreateGatewayInstances(ctx, cfg, gwPorts)
		if err != nil {
			return fmt.Errorf("gateway instances creation error: %w", err)
		}

		bastionOut, err := CreateBastionInstance(ctx, cfg, nets, secOut, gwInstances.Keypair)
		if err != nil {
			return fmt.Errorf("bastion creation error: %w", err)
		}

		// Export Phase 5 Outputs
		ctx.Export("keypairName", gwInstances.Keypair.Name)
		ctx.Export("publicKey", gwInstances.Keypair.PublicKey)
		ctx.Export("privateKey", pulumi.ToSecret(gwInstances.Keypair.PrivateKey))
		ctx.Export("gw1InstanceId", gwInstances.GW1.ID())
		ctx.Export("gw2InstanceId", gwInstances.GW2.ID())

		// Export Bastion Outputs
		ctx.Export("bastionInstanceId", bastionOut.Instance.ID())
		ctx.Export("bastionMgmtIp", bastionOut.MgmtIP)
		ctx.Export("bastionEdgeIp", bastionOut.EdgeIP)

		// Phase 7: Team Sandbox Instances (team1, team2)
		teamSandboxes, err := CreateTeamSandboxes(ctx, cfg, nets, secOut, gwInstances.Keypair)
		if err != nil {
			return fmt.Errorf("team sandboxes creation error: %w", err)
		}

		// Export Phase 7 Outputs
		ctx.Export("team1InstanceId", teamSandboxes.Team1Instance.ID())
		ctx.Export("team1Ip", teamSandboxes.Team1IP)
		ctx.Export("team2InstanceId", teamSandboxes.Team2Instance.ID())
		ctx.Export("team2Ip", teamSandboxes.Team2IP)

		return nil
	})
}
