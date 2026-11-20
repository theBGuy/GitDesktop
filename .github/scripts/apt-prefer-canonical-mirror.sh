#!/usr/bin/env bash
set -u
# The callers' `apt-get install` lists ran at 59-95 kB/s from AWS runners' EC2
# mirror (13-21 min, rust-tests run 44371845274); Canonical's hosts were fast.
ec2_host='[a-z0-9-]+\.ec2\.archive\.ubuntu\.com'
apt_files=(/etc/apt/sources.list /etc/apt/apt-mirrors.txt /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources)
ec2_lists=()
mapfile -d '' -t ec2_lists < <(sudo grep -lZE "://$ec2_host/" "${apt_files[@]}" 2>/dev/null || true)
if [ "${#ec2_lists[@]}" -eq 0 ]; then
  echo "apt: no EC2 regional mirror configured"
elif sudo sed -i -E "s#://$ec2_host/#://archive.ubuntu.com/#g" "${ec2_lists[@]}"; then
  printf 'apt: EC2 regional mirror replaced in:\n'
  printf '%s\n' "${ec2_lists[@]}"
else
  echo "apt: EC2 mirror rewrite failed; continuing with the files as they are"
fi
