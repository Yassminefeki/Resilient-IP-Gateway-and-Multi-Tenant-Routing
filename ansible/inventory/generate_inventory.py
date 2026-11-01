#!/usr/bin/env python3
"""
Dynamic Ansible Inventory Generator for FelCloud Resilient IP Optimizer.
Reads live Pulumi stack outputs from ../infra and generates inventory/hosts.yml
and ensures the SSH private key is properly saved.
"""

import json
import os
import subprocess
import sys


def get_pulumi_outputs(infra_dir):
    try:
        res = subprocess.run(
            ["pulumi", "stack", "output", "--json"],
            cwd=infra_dir,
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(res.stdout)
    except subprocess.CalledProcessError as e:
        print(f"Error reading Pulumi outputs: {e.stderr}", file=sys.stderr)
        sys.exit(1)


def get_pulumi_secret(infra_dir, key):
    try:
        res = subprocess.run(
            ["pulumi", "stack", "output", "--show-secrets", key],
            cwd=infra_dir,
            capture_output=True,
            text=True,
            check=True,
        )
        return res.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"Error reading Pulumi secret {key}: {e.stderr}", file=sys.stderr)
        sys.exit(1)


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    ansible_dir = os.path.dirname(script_dir)
    infra_dir = os.path.join(os.path.dirname(ansible_dir), "infra")

    outputs = get_pulumi_outputs(infra_dir)
    private_key = get_pulumi_secret(infra_dir, "privateKey")

    # Write private key
    ssh_dir = os.path.join(ansible_dir, ".ssh")
    os.makedirs(ssh_dir, mode=0o700, exist_ok=True)
    key_path = os.path.join(ssh_dir, "id_rsa_felcloud")
    with open(key_path, "w") as f:
        f.write(private_key + "\n")
    os.chmod(key_path, 0o600)

    gw1_mgmt_ip = outputs.get("gw1MgmtIp")
    gw1_edge_ip = outputs.get("gw1EdgeIp")
    gw1_sandbox_ip = outputs.get("gw1SandboxIp")

    gw2_mgmt_ip = outputs.get("gw2MgmtIp")
    gw2_edge_ip = outputs.get("gw2EdgeIp")
    gw2_sandbox_ip = outputs.get("gw2SandboxIp")

    vip_address = outputs.get("vipAddress")

    inventory = {
        "all": {
            "vars": {
                "ansible_user": "ansible",
                "ansible_ssh_private_key_file": "{{ inventory_dir }}/../.ssh/id_rsa_felcloud",
                "ansible_ssh_common_args": (
                    "-o ProxyJump=ansible@" + os.getenv("BASTION_IP", "203.0.113.119")
                    + " -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
                ),
                "vip_address": vip_address,
                "edge_cidr": "10.20.20.0/24",
                "mgmt_cidr": "10.20.10.0/24",
                "sandbox_cidr": "10.20.30.0/24",
            },
            "children": {
                "gateways": {
                    "hosts": {
                        "gw1": {
                            "ansible_host": gw1_mgmt_ip,
                            "keepalived_role": "MASTER",
                            "keepalived_priority": 150,
                            "edge_ip": gw1_edge_ip,
                            "sandbox_ip": gw1_sandbox_ip,
                        },
                        "gw2": {
                            "ansible_host": gw2_mgmt_ip,
                            "keepalived_role": "BACKUP",
                            "keepalived_priority": 100,
                            "edge_ip": gw2_edge_ip,
                            "sandbox_ip": gw2_sandbox_ip,
                        },
                    }
                }
            },
        }
    }

    import yaml

    hosts_file = os.path.join(ansible_dir, "inventory", "hosts.yml")
    with open(hosts_file, "w") as f:
        yaml.dump(inventory, f, default_flow_style=False, sort_keys=False)

    print(f"Inventory successfully written to {hosts_file}")
    print(f"GW1: Mgmt={gw1_mgmt_ip}, Edge={gw1_edge_ip}, Sandbox={gw1_sandbox_ip}")
    print(f"GW2: Mgmt={gw2_mgmt_ip}, Edge={gw2_edge_ip}, Sandbox={gw2_sandbox_ip}")
    print(f"VIP Address: {vip_address}")


if __name__ == "__main__":
    main()
