package main

import (
	"fmt"

	"github.com/pulumi/pulumi-openstack/sdk/v5/go/openstack/networking"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

// RouterOutputs holds references to the router, its interface, and external fixed IP.
type RouterOutputs struct {
	Router          *networking.Router
	RouterInterface *networking.RouterInterface
	ExternalIP      pulumi.StringOutput
}

// CreateRouter creates felcloud-edge-router with external gateway set to INTERNET,
// and attaches an interface ONLY to felcloud-edge-subnet.
func CreateRouter(ctx *pulumi.Context, cfg *Config, edgeSubnet *networking.Subnet) (*RouterOutputs, error) {
	router, err := networking.NewRouter(ctx, "felcloud-edge-router", &networking.RouterArgs{
		Name:              pulumi.String("felcloud-edge-router"),
		AdminStateUp:      pulumi.Bool(true),
		ExternalNetworkId: pulumi.String(cfg.ExternalNetworkID),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create felcloud-edge-router: %w", err)
	}

	// Router interface attached ONLY to felcloud-edge-subnet.
	// felcloud-sandbox and felcloud-mgmt get NO router interface.
	routerInterface, err := networking.NewRouterInterface(ctx, "felcloud-edge-router-interface", &networking.RouterInterfaceArgs{
		RouterId: router.ID(),
		SubnetId: edgeSubnet.ID(),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to attach router interface to felcloud-edge-subnet: %w", err)
	}

	externalIP := router.ExternalFixedIps.ApplyT(func(fips []networking.RouterExternalFixedIp) string {
		if len(fips) > 0 && fips[0].IpAddress != nil {
			return *fips[0].IpAddress
		}
		return ""
	}).(pulumi.StringOutput)

	return &RouterOutputs{
		Router:          router,
		RouterInterface: routerInterface,
		ExternalIP:      externalIP,
	}, nil
}
