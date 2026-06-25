# DB Access — Public Access & Security Group (prod RDS `bb-prod`)

Cara akses RDS prod dari local, kelola Security Group, dan hardening sebelum launch.
Region: ap-southeast-3 (Jakarta). Instance: `bb-prod`.

---

## 0. Konsep singkat
- **Endpoint RDS** = alamat DB, mis. `bb-prod.xxx.ap-southeast-3.rds.amazonaws.com:5432`. Selalu pakai ini buat konek (dari app, DBeaver, Prisma).
- **Security Group (SG)** = firewall di sekeliling DB. Nentuin **IP mana** yang boleh konek di port 5432.
  - `x.x.x.x/32` = tepat 1 IP (aman). `0.0.0.0/0` = semua internet (**JANGAN**).
- **Public access**:
  - `Yes` → endpoint resolve ke IP **publik**; bisa diakses dari laptop **kalau SG izinin IP-mu**.
  - `No` → endpoint resolve ke IP **privat**; cuma bisa dari **dalam VPC** (app/bastion/tunnel).
- Public access **bisa diubah kapan aja** setelah create (reversible). VPC **tidak** bisa diubah.

---

## 1. Setup awal (fase build) — akses Prisma/DBeaver dari local

**State: Public access = Yes + SG dikunci ke IP kamu.**

### a. Cari IP publik kamu
```bash
curl -s https://checkip.amazonaws.com
# → mis. 203.0.113.45
```

### b. Tambah rule SG (izinkan IP-mu di 5432)
Console: EC2 → Security Groups → `bb-sg-rds` → Inbound rules → Edit →
Add rule: Type **PostgreSQL**, Port **5432**, Source **My IP** (otomatis ngisi `/32`-mu) → Save.

CLI:
```bash
export AWS_REGION=ap-southeast-3
MYIP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress \
  --group-id <sg-rds-id> --protocol tcp --port 5432 \
  --cidr $MYIP/32 --region $AWS_REGION
```

### c. Konek
- **Prisma** (`.env` / export):
  ```
  DATABASE_URL="postgresql://bb_admin:<pass>@bb-prod.xxx.ap-southeast-3.rds.amazonaws.com:5432/bb_backend?sslmode=require"
  ```
  ```bash
  pnpm prisma:deploy     # migrasi dari local
  pnpm prisma studio     # GUI
  ```
- **DBeaver**: host = endpoint RDS, port 5432, db `bb_backend`, user `bb_admin`, SSL **Require**.

> Ambil password master: RDS → `bb-prod` → Configuration → "Manage master credentials in AWS Secrets Manager" → buka secret di Secrets Manager → Retrieve value.

### IP kamu berubah-ubah? (ISP dinamis) — pilih satu

**Opsi 1 — script `bbdb-allow` (re-pin ke IP sekarang).** Taruh di `~/.zshrc`, jalanin tiap IP berubah:
```bash
bbdb-allow() {
  local SG=<sg-rds-id> REGION=ap-southeast-3
  for cidr in $(aws ec2 describe-security-groups --group-ids $SG --region $REGION \
      --query "SecurityGroups[0].IpPermissions[?FromPort==\`5432\`].IpRanges[].CidrIp" --output text); do
    aws ec2 revoke-security-group-ingress --group-id $SG --protocol tcp --port 5432 --cidr "$cidr" --region $REGION
  done
  local IP=$(curl -s https://checkip.amazonaws.com)
  aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 5432 --cidr "$IP/32" --region $REGION
  echo "DB izinin $IP/32"
}
```
Selalu cuma 1 IP aktif (otomatis buang yang lama).

**Opsi 2 — SSM port-forward (IP NGGAK ngaruh, DB bisa private).** Akses lewat IAM, bukan IP — lihat §3. Cocok kalau capek update terus.

**Opsi 3 — Tailscale** di EC2 kecil dalam VPC → laptop masuk VPC, reach RDS privat. IP berubah nggak masalah.

---

## 2. Toggle Public access (No ↔ Yes) kapan saja

Console: RDS → `bb-prod` → **Modify** → Connectivity → **Public access** → pilih Yes/No →
Continue → **Apply immediately** → Modify DB instance.

CLI:
```bash
# matikan publik
aws rds modify-db-instance --db-instance-identifier bb-prod --no-publicly-accessible --apply-immediately --region ap-southeast-3
# nyalakan publik (sementara)
aws rds modify-db-instance --db-instance-identifier bb-prod --publicly-accessible --apply-immediately --region ap-southeast-3
```
Perubahan butuh ~beberapa menit (status `modifying` → `available`). Endpoint tetap sama.

---

## 3. Hardening sebelum LAUNCH (saat data KYC/rekening beneran masuk)

Target akhir prod: **Public access = No** (DB nggak pernah ke-expose internet). Akses local lewat tunnel.

### Pilihan akses dari local saat private:
**A. Bastion + SSH tunnel (DBeaver punya fitur bawaan)**
- EC2 kecil (`t4g.nano`) di subnet publik, SG bastion: SSH (22) dari IP kamu.
- DBeaver → tab **SSH** → enable tunnel (host = IP bastion, user, key); main host = endpoint RDS. DBeaver nyalurin otomatis.
- Prisma: `ssh -L 5432:bb-prod.xxx...:5432 ec2-user@<bastion>` lalu `DATABASE_URL=postgresql://...@localhost:5432/bb_backend`.

**B. SSM port-forward (tanpa port kebuka, kontrol IAM)**
```bash
aws ssm start-session --target <ec2-id> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["bb-prod.xxx...rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}'
```
Lalu `DATABASE_URL=...@localhost:5432/...`.

### Checklist hardening go-live:
- [ ] Public access = **No**
- [ ] SG RDS inbound 5432 **cuma dari `sg-app`** (Fargate), buang rule IP laptop
- [ ] Akses admin dari local lewat bastion/SSM tunnel
- [ ] `sslmode=require` di semua connection string
- [ ] Master password tetap di Secrets Manager (jangan plaintext)

---

## 4. Aturan emas
- SG **selalu** `/32` (IP spesifik), **NEVER** `0.0.0.0/0`.
- `sslmode=require` selalu.
- Public access boleh `Yes` saat build, **wajib `No`** sebelum data sensitif beneran masuk.
