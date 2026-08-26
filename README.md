# Discord Anti-Nuke / Moderation Bot by Patabollente20

Bot Discord "tutto in uno": anti-nuke con riparazione automatica, anti-spam,
anti-ping, anti-raid/lockdown, anti-link, server stats, sistema ticket,
regolamento e un pannello di **configurazione runtime tramite comandi slash**
(`/config`) — non serve più modificare il codice o riavviare il bot per
cambiare whitelist, ruoli o canali.

## Setup rapido

1. Clona il repository e installa le dipendenze:

   ```bash
   git clone <url-del-tuo-repo>
   cd <cartella>
   npm install
   ```

2. Crea un'applicazione su [Discord Developer Portal](https://discord.com/developers/applications),
   aggiungi un Bot, copia il **Token** e il **Client ID (Application ID)**.

3. Copia `.env.example` in `.env` e compila i valori:

   ```bash
   cp .env.example .env
   ```

   ```env
   TOKEN=il_tuo_token
   CLIENT_ID=id_del_tuo_bot
   GUILD_ID=id_del_tuo_server        # opzionale, per test istantanei
   OWNER_ID=825397327187279942        # founder del bot
   ```

   ⚠️ **Non committare mai `.env`** — è già escluso da `.gitignore`.

4. Invita il bot nel tuo server con questi permessi minimi:
   `Manage Roles`, `Manage Channels`, `Kick Members`, `Ban Members`,
   `Moderate Members` (timeout), `Manage Messages`, `View Audit Log`,
   `Send Messages`, `Read Message History`.

   Intents privilegiati da abilitare nel Developer Portal (tab "Bot"):
   `SERVER MEMBERS INTENT` e `MESSAGE CONTENT INTENT`.

5. Avvia il bot:

   ```bash
   npm start
   ```

Al primo avvio i comandi slash vengono registrati sia sul server indicato in
`GUILD_ID` (istantaneo) sia globalmente (fino a 1h di propagazione).

## Configurazione tramite Discord — comando `/config`

Tutti i valori "sensibili" (whitelist, ruoli, canali) **non sono più
hardcoded** nel codice: sono salvati in `config.settings.json` (creato
automaticamente, ignorato da git) e modificabili in qualunque momento con
`/config`, senza riavviare il bot.

| Comando | Descrizione | Permesso richiesto |
|---|---|---|
| `/config show` | Mostra la configurazione attuale | Administrator |
| `/config whitelist add \| remove \| list` | Gestisce chi è immune da anti-nuke/anti-spam/anti-ping | **Solo founder** |
| `/config role set target:<immuneRoleId\|memberRoleId\|ogRoleId> ruolo:<@ruolo>` | Imposta il ruolo immune, il ruolo membro verificato o il ruolo OG | `immuneRoleId` → **solo founder**; gli altri → Administrator |
| `/config channel set target:<alertChannelId\|verifyChannelId\|welcomeChannelId\|suspiciousBotLogChannelId> canale:<#canale>` | Imposta i canali di sistema | Administrator |
| `/config logchannel add \| remove \| list` | Canali dove il bot invia i log di moderazione | Administrator |
| `/config freechannel add \| remove \| list` | Canali esclusi da anti-spam/anti-ping (es. canali con bot AI) | Administrator |
| `/config staffrole set chiave:<helper\|moderator\|founder\|headMedia\|admin\|senior> ruolo:<@ruolo>` | Ruoli staff usati da `/regole` e dal sistema ticket | Administrator |
| `/config ticketrole set motivo:<membri\|bot> ruolo:<@ruolo>` | Ruolo pingato dal sistema ticket per ciascun motivo | Administrator |

La whitelist e il ruolo immune garantiscono un **bypass totale** delle
protezioni anti-nuke/anti-spam/anti-ping: per questo, anche se `/config` in
generale richiede il permesso `Administrator`, questi due sottocomandi sono
riservati esclusivamente al founder (`OWNER_ID` nel `.env`).

Le altre impostazioni "di comportamento" (soglie anti-spam, tempi di
escalation dei timeout, limiti anti-raid, ecc.) restano nell'oggetto
`CONFIG` in cima a `index.js`: sono parametri di tuning che tipicamente si
toccano raramente e in fase di sviluppo, quindi sono rimasti nel codice per
semplicità — puoi comunque spostarli in `SETTABLE_FIELDS` seguendo lo stesso
schema se vuoi renderli configurabili anch'essi.

## Altri comandi principali

- `/kick`, `/ban`, `/unban`, `/timeout`, `/untimeout`, `/clear` — moderazione base
- `/regole` — mostra il regolamento del server, personalizzabile a riga 1210
- `/verify` — verifica un membro nel canale di verifica
- `/backup_server`, `/restore_server` — backup/ripristino di canali e ruoli
- `/stats_setup`, `/stats_refresh` — canali contatore "Server Stats"
- `/ticket_setup` — pannello ticket nel canale "assistenza"
- `/comandi` — lista comandi completa (solo founder)
- `!lock [motivo]`, `!unlock`, `!concedi @utente <n>`, `!toglipermessi @utente <n>` — comandi founder con prefisso "!"

## Struttura dei dati persistenti

Questi file vengono creati automaticamente nella cartella del bot e **non**
vanno committati (sono già in `.gitignore`):

- `config.settings.json` — configurazione modificata via `/config`
- `member_numbers.json` — numero progressivo membri
- `stats_channels.json` — riferimenti ai canali "Server Stats"
- `ticket_data.json` — stato dei ticket aperti
- `backups/backup_<guildId>.json` — backup per server

## Deploy

Il bot è un semplice processo Node.js long-running (`node index.js`), quindi
funziona su qualsiasi host che supporti processi persistenti (VPS, Railway,
Render, un container Docker, ecc.) — **non** funziona su piattaforme
serverless "a richiesta" che spengono il processo tra un evento e l'altro.
Assicurati di impostare le variabili d'ambiente del `.env` anche nella
piattaforma di hosting scelta, e monta un volume persistente se vuoi
conservare `config.settings.json` e gli altri file dati tra un deploy e
l'altro.