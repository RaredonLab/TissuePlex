# Cloud Deployment Guide

This guide walks through deploying TissuePlex on a public cloud server so that
collaborators can access it from any browser without running Docker themselves.

**Estimated time**: 1–2 hours (most of that is waiting for data to upload).  
**Estimated cost**: ~$106–116/month on DigitalOcean (~$1,280–1,400/year).

---

## What you will end up with

```
https://tissuplex.yourdomain.com
         ↓
   Cloud server (DigitalOcean)
     Caddy (HTTPS, automatic TLS certificate)
       ↓
     Docker Compose
       frontend (nginx)
       backend (FastAPI + DuckDB)
       /mnt/tissuplex-data  ← your Xenium dataset(s)
```

---

## Prerequisites

You need:
- A **credit card** for DigitalOcean billing
- A **domain name** (e.g. `yourdomain.com`) — or a subdomain of one you already own
- Your **Mac Terminal** (or any SSH client)

---

## Step 1 — Buy a domain name (skip if you already have one)

If you do not have a domain, buy one from [Namecheap](https://namecheap.com).
Search for `yourlabname.com` or similar; `.com` costs ~$12/year.

> You only need the domain. Namecheap's DNS management (free) is all you need —
> no paid add-ons required.

---

## Step 2 — Create a DigitalOcean account

1. Go to [digitalocean.com](https://digitalocean.com) and sign up.
2. Add a payment method. DigitalOcean bills monthly; you can cancel anytime.

---

## Step 3 — Add your SSH key to DigitalOcean

An SSH key lets you log into the server without a password. You likely already
have one on your Mac.

**Check for an existing key:**
```bash
cat ~/.ssh/id_ed25519.pub
```

If that file exists, copy its entire output (starts with `ssh-ed25519 ...`).  
If it doesn't exist, generate one:
```bash
ssh-keygen -t ed25519 -C "tissuplex-server"
# Press Enter three times to accept defaults and skip a passphrase
cat ~/.ssh/id_ed25519.pub
```

**Add it to DigitalOcean:**
1. In the DigitalOcean dashboard, click your avatar (top right) → **Settings** → **Security**
2. Click **Add SSH Key**
3. Paste the key text, name it "My Mac", save

---

## Step 4 — Create a Droplet (the cloud server)

1. In DigitalOcean, click **Create** → **Droplets**
2. Choose these settings:

   | Setting | Value |
   |---|---|
   | Region | New York or San Francisco (or closest to your collaborators) |
   | OS | Ubuntu **24.04 (LTS)** |
   | Droplet type | **General Purpose** |
   | Plan | 16 GB RAM / 4 vCPU / 50 GB SSD — **$96/month** |
   | Authentication | SSH Key → select "My Mac" |
   | Hostname | `tissuplex` (anything you like) |

3. Click **Create Droplet**. It takes about 60 seconds to be ready.
4. Copy the **IP address** shown in your dashboard (e.g. `143.198.50.12`).

---

## Step 5 — Add block storage for your data

The Droplet's built-in SSD is only 50 GB — not enough for your data plus the
tile cache. Add a separate storage volume:

1. In the DigitalOcean dashboard, click **Create** → **Volumes**
2. Settings:

   | Setting | Value |
   |---|---|
   | Size | **200 GB** (gives plenty of headroom for growth) |
   | Region | **Same region as your Droplet** |
   | Filesystem | ext4 |
   | Attach to Droplet | select your `tissuplex` droplet |
   | Mount point | `/mnt/tissuplex-data` |

3. Click **Create Volume**. (~$20/month)

DigitalOcean automatically mounts the volume at `/mnt/tissuplex-data` on the
server. No manual formatting needed.

---

## Step 6 — Point your domain at the server

You need to create a DNS record that maps your chosen subdomain to the server IP.

**In Namecheap** (or wherever your domain is registered):
1. Go to **Domain List** → **Manage** next to your domain
2. Click **Advanced DNS**
3. Add a new record:

   | Type | Host | Value | TTL |
   |---|---|---|---|
   | A Record | `tissuplex` | `YOUR_SERVER_IP` | Automatic |

   This makes `tissuplex.yourdomain.com` point to your server.

DNS changes take 5–60 minutes to propagate worldwide. You can continue with
the remaining steps while waiting.

---

## Step 7 — SSH into the server

Open Terminal on your Mac and connect:

```bash
ssh root@YOUR_SERVER_IP
```

Type `yes` if asked about the host fingerprint. You should see an Ubuntu welcome
message. **You are now inside your cloud server.**

---

## Step 8 — Run the setup script

Still inside the SSH session, run:

```bash
curl -fsSL https://raw.githubusercontent.com/RaredonLab/TissuePlex/main/deploy.sh | bash
```

The script will:
1. Update the server's packages
2. Install Docker
3. Clone TissuePlex
4. Ask you two questions: your domain name and the data path (`/mnt/tissuplex-data`)
5. Build and start the Docker containers

When asked:
```
Domain name: tissuplex.yourdomain.com        ← your actual subdomain
Data directory: /mnt/tissuplex-data          ← press Enter, this is the default
```

The build takes 3–5 minutes. When it finishes you will see a "Setup complete" message.

**Type `exit` to close the SSH session and return to your Mac.**

---

## Step 9 — Upload your data

Back on your Mac, open the file `upload-data.sh` in the TissuePlex repo.
Edit the first configuration line to put in your server's IP address:

```bash
SERVER_IP="143.198.50.12"    # ← replace with your actual IP
```

Then run it:

```bash
cd /path/to/TissuePlex
bash upload-data.sh
```

This uses `rsync`, which is resumable. If your internet connection drops, just
run it again and it picks up where it left off. For a 30 GB dataset on a typical
home connection, expect 30–90 minutes.

---

## Step 10 — Open the viewer

Once DNS has propagated and the upload is complete, open a browser and go to:

```
https://tissuplex.yourdomain.com
```

On first load, TissuePlex will build the DZI tile pyramid from your OME-TIFF
(same as locally — takes 30–120 seconds the first time). Subsequent loads are instant.

---

## Password protection (optional but recommended)

Currently anyone who knows the URL can view your data. To require a username and
password:

**1. Generate a hashed password** (SSH into the server first):
```bash
ssh root@YOUR_SERVER_IP
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'choose-a-password'
```
Copy the long hash that is printed (starts with `$2a$...`).

**2. Edit the Caddyfile on the server:**
```bash
nano /opt/tissuplex/Caddyfile
```

Uncomment the `basicauth` block and fill in your chosen username and the hash:
```
tissuplex.yourdomain.com {
    reverse_proxy frontend:80

    basicauth {
        labuser $2a$14$PASTE_THE_HASH_HERE
    }
}
```

**3. Restart Caddy:**
```bash
cd /opt/tissuplex
docker compose -f docker-compose.prod.yml restart caddy
```

Anyone visiting the URL will now be prompted for a username and password.
You can add multiple users by adding more lines inside the `basicauth` block.

---

## Adding more datasets later

Upload the new dataset folder to the server:

```bash
rsync -avz --progress \
  "/path/to/new_dataset/" \
  "root@YOUR_SERVER_IP:/mnt/tissuplex-data/new_dataset/"
```

No restart needed — TissuePlex auto-discovers all datasets in the data directory.
The new dataset will appear in the dataset picker immediately.

---

## Updating TissuePlex after code changes

SSH into the server and run:

```bash
cd /opt/tissuplex
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Your data and tile cache are preserved across updates.

---

## Useful commands (run on the server via SSH)

```bash
# View live logs (Ctrl-C to stop)
docker compose -f /opt/tissuplex/docker-compose.prod.yml logs -f

# Check container status
docker compose -f /opt/tissuplex/docker-compose.prod.yml ps

# Stop everything
docker compose -f /opt/tissuplex/docker-compose.prod.yml down

# Restart a specific service
docker compose -f /opt/tissuplex/docker-compose.prod.yml restart backend
```

---

## Troubleshooting

**Browser shows "site can't be reached"**  
DNS may not have propagated yet. Check with: `nslookup tissuplex.yourdomain.com`  
It should return your server's IP. Wait a bit longer if it doesn't.

**Browser shows a security warning (not HTTPS)**  
Caddy needs to reach Let's Encrypt to get a certificate. This requires:
- DNS is pointing at the server (see above)
- Ports 80 and 443 are open — check DigitalOcean's firewall settings

**Blank viewer / no image**  
The tile pyramid may still be building. Wait 60 seconds and refresh.

**Dataset not listed**  
Check that your data uploaded completely and is in the right location:
```bash
ssh root@YOUR_SERVER_IP
ls /mnt/tissuplex-data/
ls /mnt/tissuplex-data/RQ32878-002_Slide_2_PPLR_726-2/
```
You should see `experiment.xenium` in the dataset folder.

**Out of memory errors / backend crashes**  
Reduce `DUCKDB_MEMORY_LIMIT` in `/opt/tissuplex/.env.prod` and restart:
```bash
docker compose -f /opt/tissuplex/docker-compose.prod.yml --env-file /opt/tissuplex/.env.prod up -d
```
