package main

import (
	"fmt"

	"github.com/pulumi/pulumi-openstack/sdk/v5/go/openstack/compute"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

// GatewayInstancesOutputs holds references to the keypair and GW1/GW2 Nova instances.
type GatewayInstancesOutputs struct {
	Keypair *compute.Keypair
	GW1     *compute.Instance
	GW2     *compute.Instance
}

// CreateGatewayInstances provisions GW1 and GW2 instances attached to their explicit ports and server group.
func CreateGatewayInstances(
	ctx *pulumi.Context,
	cfg *Config,
	gwPorts *GatewayPortsOutputs,
) (*GatewayInstancesOutputs, error) {
	// Create fresh keypair felcloud-resilient-v2
	kp, err := compute.NewKeypair(ctx, "felcloud-resilient-v2", &compute.KeypairArgs{
		Name: pulumi.String(cfg.KeypairName),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create keypair %s: %w", cfg.KeypairName, err)
	}

	// Minimal cloud-init: create ansible admin user and install python3
	userData := kp.PublicKey.ApplyT(func(pubKey string) string {
		return fmt.Sprintf(`#cloud-config
users:
  - name: ansible
    gecos: Ansible Admin User
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    groups: [sudo, adm]
    lock_passwd: true
    ssh_authorized_keys:
      - %s
packages:
  - python3
  - python3-apt
package_update: false
package_upgrade: false
`, pubKey)
	}).(pulumi.StringOutput)

	// GW1 Instance
	gw1, err := compute.NewInstance(ctx, "felcloud-gw1", &compute.InstanceArgs{
		Name:             pulumi.String("felcloud-gw1"),
		ImageId:          pulumi.String(cfg.ImageID),
		FlavorId:         pulumi.String(cfg.GatewayFlavor),
		KeyPair:          kp.Name,
		AvailabilityZone: pulumi.String(cfg.AvailabilityZone),
		SchedulerHints: compute.InstanceSchedulerHintArray{
			&compute.InstanceSchedulerHintArgs{
				Group: gwPorts.ServerGroup.ID(),
			},
		},
		Networks: compute.InstanceNetworkArray{
			&compute.InstanceNetworkArgs{
				Port: gwPorts.GW1MgmtPort.ID(),
			},
			&compute.InstanceNetworkArgs{
				Port: gwPorts.GW1EdgePort.ID(),
			},
			&compute.InstanceNetworkArgs{
				Port: gwPorts.GW1SandboxPort.ID(),
			},
		},
		UserData: userData,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create instance felcloud-gw1: %w", err)
	}

	// GW2 Instance
	gw2, err := compute.NewInstance(ctx, "felcloud-gw2", &compute.InstanceArgs{
		Name:             pulumi.String("felcloud-gw2"),
		ImageId:          pulumi.String(cfg.ImageID),
		FlavorId:         pulumi.String(cfg.GatewayFlavor),
		KeyPair:          kp.Name,
		AvailabilityZone: pulumi.String(cfg.AvailabilityZone),
		SchedulerHints: compute.InstanceSchedulerHintArray{
			&compute.InstanceSchedulerHintArgs{
				Group: gwPorts.ServerGroup.ID(),
			},
		},
		Networks: compute.InstanceNetworkArray{
			&compute.InstanceNetworkArgs{
				Port: gwPorts.GW2MgmtPort.ID(),
			},
			&compute.InstanceNetworkArgs{
				Port: gwPorts.GW2EdgePort.ID(),
			},
			&compute.InstanceNetworkArgs{
				Port: gwPorts.GW2SandboxPort.ID(),
			},
		},
		UserData: userData,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create instance felcloud-gw2: %w", err)
	}

	return &GatewayInstancesOutputs{
		Keypair: kp,
		GW1:     gw1,
		GW2:     gw2,
	}, nil
}
