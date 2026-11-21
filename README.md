# Bulma — SPV Workspace

Part of Vegeta. Open-source, self-hosted software for one operator running SPV deals: a lead sets up a deal, the operator reviews it, investors are invited by link, confirm eligibility, commit, sign and get payment instructions.

**Status: version 0.1.0** ([release notes](docs/en/RELEASE_NOTES.md)), still under development. Done so far: sign-in with two-step, roles, sandbox and real modes, regime packs, audit log, investing entities, eligibility steps and KYC review; syndicates, deal setup and review; invitations, the deal page, commitments, signing and payment instructions; sending mail, recording money, refunds and holds, bank statement import and the Goten export, the lead's investor list and messages, changes to live deals, removal, withdrawal and cancellation, and the operator's to-do list, evidence packs and complaints. Not yet: closing a deal.

**Read this first.** It starts in a sandbox with fictional data, and no email leaves it. Switching to the real mode needs the operator's own regulatory arrangements and legal advice. It does not take on the operator's regulatory duties. It gives no investment, tax or legal advice, and it does not judge S/EIS eligibility or whether the operator meets its legal duties. Sandbox limits and declarations are friction, not control: anyone can declare anything, and anyone can change the code. No lawyer has reviewed this project. See [who does what](docs/en/responsibilities.md) and the [due-diligence note](docs/en/due-diligence.md).

It never moves money, holds shares or runs a wallet.

## Try it

```
docker compose build
mkdir -m 700 secrets && docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/secrets:/out" bulma-deal-room:local init-secrets /out
printf 'BULMA_UID=%s\nBULMA_GID=%s\nINITIAL_ADMIN_EMAIL=you@deals.example\nINSECURE_COOKIES=1\n' "$(id -u)" "$(id -g)" > .env
docker compose up -d
```

Open http://127.0.0.1:8080 and sign in with that email and the password in `secrets/initial_admin_password`.

Compose reads `.env` every time, so every later command runs with the same settings. It is left out of Git. `INSECURE_COOKIES=1` is only for a trial on your own machine. Anywhere else, put HTTPS in front, take it out and add `TRUST_PROXY` to your proxy's address or CIDR (for example `TRUST_PROXY=172.30.0.1`). Without that, every visitor shares one address and ten failed sign-ins lock out everyone. Upgrades and backups: [guide](docs/en/upgrade-and-backup.md). What the real mode asks for: [guide](docs/en/real-mode.md).

## Develop

Needs Docker, Node.js 22 or later and Python 3 (the tests run the Python oracle).

```
docker run -d --name bulma-pg -e POSTGRES_PASSWORD=postgres -p 55433:5432 postgres:16
npm ci
npx playwright install --with-deps chromium
npm test
npm run coverage:check
```

Licence: Apache-2.0.
