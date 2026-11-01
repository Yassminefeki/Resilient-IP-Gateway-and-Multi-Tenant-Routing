package main

import (
	"fmt"

	"github.com/pulumi/pulumi-openstack/sdk/v5/go/openstack/compute"
	"github.com/pulumi/pulumi-openstack/sdk/v5/go/openstack/networking"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

type TeamSandboxOutputs struct {
	Team1Instance *compute.Instance
	Team1Port     *networking.Port
	Team1IP       pulumi.StringOutput
	Team2Instance *compute.Instance
	Team2Port     *networking.Port
	Team2IP       pulumi.StringOutput
}

func CreateTeamSandboxes(
	ctx *pulumi.Context,
	cfg *Config,
	nets *NetworkOutputs,
	sec *SecurityOutputs,
	kp *compute.Keypair,
) (*TeamSandboxOutputs, error) {
	// Cloud-init for Team 1: Simple HTTP server responding with "Hello from team1 sandbox!"
	userDataTeam1 := fmt.Sprintf(`#cloud-config
packages:
  - python3
runcmd:
  - mkdir -p /var/www/team1
  - echo "Hello from team1 sandbox!" > /var/www/team1/index.html
  - nohup python3 -m http.server 80 --directory /var/www/team1 > /var/log/team1_http.log 2>&1 &
`)

	// Cloud-init for Team 2: Simple HTTP server responding with "Hello from team2 sandbox!"
	userDataTeam2 := fmt.Sprintf(`#cloud-config
packages:
  - python3
runcmd:
  - mkdir -p /var/www/team2
  - echo "Hello from team2 sandbox!" > /var/www/team2/index.html
  - nohup python3 -m http.server 80 --directory /var/www/team2 > /var/log/team2_http.log 2>&1 &
`)

	// Team 1 Port on Sandbox Network
	team1Port, err := networking.NewPort(ctx, "team1-sandbox-port", &networking.PortArgs{
		Name:         pulumi.String("team1-sandbox-port"),
		NetworkId:    nets.SandboxNetwork.ID(),
		AdminStateUp: pulumi.Bool(true),
		FixedIps: networking.PortFixedIpArray{
			&networking.PortFixedIpArgs{
				SubnetId: nets.SandboxSubnet.ID(),
			},
		},
		SecurityGroupIds: pulumi.StringArray{
			sec.SandboxSecGroup.ID(),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create team1-sandbox-port: %w", err)
	}

	// Team 1 Instance
	team1Instance, err := compute.NewInstance(ctx, "team1", &compute.InstanceArgs{
		Name:             pulumi.String("team1"),
		ImageId:          pulumi.String(cfg.ImageID),
		FlavorId:         pulumi.String(cfg.SandboxFlavor),
		KeyPair:          kp.Name,
		AvailabilityZone: pulumi.String(cfg.AvailabilityZone),
		Networks: compute.InstanceNetworkArray{
			&compute.InstanceNetworkArgs{
				Port: team1Port.ID(),
			},
		},
		UserData: pulumi.String(userDataTeam1),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create team1 instance: %w", err)
	}

	// Team 2 Port on Sandbox Network
	team2Port, err := networking.NewPort(ctx, "team2-sandbox-port", &networking.PortArgs{
		Name:         pulumi.String("team2-sandbox-port"),
		NetworkId:    nets.SandboxNetwork.ID(),
		AdminStateUp: pulumi.Bool(true),
		FixedIps: networking.PortFixedIpArray{
			&networking.PortFixedIpArgs{
				SubnetId: nets.SandboxSubnet.ID(),
			},
		},
		SecurityGroupIds: pulumi.StringArray{
			sec.SandboxSecGroup.ID(),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create team2-sandbox-port: %w", err)
	}

	// Team 2 Instance
	team2Instance, err := compute.NewInstance(ctx, "team2", &compute.InstanceArgs{
		Name:             pulumi.String("team2"),
		ImageId:          pulumi.String(cfg.ImageID),
		FlavorId:         pulumi.String(cfg.SandboxFlavor),
		KeyPair:          kp.Name,
		AvailabilityZone: pulumi.String(cfg.AvailabilityZone),
		Networks: compute.InstanceNetworkArray{
			&compute.InstanceNetworkArgs{
				Port: team2Port.ID(),
			},
		},
		UserData: pulumi.String(userDataTeam2),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create team2 instance: %w", err)
	}

	return &TeamSandboxOutputs{
		Team1Instance: team1Instance,
		Team1Port:     team1Port,
		Team1IP:       team1Port.AllFixedIps.Index(pulumi.Int(0)),
		Team2Instance: team2Instance,
		Team2Port:     team2Port,
		Team2IP:       team2Port.AllFixedIps.Index(pulumi.Int(0)),
	}, nil
}
