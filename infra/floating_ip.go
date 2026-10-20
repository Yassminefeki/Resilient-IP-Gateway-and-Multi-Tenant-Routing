package main

import (
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

// FloatingIPOutputs holds the public IP address for edge gateway traffic.
type FloatingIPOutputs struct {
	Address pulumi.StringOutput
}

// ResolvePublicIP provides the public edge IP address sourced from the router's external gateway.
func ResolvePublicIP(routerExternalIP pulumi.StringOutput) *FloatingIPOutputs {
	return &FloatingIPOutputs{
		Address: routerExternalIP,
	}
}
