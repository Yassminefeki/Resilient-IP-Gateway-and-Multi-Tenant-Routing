package main

import (
	"fmt"
	"net"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

// Config holds all verified ground truth settings for the infrastructure stack.
type Config struct {
	AvailabilityZone  string
	ImageID           string
	GatewayFlavor     string
	SandboxFlavor     string
	KeypairName       string
	ServerGroupName   string
	ExternalNetworkID string
	EdgeCIDR          string
	SandboxCIDR       string
	MgmtCIDR          string
	AdminSSHCIDR      string
}

// LoadConfig loads and validates configuration from Pulumi config.
// It fails fast, reporting all missing required keys at once.
func LoadConfig(ctx *pulumi.Context) (*Config, error) {
	c := config.New(ctx, "")

	cfg := &Config{
		AvailabilityZone:  c.Get("availabilityZone"),
		ImageID:           c.Get("imageId"),
		GatewayFlavor:     c.Get("gatewayFlavor"),
		SandboxFlavor:     c.Get("sandboxFlavor"),
		KeypairName:       c.Get("keypairName"),
		ServerGroupName:   c.Get("serverGroupName"),
		ExternalNetworkID: c.Get("externalNetworkId"),
		EdgeCIDR:          c.Get("edgeCidr"),
		SandboxCIDR:       c.Get("sandboxCidr"),
		MgmtCIDR:          c.Get("mgmtCidr"),
		AdminSSHCIDR:      c.Get("adminSshCidr"),
	}

	var missing []string
	if cfg.AvailabilityZone == "" {
		missing = append(missing, "availabilityZone")
	}
	if cfg.ImageID == "" {
		missing = append(missing, "imageId")
	}
	if cfg.GatewayFlavor == "" {
		missing = append(missing, "gatewayFlavor")
	}
	if cfg.SandboxFlavor == "" {
		missing = append(missing, "sandboxFlavor")
	}
	if cfg.KeypairName == "" {
		missing = append(missing, "keypairName")
	}
	if cfg.ServerGroupName == "" {
		missing = append(missing, "serverGroupName")
	}
	if cfg.ExternalNetworkID == "" {
		missing = append(missing, "externalNetworkId")
	}
	if cfg.EdgeCIDR == "" {
		missing = append(missing, "edgeCidr")
	}
	if cfg.SandboxCIDR == "" {
		missing = append(missing, "sandboxCidr")
	}
	if cfg.MgmtCIDR == "" {
		missing = append(missing, "mgmtCidr")
	}

	if len(missing) > 0 {
		return nil, fmt.Errorf("missing required configuration keys: %s", strings.Join(missing, ", "))
	}

	// Security validation: reject open-world SSH CIDRs
	if cfg.AdminSSHCIDR != "" {
		if cfg.AdminSSHCIDR == "0.0.0.0/0" || cfg.AdminSSHCIDR == "::/0" {
			return nil, fmt.Errorf(
				"security violation: adminSshCidr cannot be open to the world (%s); "+
					"specify a trusted CIDR (e.g. 203.0.113.0/24)",
				cfg.AdminSSHCIDR,
			)
		}
		_, _, err := net.ParseCIDR(cfg.AdminSSHCIDR)
		if err != nil {
			return nil, fmt.Errorf("invalid adminSshCidr format %q: %w", cfg.AdminSSHCIDR, err)
		}
	}

	return cfg, nil
}
