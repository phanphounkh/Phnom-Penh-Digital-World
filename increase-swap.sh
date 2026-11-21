#!/usr/bin/env bash
set -euo pipefail

if (( EUID != 0 )); then
  echo "Run this script with sudo."
  exit 1
fi

swap_path=/swap-extra
target_bytes=$((20 * 1024 * 1024 * 1024))
current_kib=$(awk 'NR > 1 {sum += $3} END {printf "%.0f", sum}' /proc/swaps)
if (( current_kib * 1024 >= target_bytes )); then
  echo "Total swap is already at least 20 GiB."
  exit 0
fi
if [[ -e "$swap_path" ]] || grep -qE '^/swap-extra[[:space:]]' /etc/fstab; then
  echo "STOP: /swap-extra already exists or is configured. Inspect it before continuing."
  exit 1
fi

# Include the page reserved by the swap header.
page_bytes=$(getconf PAGESIZE)
extra_bytes=$((target_bytes - current_kib * 1024 + page_bytes))
umask 077
fallocate -l "$extra_bytes" "$swap_path"
chmod 600 "$swap_path"
mkswap "$swap_path"
swapon "$swap_path"
cp -a /etc/fstab "/etc/fstab.before-swap-extra.$(date +%s)"
printf '\n/swap-extra none swap sw 0 0\n' >> /etc/fstab
systemctl daemon-reload
swapon --show
free -h
