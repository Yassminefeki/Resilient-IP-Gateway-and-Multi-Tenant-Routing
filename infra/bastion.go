package main

import (
	"fmt"

	"github.com/pulumi/pulumi-openstack/sdk/v5/go/openstack/compute"
	"github.com/pulumi/pulumi-openstack/sdk/v5/go/openstack/networking"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

// BastionOutputs holds references to the Bastion instance and its ports.
// NOTE: No Floating IP is allocated here — the existing 197.5.133.119 is
// reassigned manually to bastion-edge-port via: openstack floating ip set
type BastionOutputs struct {
	Instance *compute.Instance
	MgmtPort *networking.Port
	EdgePort *networking.Port
	MgmtIP   pulumi.StringOutput
	EdgeIP   pulumi.StringOutput
}

// CreateBastionInstance provisions a dedicated felcloud-bastion VM attached to felcloud-mgmt and felcloud-edge with a Floating IP.
func CreateBastionInstance(
	ctx *pulumi.Context,
	cfg *Config,
	nets *NetworkOutputs,
	sec *SecurityOutputs,
	kp *compute.Keypair,
) (*BastionOutputs, error) {
	// 1. Bastion Management Port
	bastionMgmtPort, err := networking.NewPort(ctx, "bastion-mgmt-port", &networking.PortArgs{
		Name:         pulumi.String("bastion-mgmt-port"),
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
		return nil, fmt.Errorf("failed to create bastion-mgmt-port: %w", err)
	}

	// 2. Bastion Edge Port
	bastionEdgePort, err := networking.NewPort(ctx, "bastion-edge-port", &networking.PortArgs{
		Name:         pulumi.String("bastion-edge-port"),
		NetworkId:    nets.EdgeNetwork.ID(),
		AdminStateUp: pulumi.Bool(true),
		FixedIps: networking.PortFixedIpArray{
			&networking.PortFixedIpArgs{
				SubnetId: nets.EdgeSubnet.ID(),
			},
		},
		SecurityGroupIds: pulumi.StringArray{
			sec.GatewaySecGroup.ID(),
			sec.MgmtSecGroup.ID(),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create bastion-edge-port: %w", err)
	}

	// 3. Cloud-init user data
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

	// 4. Create Bastion Compute Instance
	bastionInstance, err := compute.NewInstance(ctx, "felcloud-bastion", &compute.InstanceArgs{
		Name:             pulumi.String("felcloud-bastion"),
		ImageId:          pulumi.String(cfg.ImageID),
		FlavorId:         pulumi.String(cfg.SandboxFlavor),
		KeyPair:          kp.Name,
		AvailabilityZone: pulumi.String(cfg.AvailabilityZone),
		Networks: compute.InstanceNetworkArray{
			&compute.InstanceNetworkArgs{
				Port: bastionEdgePort.ID(),
			},
			&compute.InstanceNetworkArgs{
				Port: bastionMgmtPort.ID(),
			},
		},
		UserData: userData,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create instance felcloud-bastion: %w", err)
	}

	mgmtIP := bastionMgmtPort.AllFixedIps.Index(pulumi.Int(0))
	edgeIP := bastionEdgePort.AllFixedIps.Index(pulumi.Int(0))

	return &BastionOutputs{
		Instance: bastionInstance,
		MgmtPort: bastionMgmtPort,
		EdgePort: bastionEdgePort,
		MgmtIP:   mgmtIP,
		EdgeIP:   edgeIP,
	}, nil
}
