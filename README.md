# 🤖 TheLegkiTA-Antinuke

Bot Discord avanzato per moderazione automatica, sicurezza e gestione server.  
Scritto in **Node.js** con **discord.js v14**.  
Include anti-nuke, anti-spam, anti-ping, anti-raid, sistema ticket, statistiche, backup automatico e molto altro.

---

## ✨ Funzionalità

### 🛡️ Sicurezza e Moderazione Automatica
- **Anti-Spam** – locale, rotazionale, vocale. Timeout progressivi (10 min → 1 ora → 24 ore).
- **Anti-Ping** – testuale, vocale, rotazionale, globale, `@everyone` rapido e multi-canale.
- **Anti-Raid** – rileva join flood, account nuovi, ondate sospette. Attiva lockdown automatico.
- **Anti-Nuke** – monitora audit log, timeout esecutore, ripara automaticamente canali/ruoli/ban.
- **Anti-Link** – elimina inviti Discord.
- **Anti-Ghost-Ping** – rileva e logga chi pinga e cancella il messaggio.
- **Lockdown** – blocca tutti i canali testuali con un comando. Solo il founder può rimuoverlo.
- **Whitelist e ruoli immuni** – proteggi utenti fidati.
- **Permessi temporanei** – concedi azioni di moderazione limitate nel tempo.

### 📋 Gestione Membri
- **Benvenuto personalizzato** – embed con data creazione server, account, numero membro.
- **Verifica** – assegna ruolo membro (e OG se il server ha ≤150 membri).
- **Regolamento** – embed formattato con sezioni e menzioni staff.
- **Statistiche** – canali vocali con conteggi aggiornati ogni 6 minuti.
- **Ticket** – pannello con pulsanti, apertura ticket privato, motivi con ruoli, chiusura.
- **Backup automatico** – ogni 24 ore, 10 copie conservate. Ripristino completo con un comando.

### 📝 Log
- **Log messaggi** – eliminati e modificati.
- **Log vocale** – entrate, uscite, cambi canale, mute/deaf.
- **Log membri** – nickname, ruoli aggiunti/rimossi.
- **Log moderazione** – canali/ruoli creati/eliminati, ban/kick.
- **Log generali** – tutte le azioni di moderazione automatica.

### 🎮 Comandi
- Moderazione: `/kick`, `/ban`, `/unban`, `/timeout`, `/untimeout`, `/warn`, `/clear`, `/roleall`, `/controlla`
- Utility: `/serverinfo`, `/userinfo`, `/avatar`, `/ping`, `/help`, `/regole`
- Configurazione: `/config` (whitelist, ruoli, canali, log, staff, ticket)
- Backup: `/backup_server`, `/restore_server`
- Stats: `/stats_setup`, `/stats_refresh`
- Ticket: `/ticket_setup`
- Owner: `!concedi`, `!toglipermessi`, `!lock`, `!unlock`

---

## 🚀 Installazione

### Prerequisiti
- **Node.js** v18 o superiore
- **npm**
- Un bot Discord creato sul [Portale Sviluppatori](https://discord.com/developers/applications)

### Passaggi

1. **Clona il repository**
   ```bash
   git clone https://github.com/Patatabollente20/TheLegkiTA-Antinuke.git
   cd TheLegkiTA-Antinuke
Installa le dipendenze

bash
npm install
Crea il file .env nella root del progetto (copia .env.example se presente).

env
TOKEN=il_tuo_token_discord
CLIENT_ID=id_del_bot
GUILD_ID=id_del_server (opzionale, per comandi locali)
OWNER_ID=il_tuo_id_discord
Avvia il bot

bash
node index.js
⚙️ Configurazione
Tutte le impostazioni principali si gestiscono con il comando /config dopo l'avvio.
Le variabili d'ambiente nel .env servono per i parametri di base.

Variabili .env
Variabile	Descrizione	Obbligatorio
TOKEN	Token del bot	Sì
CLIENT_ID	ID applicazione del bot	Sì
GUILD_ID	ID del server (per comandi locali)	No
OWNER_ID	ID del founder (immune)	Sì
LOG_CHANNEL_IDS	ID canali log generali (separati da virgola)	No
MESSAGE_LOG_CHANNEL_ID	Canale log messaggi edit/delete	No
VOICE_LOG_CHANNEL_ID	Canale log vocale	No
MEMBER_LOG_CHANNEL_ID	Canale log membri	No
MOD_LOG_CHANNEL_ID	Canale log moderazione	No
WELCOME_CHANNEL_ID	Canale benvenuto	No
VERIFY_CHANNEL_ID	Canale verifica	No
ALERT_CHANNEL_ID	Canale alert (lockdown, raid)	No
SUSPICIOUS_BOT_LOG_CHANNEL_ID	Canale log bot sospetti	No
IMMUNE_ROLE_ID	Ruolo immune	No
MEMBER_ROLE_ID	Ruolo membro	Sì
OG_ROLE_ID	Ruolo OG (per server piccoli)	No
WHITELISTED_IDS	ID utenti whitelist (separati da virgola)	No
AI_FREE_CHANNEL_IDS	Canali "free" (nessun filtro)	No
AUTO_PUBLISH_CHANNELS	Canali announcement da pubblicare automaticamente	No
LOG_LEVEL	Livello log (debug, info, warn, error)	No
🧠 Come funziona l'Anti-Nuke
Il bot monitora costantemente l'audit log del server.
Se un utente non autorizzato esegue azioni distruttive (creazione/eliminazione canali o ruoli, ban, kick), il bot:

Applica un timeout di 1 ora all'esecutore.

Avvia una coda di riparazione che ricrea canali/ruoli eliminati e ripristina i ban.

Invia un report dettagliato nel canale log.

Al termine, invia un riepilogo delle riparazioni.

Le azioni da parte di owner, whitelist o ruoli immuni sono sempre autorizzate e loggate.

📦 Backup e Ripristino
Backup automatico ogni 24 ore.

10 copie conservate in ./backups/history/.

Il comando /backup_server forza un backup manuale.

Il comando /restore_server ripristina l'ultimo backup (elimina tutti i canali/ruoli attuali e li ricrea).

🎫 Sistema Ticket
Pannello in un canale dedicato con pulsante "Apri Ticket".

All'apertura viene creato un canale privato con l'utente e lo staff.

L'utente seleziona il motivo (es. problema tra membri, problema con il bot).

Lo staff competente viene menzionato.

Il ticket può essere chiuso da utente o staff.

📊 Statistiche
Crea una categoria "📊 SERVER STATS" con canali vocali.

Mostra: membri, bot, staff, tutti.

Aggiornamento automatico ogni 6 minuti.

Comandi: /stats_setup (crea/ripara), /stats_refresh (forza aggiornamento).

🛠️ Comandi principale
Moderazione
/kick @utente [motivo] – espelle

/ban @utente [motivo] – banna

/unban <id> [motivo] – rimuove ban

/timeout @utente <minuti> [motivo] – timeout

/untimeout @utente [motivo] – rimuove timeout

/warn @utente <motivo> – avviso con DM

/clear <quantità> – elimina fino a 1000 messaggi

/roleall <ruolo> – assegna ruolo a tutti

/controlla <utente> – cerca richieste whitelist

Utility
/serverinfo – info server

/userinfo [@utente] – info utente

/avatar [@utente] – avatar

/ping – latenza

/help – lista comandi

/regole – regolamento

/verify – verifica

Configurazione
/config show

/config whitelist add|remove|list

/config role set <target> <ruolo>

/config channel set <target> <canale>

/config logchannel add|remove|list

/config freechannel add|remove|list

/config publishchannel add|remove|list

/config staffrole set <chiave> <ruolo>

/config ticketrole set <motivo> <ruolo>

Solo Founder
!concedi @utente <n> – permessi temporanei

!toglipermessi @utente <n> – rimuove permessi

!lock [motivo] – lockdown

!unlock – rimuove lockdown

Backup e Stats
/backup_server

/restore_server

/stats_setup

/stats_refresh

/ticket_setup

🔒 Permessi
Owner e whitelist sono immuni da qualsiasi azione automatica.

I ruoli immuni sono configurabili.

I comandi di moderazione richiedono i permessi Discord adeguati.

I comandi di configurazione richiedono Administrator.

Alcuni comandi sono riservati al founder.

📄 Licenza
Questo progetto è distribuito sotto licenza MIT.
Vedi il file LICENSE per i dettagli.

🤝 Contribuire
I contributi sono benvenuti!
Apri una issue o una pull request per migliorare il bot.

📞 Contatti
Per domande o supporto, apri una issue su GitHub.

Buon divertimento! 🎉

ricordati di sostituire i placeholder nel `.env` con i tuoi dati reali quando avvii il bot. per il resto, è pronto da pubblicare.
