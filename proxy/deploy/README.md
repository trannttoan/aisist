# VPS deployment

Target: the OCI instance on the tailnet (`tag:vps`), no public ingress — the
public URL is served via Tailscale Funnel.

One-time setup (as `ubuntu` on the VPS):

```bash
# Node 22 + pnpm
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable

# code
git clone https://github.com/trannttoan/aisist.git ~/apps/aisist
cd ~/apps/aisist
pnpm install --filter @aisist/proxy
pnpm --filter @aisist/proxy run build

# config (values stay on the box)
sudo tee /etc/aisist-proxy.env >/dev/null <<'ENV'
LANGGRAPH_UPSTREAM_URL=https://<desktop>.<tailnet>.ts.net:8445
PORT=8080
ENV
sudo chmod 600 /etc/aisist-proxy.env

# service
sudo cp proxy/deploy/aisist-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aisist-proxy
curl -s http://localhost:8080/ok    # → {"ok":true}

# publish (persists across reboots)
sudo tailscale funnel --bg 8080
```

Deploy an update:

```bash
cd ~/apps/aisist && git pull && pnpm install --filter @aisist/proxy \
  && pnpm --filter @aisist/proxy run build && sudo systemctl restart aisist-proxy
```
