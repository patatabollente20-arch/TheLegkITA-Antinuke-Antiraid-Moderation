require('dotenv').config();
console.log('TOKEN esiste?', process.env.TOKEN !== undefined);
console.log('TOKEN lunghezza:', process.env.TOKEN ? process.env.TOKEN.length : 0);
console.log('TOKEN primi/ultimi caratteri:', process.env.TOKEN ? `[${process.env.TOKEN.slice(0,5)}...${process.env.TOKEN.slice(-5)}]` : 'N/A');
const fs = require('fs');
const {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    ChannelType,
    AuditLogEvent,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder
} = require('discord.js');

// ================= COMANDO /creavideo (importato dal bot video) =================
const creavideoCommand = require('./commands/creavideo.js');

// ================= VIOLATION TRACKER UNIFICATO =================

class ViolationTracker {
    constructor(windowMs = 15_000, thresholdCount = 3) {
        this.violations = new Map();
        this.windowMs = windowMs;
        this.thresholdCount = thresholdCount;
    }

    register(userId, type = 'generic') {
        const now = Date.now();

        if (!this.violations.has(userId)) {
            this.violations.set(userId, {
                count: 0,
                firstTime: now,
                lastTime: now,
                violations: []
            });
        }

        const record = this.violations.get(userId);
        record.violations = record.violations.filter(v => now - v.time < this.windowMs);
        record.violations.push({ type, time: now });
        record.count = record.violations.length;
        record.lastTime = now;

        return record.count >= this.thresholdCount;
    }

    get(userId) {
        const record = this.violations.get(userId);
        if (!record) return null;

        const now = Date.now();
        const filtered = record.violations.filter(v => now - v.time < this.windowMs);

        if (filtered.length === 0) {
            this.violations.delete(userId);
            return null;
        }

        return { count: filtered.length, violations: filtered };
    }

    clear(userId) {
        this.violations.delete(userId);
    }

    cleanup() {
        const now = Date.now();
        for (const [userId, record] of this.violations) {
            if (now - record.lastTime > this.windowMs * 3) {
                this.violations.delete(userId);
            }
        }
    }
}

// ================= ESCALATION TRACKER =================

class EscalationTracker {
    constructor(windowMs = 24 * 60 * 60 * 1000) {
        this.escalations = new Map();
        this.windowMs = windowMs;
    }

    getLevel(userId) {
        const entry = this.escalations.get(userId);
        if (!entry) return 0;

        const now = Date.now();
        if (now - entry.lastTime > this.windowMs) {
            this.escalations.delete(userId);
            return 0;
        }

        return entry.level;
    }

    increment(userId) {
        const now = Date.now();
        const current = this.getLevel(userId);
        const newLevel = Math.min(current + 1, 2);

        this.escalations.set(userId, {
            level: newLevel,
            lastTime: now,
            history: (this.escalations.get(userId)?.history || []).concat({
                level: newLevel,
                time: now
            })
        });

        return newLevel;
    }

    getTimeout(level) {
        const timeouts = {
            0: 2 * 60 * 1000,
            1: 10 * 60 * 1000,
            2: 60 * 60 * 1000
        };
        return timeouts[Math.min(level, 2)];
    }

    getLabel(level) {
        const labels = {
            0: '2 minuti',
            1: '10 minuti',
            2: '1 ora'
        };
        return labels[Math.min(level, 2)];
    }

    cleanup() {
        const now = Date.now();
        for (const [userId, entry] of this.escalations) {
            if (now - entry.lastTime > this.windowMs) {
                this.escalations.delete(userId);
            }
        }
    }
}

// ================= SPAM TRACKER =================

class SpamTracker {
    constructor(config) {
        this.config = config;
        this.cache = new Map();
    }

    addLocalSpam(userId, channelId, timestamp = Date.now()) {
        if (!this.cache.has(userId)) this.cache.set(userId, { local: [], rotational: [], voice: [] });

        const record = this.cache.get(userId);
        const now = Date.now();

        if (record.localChannel && record.localChannel !== channelId) {
            record.local = [];
        }

        record.localChannel = channelId;
        record.local = this.filterWindow(record.local, now, this.config.localSpamWindow);
        record.local.push(timestamp);

        return record.local.length;
    }

    addRotationalSpam(userId, channelId, timestamp = Date.now()) {
        if (!this.cache.has(userId)) this.cache.set(userId, { local: [], rotational: [], voice: [] });

        const record = this.cache.get(userId);
        const now = Date.now();

        record.rotational = record.rotational.filter(e => now - e.time < this.config.rotSpamWindow);
        record.rotational.push({ channelId, time: timestamp });

        const uniqueChannels = new Set(record.rotational.map(e => e.channelId)).size;
        const totalMessages = record.rotational.length;

        return { totalMessages, uniqueChannels };
    }

    addVoiceSpam(userId, timestamp = Date.now()) {
        if (!this.cache.has(userId)) this.cache.set(userId, { local: [], rotational: [], voice: [] });

        const record = this.cache.get(userId);
        const now = Date.now();

        record.voice = this.filterWindow(record.voice, now, this.config.voiceSpamWindow);
        record.voice.push(timestamp);

        return record.voice.length;
    }

    filterWindow(arr, now, windowMs) {
        return arr.filter(t => (now - t) < windowMs);
    }

    clear(userId) {
        this.cache.delete(userId);
    }

    cleanup() {
        const now = Date.now();
        const maxAge = 10 * 60 * 1000;

        for (const [userId, record] of this.cache) {
            record.local = this.filterWindow(record.local, now, maxAge);
            record.rotational = record.rotational.filter(e => now - e.time < maxAge);
            record.voice = this.filterWindow(record.voice, now, maxAge);

            if (!record.local.length && !record.rotational.length && !record.voice.length) {
                this.cache.delete(userId);
            }
        }
    }
}

// ================= PING TRACKER =================

class PingTracker {
    constructor(config) {
        this.config = config;
        this.textCache = new Map();
        this.voiceCache = new Map();
        this.rotationalCache = new Map();
        this.globalCache = new Map();
        this.everyoneCache = new Map();
        // Tracker separato: conta gli INCIDENTI di abuso @everyone multi-canale
        // (non i singoli messaggi) per rilevare pattern ripetuti nel tempo.
        this.everyoneAbuseCache = new Map();
    }

    addTextPing(userId, channelId, count = 1, timestamp = Date.now()) {
        const key = `${userId}-${channelId}`;
        const now = Date.now();

        if (!this.textCache.has(key)) this.textCache.set(key, []);
        let arr = this.filterWindow(this.textCache.get(key), now, this.config.textPingWindow);
        for (let i = 0; i < count; i++) arr.push(timestamp);
        this.textCache.set(key, arr);

        return arr.length;
    }

    addVoicePing(userId, channelId, count = 1, timestamp = Date.now()) {
        const key = `${userId}-${channelId}`;
        const now = Date.now();

        if (!this.voiceCache.has(key)) this.voiceCache.set(key, []);
        let arr = this.filterWindow(this.voiceCache.get(key), now, this.config.voicePingWindow);
        for (let i = 0; i < count; i++) arr.push(timestamp);
        this.voiceCache.set(key, arr);

        return arr.length;
    }

    addGlobalPing(userId, count = 1, timestamp = Date.now()) {
        const now = Date.now();

        if (!this.globalCache.has(userId)) this.globalCache.set(userId, []);
        let arr = this.filterWindow(this.globalCache.get(userId), now, this.config.globalPingWindow);
        for (let i = 0; i < count; i++) arr.push(timestamp);
        this.globalCache.set(userId, arr);

        return arr.length;
    }

    addRotationalPing(userId, targetId, channelId, isVoice = false, count = 1, timestamp = Date.now()) {
        const now = Date.now();

        if (!this.rotationalCache.has(userId)) {
            this.rotationalCache.set(userId, new Map());
        }

        const userTargets = this.rotationalCache.get(userId);
        if (!userTargets.has(targetId)) {
            userTargets.set(targetId, []);
        }

        let arr = userTargets.get(targetId).filter(e => now - e.time < this.config.rotPingWindow);
        for (let i = 0; i < Math.min(count, 3); i++) {
            arr.push({ channelId, isVoice, time: timestamp });
        }
        userTargets.set(targetId, arr);

        const uniqueChannels = new Set(arr.map(e => e.channelId)).size;
        return { totalPings: arr.length, uniqueChannels };
    }

    addEveryonePing(userId, channelId, timestamp = Date.now()) {
        const now = Date.now();
        const WINDOW = 5 * 60 * 1000;

        if (!this.everyoneCache.has(userId)) {
            this.everyoneCache.set(userId, { channels: new Set(), timestamps: [] });
        }

        const entry = this.everyoneCache.get(userId);
        entry.timestamps = this.filterWindow(entry.timestamps, now, WINDOW);
        entry.timestamps.push(timestamp);
        entry.channels.add(channelId);

        return { totalPings: entry.timestamps.length, uniqueChannels: entry.channels.size };
    }

    // Conta gli INCIDENTI di abuso @everyone multi-canale (non i singoli
    // messaggi): va chiamato UNA volta per ogni volta che scatta la regola
    // "@everyone su 2+ canali diversi", per rilevare se lo stesso utente
    // ripete il pattern più volte entro la finestra di tempo configurata.
    addEveryoneAbusePing(userId, channelId, timestamp = Date.now()) {
        const now = Date.now();
        const windowMs = this.config.everyoneAbuseWindow;
        if (!this.everyoneAbuseCache.has(userId)) this.everyoneAbuseCache.set(userId, []);
        let arr = this.everyoneAbuseCache.get(userId).filter(e => (now - e.time) < windowMs);
        arr.push({ channelId, time: timestamp });
        this.everyoneAbuseCache.set(userId, arr);
        return { totalMessages: arr.length, uniqueChannels: new Set(arr.map(e => e.channelId)).size };
    }

    filterWindow(arr, now, windowMs) {
        return arr.filter(t => (now - t) < windowMs);
    }

    clearUser(userId) {
        for (const key of this.textCache.keys()) {
            if (key.startsWith(userId + '-')) this.textCache.delete(key);
        }
        for (const key of this.voiceCache.keys()) {
            if (key.startsWith(userId + '-')) this.voiceCache.delete(key);
        }
        this.rotationalCache.delete(userId);
        this.globalCache.delete(userId);
        this.everyoneCache.delete(userId);
        // NOTA IMPORTANTE: everyoneAbuseCache è ESCLUSO volutamente da
        // clearUser. Deve sopravvivere alle singole punizioni "normali",
        // altrimenti la soglia di N incidenti/1h non verrebbe MAI raggiunta
        // (ogni punizione normale la cancellerebbe prima che possa
        // accumularsi — era questo il bug della versione precedente).
    }

    // Da chiamare esplicitamente solo quando si vuole azzerare anche lo
    // storico degli abusi ripetuti (dopo aver applicato la sanzione massima).
    clearEveryoneAbuse(userId) {
        this.everyoneAbuseCache.delete(userId);
    }

    cleanup() {
        const now = Date.now();
        const maxAge = 10 * 60 * 1000;

        for (const [key, arr] of this.textCache) {
            const filtered = this.filterWindow(arr, now, maxAge);
            if (filtered.length === 0) {
                this.textCache.delete(key);
            } else {
                this.textCache.set(key, filtered);
            }
        }

        for (const [key, arr] of this.voiceCache) {
            const filtered = this.filterWindow(arr, now, maxAge);
            if (filtered.length === 0) {
                this.voiceCache.delete(key);
            } else {
                this.voiceCache.set(key, filtered);
            }
        }

        for (const [userId, userTargets] of this.rotationalCache) {
            for (const [targetId, arr] of userTargets) {
                const filtered = arr.filter(e => now - e.time < maxAge);
                if (filtered.length === 0) {
                    userTargets.delete(targetId);
                } else {
                    userTargets.set(targetId, filtered);
                }
            }
            if (userTargets.size === 0) this.rotationalCache.delete(userId);
        }

        for (const [userId, arr] of this.globalCache) {
            const filtered = this.filterWindow(arr, now, maxAge);
            if (filtered.length === 0) {
                this.globalCache.delete(userId);
            } else {
                this.globalCache.set(userId, filtered);
            }
        }

        for (const [userId, entry] of this.everyoneCache) {
            entry.timestamps = this.filterWindow(entry.timestamps, now, maxAge);
            if (entry.timestamps.length === 0) {
                this.everyoneCache.delete(userId);
            }
        }

        for (const [userId, arr] of this.everyoneAbuseCache) {
            const filtered = arr.filter(e => (now - e.time) < this.config.everyoneAbuseWindow);
            if (filtered.length === 0) this.everyoneAbuseCache.delete(userId);
            else this.everyoneAbuseCache.set(userId, filtered);
        }
    }
}

// ================= RAID TRACKER (MULTI-LIVELLO) =================
// Il vecchio sistema rilevava SOLO un burst di join molto rapido e stretto
// (es. 6+ in 10s). Un raid "furbo" può però bypassarlo in vari modi:
//  - entrando un po' più lentamente ma comunque in massa (es. 15 account in
//    60s, sotto la soglia del burst rapido)
//  - usando molti account creati pochi minuti/ore prima (segnale fortissimo
//    di raid, indipendentemente dalla velocità di ingresso)
//  - entrando "silenziosamente" e poi attaccando tutti insieme via messaggi
//    (spam/ping/link) invece che tramite il pattern di join
// Questo tracker copre i primi due casi; il terzo (attacco comportamentale)
// è gestito da CoordinatedAttackTracker più sotto.
class RaidTracker {
    constructor(config) {
        this.config = config;
        this.joinTimes = [];            // burst rapido (finestra breve)
        this.slowJoinTimes = [];        // flusso sostenuto (finestra più larga)
        this.newAccountJoinTimes = [];  // ingressi di account "giovani" (età < soglia)
        this.recentJoiners = new Map(); // userId -> { joinedAt, accountAgeMs }: membri "a rischio raid"
        this.recentJoinerSpam = new Map(); // userId -> [timestamp,...]: spam-check dedicato e SEPARATO
        this.waveTimes = [];            // quando sono scattati i lockdown, per riconoscere ondate ripetute
    }

    // Registra un nuovo ingresso e ritorna i conteggi correnti per ciascun
    // segnale di rilevamento raid.
    registerJoin(member, timestamp = Date.now()) {
        const accountAge = timestamp - member.user.createdTimestamp;

        this.joinTimes.push(timestamp);
        this.joinTimes = this.joinTimes.filter(t => timestamp - t < this.config.raidJoinTime);

        this.slowJoinTimes.push(timestamp);
        this.slowJoinTimes = this.slowJoinTimes.filter(t => timestamp - t < this.config.raidSlowJoinTime);

        if (accountAge < this.config.raidNewAccountAgeMs) {
            this.newAccountJoinTimes.push(timestamp);
            this.newAccountJoinTimes = this.newAccountJoinTimes.filter(t => timestamp - t < this.config.raidNewAccountJoinTime);
        }

        // Registra il membro come "a rischio raid" per la finestra configurata:
        // su di lui si applicherà una moderazione molto più severa se dovesse
        // violare le regole (vedi handleRecentJoinerViolation).
        this.recentJoiners.set(member.id, { joinedAt: timestamp, accountAgeMs: accountAge });

        return {
            fastCount: this.joinTimes.length,
            slowCount: this.slowJoinTimes.length,
            newAccountCount: this.newAccountJoinTimes.length
        };
    }

    // Valuta TUTTI i segnali insieme (OR logico): basta che UNO superi la
    // soglia per considerare l'evento un raid. Ritorna un array di motivi
    // (vuoto = nessuna soglia superata), utile per un log dettagliato.
    checkRaidThreshold(counts) {
        const reasons = [];
        if (counts.fastCount > this.config.raidJoinLimit) {
            reasons.push(`Burst rapido: ${counts.fastCount} account entrati in ${this.config.raidJoinTime / 1000}s`);
        }
        if (counts.slowCount > this.config.raidSlowJoinLimit) {
            reasons.push(`Flusso sostenuto: ${counts.slowCount} account entrati in ${Math.round(this.config.raidSlowJoinTime / 1000)}s`);
        }
        if (counts.newAccountCount >= this.config.raidNewAccountJoinLimit) {
            const days = Math.round(this.config.raidNewAccountAgeMs / (24 * 60 * 60 * 1000));
            reasons.push(`Ondata di account nuovi: ${counts.newAccountCount} account creati da meno di ${days}gg entrati in ${this.config.raidNewAccountJoinTime / 1000}s`);
        }
        return reasons;
    }

    // Un membro è "a rischio raid" se è entrato da meno di
    // raidRecentJoinerWindowMs. Auto-pulisce l'entry se scaduta.
    isRecentJoiner(userId, now = Date.now()) {
        const info = this.recentJoiners.get(userId);
        if (!info) return false;
        if (now - info.joinedAt > this.config.raidRecentJoinerWindowMs) {
            this.recentJoiners.delete(userId);
            return false;
        }
        return true;
    }

    // Conteggio spam DEDICATO ai membri "a rischio raid": finestra breve e
    // soglia bassa, tracker separato da SpamTracker per evitare di contare
    // due volte lo stesso messaggio (una nel controllo anticipato, una nel
    // normale flusso anti-spam).
    registerRecentJoinerMessage(userId, timestamp = Date.now()) {
        if (!this.recentJoinerSpam.has(userId)) this.recentJoinerSpam.set(userId, []);
        let arr = this.recentJoinerSpam.get(userId).filter(t => timestamp - t < this.config.raidRecentJoinerSpamWindowMs);
        arr.push(timestamp);
        this.recentJoinerSpam.set(userId, arr);
        return arr.length;
    }

    // Conta quante volte è scattato un lockdown nella finestra configurata:
    // permette di riconoscere "ondate" ripetute e reagire in modo più duro
    // (vedi activateLockdown).
    registerWave(timestamp = Date.now()) {
        this.waveTimes.push(timestamp);
        this.waveTimes = this.waveTimes.filter(t => timestamp - t < this.config.raidWaveWindowMs);
        return this.waveTimes.length;
    }

    // Azzera SOLO i contatori di join (usato dopo che un raid è stato
    // rilevato/gestito). recentJoiners, recentJoinerSpam e waveTimes NON
    // vengono toccati qui: devono sopravvivere sia alla gestione del singolo
    // evento sia allo sblocco del lockdown, altrimenti perderemmo la
    // capacità di riconoscere membri "a rischio" e ondate ripetute.
    reset() {
        this.joinTimes = [];
        this.slowJoinTimes = [];
        this.newAccountJoinTimes = [];
    }

    cleanup() {
        const now = Date.now();
        this.joinTimes = this.joinTimes.filter(t => now - t < this.config.raidJoinTime);
        this.slowJoinTimes = this.slowJoinTimes.filter(t => now - t < this.config.raidSlowJoinTime);
        this.newAccountJoinTimes = this.newAccountJoinTimes.filter(t => now - t < this.config.raidNewAccountJoinTime);

        for (const [uid, info] of this.recentJoiners) {
            if (now - info.joinedAt > this.config.raidRecentJoinerWindowMs) this.recentJoiners.delete(uid);
        }

        for (const [uid, arr] of this.recentJoinerSpam) {
            const filtered = arr.filter(t => now - t < this.config.raidRecentJoinerSpamWindowMs);
            if (filtered.length === 0) this.recentJoinerSpam.delete(uid);
            else this.recentJoinerSpam.set(uid, filtered);
        }

        this.waveTimes = this.waveTimes.filter(t => now - t < this.config.raidWaveWindowMs);
    }
}

// ================= COORDINATED ATTACK TRACKER =================
// Rileva i raid "comportamentali": account entrati da poco che iniziano a
// violare le regole (spam/ping/link) quasi in contemporanea, ANCHE SE il
// pattern di join non aveva superato nessuna soglia numerica del
// RaidTracker (es. sono entrati uno alla volta, distanziati, per non farsi
// beccare, e poi attaccano tutti insieme). Conta quanti UTENTI DISTINTI
// "a rischio raid" violano le regole in una finestra breve.
class CoordinatedAttackTracker {
    constructor(config) {
        this.config = config;
        this.events = []; // { userId, time }
    }

    register(userId, timestamp = Date.now()) {
        this.events.push({ userId, time: timestamp });
        this.events = this.events.filter(e => timestamp - e.time < this.config.raidCoordinatedWindowMs);
        return new Set(this.events.map(e => e.userId)).size;
    }

    reset() {
        this.events = [];
    }

    cleanup() {
        const now = Date.now();
        this.events = this.events.filter(e => now - e.time < this.config.raidCoordinatedWindowMs);
    }
}

// ================= ANTI-VIOLATION HANDLER =================

class AntiViolationHandler {
    constructor(CONFIG) {
        this.CONFIG = CONFIG;
        this.violationTracker = new ViolationTracker(15_000, 3);
        this.escalationTracker = new EscalationTracker(CONFIG.escalationWindow);
        this.spamTracker = new SpamTracker(CONFIG);
        this.pingTracker = new PingTracker(CONFIG);
        this.raidTracker = new RaidTracker(CONFIG);
    }

    isImmune(member, ownerId, whitelistedIds, immuneRoleId) {
        if (!member) return false;
        if (member.id === member.guild.ownerId || member.id === ownerId) return "OWNER";
        if (whitelistedIds.includes(member.id)) return "WHITELIST";
        if (member.roles.cache.has(immuneRoleId)) return "ROLE";
        return false;
    }

    isFreeChannel(channelId, freeChannels) {
        return freeChannels.includes(channelId);
    }

    async applyTimeout(member, guild, escalationTracker, authorId, reason, logLabel, pingUser = null) {
        if (!member || !member.moderatable) return { success: false };

        try {
            const level = escalationTracker.increment(member.id);
            const timeoutMs = escalationTracker.getTimeout(level);
            const label = escalationTracker.getLabel(level);

            await member.timeout(timeoutMs, reason).catch(err => {
                console.error(`[applyTimeout] ${member.id}:`, err.message);
            });

            return { success: true, level, label, timeoutMs };
        } catch (err) {
            console.error(`[applyTimeout] Errore:`, err.message);
            return { success: false };
        }
    }

    // NOTA: "punish" ed "applyTimeout" applicavano esattamente la stessa logica
    // (solo timeout con escalation, nessuna rimozione ruoli). Per evitare due
    // implementazioni duplicate da mantenere allineate, "punish" ora è un
    // semplice alias di "applyTimeout".
    async punish(member, guild, escalationTracker, authorId, reason, logLabel, pingUser = null) {
        return this.applyTimeout(member, guild, escalationTracker, authorId, reason, logLabel, pingUser);
    }

    async sendEscalationDM(member, violationType, level, channelId) {
        if (!member) return;

        try {
            const label = this.escalationTracker.getLabel(level);
            const typeLabel = violationType === 'ping' ? 'ping eccessivi' : 'spam';

            const embed = new EmbedBuilder()
                .setTitle('⚠️ Sanzione Automatica')
                .setDescription(
                    `Sei stato messo in timeout per **${label}** a causa di **${typeLabel}** nel canale <#${channelId}>.\n\n` +
                    `**Livello Escalation:** ${level + 1}/3\n\n` +
                    `Se pensi si tratti di un errore, contatta lo staff.`
                )
                .setColor(level === 0 ? '#f1c40f' : level === 1 ? '#e67e22' : '#e74c3c')
                .setTimestamp();

            await member.send({ embeds: [embed] });
        } catch {
            // DM chiusi
        }
    }

    async handleSpam(message, broadcastLog) {
        if (!message.member || this.isImmune(message.member, this.CONFIG.ownerId, this.CONFIG.whitelistedIds, this.CONFIG.immuneRoleId))
            return false;
        if (this.isFreeChannel(message.channelId, this.CONFIG.aiFreeChannels))
            return false;

        const uid = message.author.id;
        const chId = message.channelId;
        const isVoice = message.channel.isVoiceBased?.();

        // ── SPAM VOCALE ──────────────────────────────────────────────────
        if (isVoice) {
            const voiceCount = this.spamTracker.addVoiceSpam(uid);

            if (voiceCount >= this.CONFIG.voiceSpamLimit) {
                this.spamTracker.clear(uid);

                const [, result] = await Promise.all([
                    message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                    this.applyTimeout(
                        message.member, message.guild, this.escalationTracker,
                        uid, `Spam canale vocale (step ${this.escalationTracker.getLevel(uid) + 1})`,
                        `🔇 Anti-Spam Vocale`
                    )
                ]);

                if (result.success) {
                    this.sendEscalationDM(message.member, 'spam', result.level, chId).catch(() => {});
                    broadcastLog(message.guild,
                        `🔇 Anti-Spam Vocale [step ${result.level + 1}]`,
                        `**${message.author.tag}** → Timeout **${result.label}**\nMessaggi: ${voiceCount}`,
                        '#e74c3c', uid
                    ).catch(() => {});

                    if (this.violationTracker.register(uid, 'voice_spam')) {
                        console.log(`[AntiSpam] Viola soglia: ${message.author.tag}`);
                    }
                }
                return true;
            }
            return false;
        }

        // ── SPAM ROTAZIONALE ─────────────────────────────────────────────
        const rotData = this.spamTracker.addRotationalSpam(uid, chId);

        if (rotData.totalMessages >= this.CONFIG.rotSpamLimit &&
            rotData.uniqueChannels >= this.CONFIG.rotSpamChannels) {

            this.spamTracker.clear(uid);

            const [, result] = await Promise.all([
                message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                this.punish(
                    message.member, message.guild, this.escalationTracker,
                    uid, `Spam rotazionale (step ${this.escalationTracker.getLevel(uid) + 1})`,
                    `🔄 Anti-Spam Rotazionale`
                )
            ]);

            if (result.success) {
                this.sendEscalationDM(message.member, 'spam', result.level, chId).catch(() => {});
                broadcastLog(message.guild,
                    `🔄 Anti-Spam Rotazionale [step ${result.level + 1}]`,
                    `**${message.author.tag}** → Timeout **${result.label}**\n` +
                    `Messaggi: ${rotData.totalMessages} canali diversi: ${rotData.uniqueChannels}`,
                    '#e67e22', uid
                ).catch(() => {});

                if (this.violationTracker.register(uid, 'rot_spam')) {
                    console.log(`[AntiSpam] Viola soglia: ${message.author.tag}`);
                }
            }
            return true;
        }

        // ── SPAM LOCALE ──────────────────────────────────────────────────
        const localCount = this.spamTracker.addLocalSpam(uid, chId);

        if (localCount >= this.CONFIG.localSpamLimit) {
            this.spamTracker.clear(uid);

            const [, result] = await Promise.all([
                message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                this.applyTimeout(
                    message.member, message.guild, this.escalationTracker,
                    uid, `Spam locale (step ${this.escalationTracker.getLevel(uid) + 1})`,
                    `🛑 Anti-Spam Locale`
                )
            ]);

            if (result.success) {
                this.sendEscalationDM(message.member, 'spam', result.level, chId).catch(() => {});
                broadcastLog(message.guild,
                    `🛑 Anti-Spam Locale [step ${result.level + 1}]`,
                    `**${message.author.tag}** → Timeout **${result.label}**\nMessaggi nel canale: ${localCount}`,
                    '#e74c3c', uid
                ).catch(() => {});

                if (this.violationTracker.register(uid, 'local_spam')) {
                    console.log(`[AntiSpam] Viola soglia: ${message.author.tag}`);
                }
            }
            return true;
        }

        return false;
    }

    extractPingTargets(message) {
        const targets = new Set();
        if (message.mentions.everyone) targets.add('everyone');
        message.mentions.roles.forEach(r => targets.add(r.id));
        message.mentions.users.forEach(u => targets.add(u.id));
        return targets;
    }

    async handlePing(message, targets, totalPings, broadcastLog) {
        if (!message.member || this.isImmune(message.member, this.CONFIG.ownerId, this.CONFIG.whitelistedIds, this.CONFIG.immuneRoleId))
            return false;
        if (this.isFreeChannel(message.channelId, this.CONFIG.aiFreeChannels))
            return false;
        if (totalPings === 0) return false;

        const uid = message.author.id;
        const chId = message.channelId;
        const isVoice = message.channel.isVoiceBased?.();
        const guild = message.guild;

        // ── @EVERYONE MULTI-CANALE (+ ESCALATION ABUSI RIPETUTI) ─────────
        // Regola unificata: quando lo stesso utente manda @everyone in 2+
        // canali diversi (finestra breve, vedi addEveryonePing), scatta
        // subito una sanzione con la normale escalation (2min/10min/1h).
        // Ogni volta che questa regola scatta viene contato anche come UN
        // "incidente" di abuso @everyone (non i singoli messaggi): se lo
        // stesso utente ripete il pattern >= everyoneAbuseLimit volte, in
        // canali diversi, entro everyoneAbuseWindow (1 ora di default),
        // scatta invece un timeout severo fisso (everyoneAbuseTimeoutMs).
        if (targets.has('everyone')) {
            const evResult = this.pingTracker.addEveryonePing(uid, chId);

            if (evResult.uniqueChannels >= 2) {
                // Registra l'incidente PRIMA di ripulire le cache normali:
                // everyoneAbuseCache non viene mai toccato da clearUser,
                // quindi sopravvive alle punizioni normali e può accumularsi
                // nel tempo fino a raggiungere la soglia di abuso ripetuto.
                const abuseResult = this.pingTracker.addEveryoneAbusePing(uid, chId);

                // Pulisco solo le cache "normali" legate al ping @everyone
                // corrente, NON lo storico degli abusi ripetuti.
                this.pingTracker.everyoneCache.delete(uid);
                this.pingTracker.rotationalCache.delete(uid);
                this.pingTracker.globalCache.delete(uid);

                // ── SOGLIA ABUSO RIPETUTO ─────────────────────────────────
                if (abuseResult.totalMessages >= this.CONFIG.everyoneAbuseLimit &&
                    abuseResult.uniqueChannels >= this.CONFIG.everyoneAbuseLimit) {

                    this.pingTracker.clearEveryoneAbuse(uid);
                    const timeoutMs = this.CONFIG.everyoneAbuseTimeoutMs;
                    const reason = `Abuso @everyone ripetuto: ${abuseResult.totalMessages} incidenti in ${abuseResult.uniqueChannels} canali diversi entro 1 ora`;

                    const [, timeoutResult] = await Promise.all([
                        message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                        message.member.timeout(timeoutMs, reason)
                            .then(() => ({ success: true }))
                            .catch(err => {
                                console.error(`[AntiPing Everyone Abuso] Timeout ${uid}:`, err.message);
                                return { success: false };
                            })
                    ]);

                    if (timeoutResult.success) {
                        broadcastLog(guild,
                            `🚨 @Everyone Abuso Ripetuto Multi-Canale`,
                            `**${message.author.tag}** → Timeout **3 ore**\n` +
                            `Incidenti: ${abuseResult.totalMessages} | Canali diversi: ${abuseResult.uniqueChannels}\n` +
                            `Finestra: 1 ora`,
                            '#c0392b', uid
                        ).catch(() => {});
                    }
                    return true;
                }

                // ── PUNIZIONE NORMALE CON ESCALATION (2min/10min/1h) ──────
                const [, result] = await Promise.all([
                    message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                    this.applyTimeout(
                        message.member, guild, this.escalationTracker,
                        uid, `@everyone su ${evResult.uniqueChannels} canali diversi (step ${this.escalationTracker.getLevel(uid) + 1})`,
                        `@Everyone Multi-Canale`
                    )
                ]);

                if (result.success) {
                    this.sendEscalationDM(message.member, 'ping', result.level, chId).catch(() => {});
                    broadcastLog(guild,
                        `⚠️ @Everyone Multi-Canale [step ${result.level + 1}]`,
                        `**${message.author.tag}** → Timeout **${result.label}**\n` +
                        `Canali diversi: ${evResult.uniqueChannels}`,
                        '#e67e22', uid
                    ).catch(() => {});

                    if (this.violationTracker.register(uid, 'everyone_ping')) {
                        console.log(`[AntiPing] Viola soglia: ${message.author.tag}`);
                    }
                }
                return true;
            }
        }

        // ── PING ROTAZIONALE ─────────────────────────────────────────────
        for (const targetId of targets) {
            if (targetId === 'everyone') continue;

            const rotResult = this.pingTracker.addRotationalPing(uid, targetId, chId, isVoice, totalPings);

            if (rotResult.uniqueChannels >= this.CONFIG.rotPingChannels) {
                this.pingTracker.clearUser(uid);

                const targetName = guild.roles.cache.get(targetId) ?
                    `@${guild.roles.cache.get(targetId).name}` :
                    targetId === 'everyone' ? '@everyone' : `target:${targetId}`;

                const [, result] = await Promise.all([
                    message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                    this.punish(
                        message.member, guild, this.escalationTracker,
                        uid, `Ping rotazionale ${targetName} su ${rotResult.uniqueChannels} canali (step ${this.escalationTracker.getLevel(uid) + 1})`,
                        `🔁 Anti-Ping Rotazionale`
                    )
                ]);

                if (result.success) {
                    this.sendEscalationDM(message.member, 'ping', result.level, chId).catch(() => {});
                    broadcastLog(guild,
                        `🔁 Anti-Ping Rotazionale [step ${result.level + 1}]`,
                        `**${message.author.tag}** → Timeout **${result.label}**\n` +
                        `Target: ${targetName} | Canali diversi: ${rotResult.uniqueChannels}`,
                        '#e67e22', uid
                    ).catch(() => {});

                    if (this.violationTracker.register(uid, 'rot_ping')) {
                        console.log(`[AntiPing] Viola soglia: ${message.author.tag}`);
                    }
                }
                return true;
            }
        }

        // ── PING GLOBALE ────────────────────────────────────────────────
        const globalCount = this.pingTracker.addGlobalPing(uid, totalPings);

        if (globalCount >= this.CONFIG.globalPingLimit) {
            this.pingTracker.clearUser(uid);

            const [, result] = await Promise.all([
                message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                this.punish(
                    message.member, guild, this.escalationTracker,
                    uid, `Ping globale ${globalCount} in ${this.CONFIG.globalPingWindow / 1000}s (step ${this.escalationTracker.getLevel(uid) + 1})`,
                    `🌐 Anti-Ping Globale`
                )
            ]);

            if (result.success) {
                this.sendEscalationDM(message.member, 'ping', result.level, chId).catch(() => {});
                broadcastLog(guild,
                    `🌐 Anti-Ping Globale [step ${result.level + 1}]`,
                    `**${message.author.tag}** → Timeout **${result.label}**\nPing totali: ${globalCount}`,
                    '#c0392b', uid
                ).catch(() => {});

                if (this.violationTracker.register(uid, 'global_ping')) {
                    console.log(`[AntiPing] Viola soglia: ${message.author.tag}`);
                }
            }
            return true;
        }

        // ── PING VOCALE LOCALE ──────────────────────────────────────────
        if (isVoice) {
            const voiceCount = this.pingTracker.addVoicePing(uid, chId, totalPings);

            if (voiceCount >= this.CONFIG.voicePingLimit) {
                this.pingTracker.clearUser(uid);

                const [, result] = await Promise.all([
                    message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                    this.applyTimeout(
                        message.member, guild, this.escalationTracker,
                        uid, `Ping canale vocale ${voiceCount} in ${this.CONFIG.voicePingWindow / 1000}s (step ${this.escalationTracker.getLevel(uid) + 1})`,
                        `🔊 Anti-Ping Vocale`
                    )
                ]);

                if (result.success) {
                    this.sendEscalationDM(message.member, 'ping', result.level, chId).catch(() => {});
                    broadcastLog(guild,
                        `🔊 Anti-Ping Vocale [step ${result.level + 1}]`,
                        `**${message.author.tag}** → Timeout **${result.label}**\nPing nel canale: ${voiceCount}`,
                        result.level === 0 ? '#f1c40f' : result.level === 1 ? '#e67e22' : '#e74c3c',
                        uid
                    ).catch(() => {});

                    if (this.violationTracker.register(uid, 'voice_ping')) {
                        console.log(`[AntiPing] Viola soglia: ${message.author.tag}`);
                    }
                }
                return true;
            }
            return false;
        }

        // ── PING TESTUALE LOCALE ────────────────────────────────────────
        const textCount = this.pingTracker.addTextPing(uid, chId, totalPings);

        if (textCount >= this.CONFIG.textPingLimit) {
            this.pingTracker.clearUser(uid);

            const [, result] = await Promise.all([
                message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                this.applyTimeout(
                    message.member, guild, this.escalationTracker,
                    uid, `Ping testuale ${textCount} in ${this.CONFIG.textPingWindow / 1000}s (step ${this.escalationTracker.getLevel(uid) + 1})`,
                    `📢 Anti-Ping Testuale`
                )
            ]);

            if (result.success) {
                this.sendEscalationDM(message.member, 'ping', result.level, chId).catch(() => {});
                broadcastLog(guild,
                    `📢 Anti-Ping Testuale [step ${result.level + 1}]`,
                    `**${message.author.tag}** → Timeout **${result.label}**\nPing nel canale: ${textCount}`,
                    '#f1c40f',
                    uid
                ).catch(() => {});

                if (this.violationTracker.register(uid, 'text_ping')) {
                    console.log(`[AntiPing] Viola soglia: ${message.author.tag}`);
                }
            }
            return true;
        }

        return false;
    }

    async handleRaidJoin(member) {
        if (this.isImmune(member, this.CONFIG.ownerId, this.CONFIG.whitelistedIds, this.CONFIG.immuneRoleId))
            return false;

        this.raidTracker.registerJoin();

        if (this.raidTracker.checkRaidThreshold()) {
            this.raidTracker.reset();
            return true;
        }

        return false;
    }

    cleanup() {
        this.spamTracker.cleanup();
        this.pingTracker.cleanup();
        this.violationTracker.cleanup();
        this.escalationTracker.cleanup();
    }

    reset() {
        this.spamTracker = new SpamTracker(this.CONFIG);
        this.pingTracker = new PingTracker(this.CONFIG);
        this.raidTracker = new RaidTracker(this.CONFIG);
        this.violationTracker = new ViolationTracker(15_000, 3);
    }
}

// ================= CONFIGURAZIONE UNIFICATA =================
// Tutti gli ID specifici del server (canali, ruoli, utenti) vengono letti
// dalle variabili d'ambiente (.env). Vedi il file ".env.example" incluso nel
// repository per la lista completa delle variabili da configurare.
// Nessun ID reale è hardcodato nel codice: se una variabile non è impostata
// il campo resta vuoto/"0" e la relativa funzionalità viene semplicemente
// saltata (es. nessun canale free, nessun utente whitelist, ecc.).

function envList(name) {
    return (process.env[name] || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

const CONFIG = {
    ownerId: process.env.OWNER_ID || "0",
    clientId: process.env.CLIENT_ID || "0",
    guildId: process.env.GUILD_ID || "0",
    logChannels: envList('LOG_CHANNEL_IDS'),
    alertChannelId: process.env.ALERT_CHANNEL_ID || "0",
    // Canale per i bot rilevati come sospetti. Se l'ID è "0", il bot prova a
    // trovare automaticamente un canale con uno dei nomi indicati.
    suspiciousBotLogChannelId: process.env.SUSPICIOUS_BOT_LOG_CHANNEL_ID || "0",
    suspiciousBotLogChannelNames: ["bot-sospetto", "bot sospetto", "bot_sospetto"],
    verifyChannelId: process.env.VERIFY_CHANNEL_ID || "0",
    welcomeChannelId: process.env.WELCOME_CHANNEL_ID || "0",
    immuneRoleId: process.env.IMMUNE_ROLE_ID || "0",
    memberRoleId: process.env.MEMBER_ROLE_ID || "0",
    ogRoleId: process.env.OG_ROLE_ID || "0",
    whitelistedIds: envList('WHITELISTED_IDS'),

    localSpamLimit: 5,
    localSpamWindow: 3000,

    rotSpamLimit: 5,
    rotSpamChannels: 3,
    rotSpamWindow: 4000,

    voiceSpamLimit: 4,
    voiceSpamWindow: 5000,

    textPingLimit: 4,
    textPingWindow: 5000,

    voicePingLimit: 3,
    voicePingWindow: 7000,

    rotPingChannels: 3,
    rotPingWindow: 6000,

    globalPingLimit: 8,
    globalPingWindow: 8000,

    timeoutDueMin:   2  * 60 * 1000,
    timeoutDieciMin: 10 * 60 * 1000,
    timeoutUnOra:    60 * 60 * 1000,

    raidJoinLimit: 5,
    raidJoinTime: 10000,

    maxTimeoutMinutes: 40320,
    // Nuove protezioni richieste:
    suspiciousBotTimeoutMs: 7 * 24 * 60 * 60 * 1000,
    everyoneAbuseWindow: 60 * 60 * 1000,
    everyoneAbuseLimit: 3,
    everyoneAbuseTimeoutMs: 3 * 60 * 60 * 1000,
    auditLogWindow: 2500,

    permessiTTL: 30 * 60 * 1000,
    announceCooldown: 15 * 60 * 1000,

    aiFreeChannels: envList('AI_FREE_CHANNEL_IDS'),

    escalationWindow: 24 * 60 * 60 * 1000,

    // ID dei ruoli staff
    staffRoleIds: {
        helper: process.env.STAFF_ROLE_HELPER || "0",
        moderator: process.env.STAFF_ROLE_MODERATOR || "0",
        founder: process.env.STAFF_ROLE_FOUNDER || "0",
        headMedia: process.env.STAFF_ROLE_HEAD_MEDIA || "0",
        admin: process.env.STAFF_ROLE_ADMIN || "0",
        senior: process.env.STAFF_ROLE_SENIOR || "0"
    },

    statsEnabled: true,
    statsCategoryName: '📊 SERVER STATS',
    statsChannels: {
        membri: { label: 'Membri', emoji: '👥' },
        bots:   { label: 'Bots', emoji: '🤖' },
        staff:  { label: 'Staff', emoji: '🛡️' },
        all:    { label: 'Tutti', emoji: '🌐' }
    },
    // Intervallo minimo tra un rename e l'altro dei canali stats
    // (Discord permette max 2 rename ogni 10 min per canale)
    statsMinGapMs: 6 * 60 * 1000,

    // ── SISTEMA TICKET ──────────────────────────────────────────────
    ticketEnabled: true,
    ticketCategoryName: '🎫 TICKET',
    ticketPanelChannelName: 'assistenza',
    ticketReasonRoles: {
        // chiave: usata nel customId dei bottoni (ticket_reason_<chiave>)
        membri: {
            label: 'Problema tra membri',
            emoji: '⚔️',
            roleId: process.env.TICKET_ROLE_MEMBRI || "0" // ruolo moderazione
        },
        bot: {
            label: 'Problema con il bot',
            emoji: '🤖',
            roleId: process.env.TICKET_ROLE_BOT || "0" // ruolo admin/dev
        }
    }
};

// ================= CONFIGURAZIONE PERSISTENTE (/config) =================
// Tutti i campi "sensibili" di CONFIG (whitelist, ruoli, canali log, ecc.)
// possono essere modificati a runtime tramite i comandi slash /config,
// senza dover toccare il codice o riavviare il bot con nuove env var.
// Le modifiche vengono salvate in config.settings.json e ricaricate ad ogni
// avvio, così sono persistenti tra un riavvio e l'altro / tra un deploy e
// l'altro (basta non cancellare il file, ed è già ignorato da git).

const SETTINGS_FILE = './config.settings.json';

// Elenco dei campi di CONFIG che possono essere letti/scritti da /config.
// Tenerlo esplicito evita che un comando possa sovrascrivere campi non
// previsti (es. i tracker interni o i limiti anti-spam).
const SETTABLE_FIELDS = [
    'ownerId',
    'logChannels',
    'alertChannelId',
    'suspiciousBotLogChannelId',
    'verifyChannelId',
    'welcomeChannelId',
    'immuneRoleId',
    'memberRoleId',
    'ogRoleId',
    'whitelistedIds',
    'aiFreeChannels',
    'staffRoleIds',
    'ticketReasonRoles'
];

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
        }
    } catch (e) { console.error('[Settings] Errore lettura file:', e.message); }
    return null;
}

function applyPersistedSettings() {
    const saved = loadSettings();
    if (!saved) return;
    for (const key of SETTABLE_FIELDS) {
        if (saved[key] === undefined) continue;
        if (key === 'staffRoleIds' || key === 'ticketReasonRoles') {
            // merge superficiale, per non perdere eventuali chiavi nuove
            // aggiunte nel codice ma non presenti nel file salvato
            CONFIG[key] = { ...CONFIG[key], ...saved[key] };
        } else {
            CONFIG[key] = saved[key];
        }
    }
    console.log('[Settings] Configurazione persistente caricata da', SETTINGS_FILE);
}

// Salva su disco SOLO i campi "settable" correnti di CONFIG.
function persistSettings() {
    try {
        const snapshot = {};
        for (const key of SETTABLE_FIELDS) snapshot[key] = CONFIG[key];
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(snapshot, null, 2));
    } catch (e) { console.error('[Settings] Errore salvataggio file:', e.message); }
}

applyPersistedSettings();

// ── Helper di modifica usati dai comandi /config ─────────────────────────

function addToIdList(fieldName, id) {
    if (!CONFIG[fieldName].includes(id)) CONFIG[fieldName].push(id);
    persistSettings();
}

function removeFromIdList(fieldName, id) {
    CONFIG[fieldName] = CONFIG[fieldName].filter(v => v !== id);
    persistSettings();
}

function setConfigField(fieldName, value) {
    CONFIG[fieldName] = value;
    persistSettings();
}

function setStaffRoleField(key, roleId) {
    CONFIG.staffRoleIds[key] = roleId;
    persistSettings();
}

function setTicketReasonRole(key, roleId) {
    if (!CONFIG.ticketReasonRoles[key]) return false;
    CONFIG.ticketReasonRoles[key].roleId = roleId;
    persistSettings();
    return true;
}

const auditLogCache = new Map();
const auditLogPending = new Map();
const auditLogHotCache = new Map();
const AUDIT_LOG_CACHE_SIZE = 50;
const AUDIT_LOG_CACHE_TTL = 15 * 1000;

function updateAuditLogHotCache(guildId, entry) {
    if (!auditLogHotCache.has(guildId)) auditLogHotCache.set(guildId, []);
    const cache = auditLogHotCache.get(guildId);
    cache.unshift({
        type: entry.action,
        targetId: entry.target?.id,
        executor: entry.executor,
        timestamp: entry.createdTimestamp,
        entry
    });
    if (cache.length > AUDIT_LOG_CACHE_SIZE) cache.pop();
}

function searchAuditLogHotCache(guildId, type, targetId, maxAge = CONFIG.auditLogWindow) {
    const cache = auditLogHotCache.get(guildId);
    if (!cache || cache.length === 0) return null;

    const now = Date.now();
    for (const item of cache) {
        if (
            item.type === type &&
            item.targetId === targetId &&
            (now - item.timestamp) < maxAge
        ) {
            return item.entry;
        }
    }
    return null;
}

async function fetchAuditLogEntry(guild, type, targetId, maxWait = CONFIG.auditLogWindow) {
    if (!guild) return null;

    const cachedEntry = searchAuditLogHotCache(guild.id, type, targetId, maxWait);
    if (cachedEntry) return cachedEntry;

    const pendingKey = `${guild.id}-${type}-${targetId}`;
    if (auditLogPending.has(pendingKey)) {
        return auditLogPending.get(pendingKey);
    }
    const fetchPromise = (async () => {
        try {
            // Retry più rapidi (25ms/50ms) e meno tentativi: questo percorso è solo
            // un fallback di sicurezza, il rilevamento primario ora passa dall'evento
            // gateway guildAuditLogEntryCreate (istantaneo, nessuna chiamata REST).
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const logs = await guild.fetchAuditLogs({ limit: 10, type }).catch(() => null);
                    if (!logs?.entries.size) {
                        if (attempt < 1) await delay(25 * Math.pow(2, attempt));
                        continue;
                    }

                    for (const [, entry] of logs.entries) {
                        updateAuditLogHotCache(guild.id, entry);

                        if (
                            entry.target?.id === targetId &&
                            Date.now() - entry.createdTimestamp < maxWait + 1000
                        ) {
                            return entry;
                        }
                    }

                    break;
                } catch (err) {
                    if (attempt < 1) await delay(25);
                }
            }
        } catch (e) {
            console.error(`[fetchAuditLogEntry] ${guild.id} - ${type}:`, e.message);
        }
        return null;
    })();

    auditLogPending.set(pendingKey, fetchPromise);

    const result = await fetchPromise;
    auditLogPending.delete(pendingKey);
    return result;
}

// Evita doppie sanzioni: quando un evento viene già gestito tramite l'evento
// gateway guildAuditLogEntryCreate (istantaneo), i vecchi handler basati su
// fetch REST non devono rielaborarlo. TTL breve, sufficiente a coprire la
// finestra in cui entrambi i percorsi potrebbero scattare per lo stesso evento.
const processedAuditEntries = new Map();
const PROCESSED_ENTRY_TTL = 10_000;

function markAuditEntryProcessed(entryId) {
    if (!entryId) return;
    processedAuditEntries.set(entryId, Date.now());
}

function isAuditEntryProcessed(entryId) {
    if (!entryId) return false;
    const t = processedAuditEntries.get(entryId);
    if (!t) return false;
    if (Date.now() - t > PROCESSED_ENTRY_TTL) {
        processedAuditEntries.delete(entryId);
        return false;
    }
    return true;
}

// Claim atomico (check + mark senza await in mezzo): evita che gateway e
// fallback processino la stessa entry due volte e generino doppi log / doppie
// riparazioni. Ritorna true solo se questa chiamata "prende" l'entry per prima.
function tryClaimAuditEntry(entryId) {
    if (!entryId) return false;
    if (isAuditEntryProcessed(entryId)) return false;
    markAuditEntryProcessed(entryId);
    return true;
}

function cleanupProcessedAuditEntries() {
    const now = Date.now();
    for (const [id, t] of processedAuditEntries) {
        if (now - t > PROCESSED_ENTRY_TTL) processedAuditEntries.delete(id);
    }
}

async function setupAuditLogListener(client) {
    const trackedTypes = [
        AuditLogEvent.ChannelCreate,
        AuditLogEvent.ChannelUpdate,
        AuditLogEvent.ChannelDelete,
        AuditLogEvent.RoleCreate,
        AuditLogEvent.RoleUpdate,
        AuditLogEvent.RoleDelete,
        AuditLogEvent.MemberBanAdd,
        AuditLogEvent.MemberKick
    ];

    // Rete di sicurezza a bassa frequenza: il rilevamento veloce ora passa
    // dall'evento gateway guildAuditLogEntryCreate, quindi questo polling serve
    // solo a recuperare eventuali eventi persi (es. downtime), niente più fretta.
    setInterval(async () => {
        const guilds = client.guilds.cache.values();
        for (const guild of guilds) {
            guild.fetchAuditLogs({ limit: 5 })
                .then(logs => {
                    for (const [, entry] of logs.entries) {
                        if (trackedTypes.includes(entry.action)) {
                            updateAuditLogHotCache(guild.id, entry);
                        }
                    }
                })
                .catch(() => {});
        }
    }, 20_000);

    console.log('[Audit Log] Listener di backup configurato (rilevamento primario via gateway).');
}

// ================= REGOLAMENTO =================

const RULES_SECTIONS = [
    {
        title: "1️⃣ Comportamento Generale e Rispetto",
        text:
            "**1.1.** È richiesto un comportamento civile, educato e rispettoso verso tutti i membri e lo staff.\n" +
            "**1.2.** Non sono tollerati insulti, molestie, provocazioni, atteggiamenti tossici o discriminazioni di qualsiasi natura (razza, genere, orientamento, religione, nazionalità).\n" +
            "**1.3.** Discussioni e dibattiti sono ammessi, purché restino costruttivi e non sfocino in attacchi personali."
    },
    {
        title: "2️⃣ Canali Testuali e Vocali",
        text:
            "**2.1.** Ogni canale ha una funzione specifica: rispettate la destinazione d'uso di ciascuna chat.\n" +
            "**2.2.** Vietati spam di messaggi, abuso di menzioni non necessarie e invio massivo di media/link.\n" +
            "**2.3.** Nei canali vocali è vietato l'uso di soundboard, musica ad alto volume o rumori molesti."
    },
    {
        title: "3️⃣ Contenuti di Gioco e Condivisione",
        text:
            "**3.1.** Vietata la condivisione di materiale classificato, documenti militari protetti da segreto o dati tecnici sensibili per argomentare il realismo dei mezzi di gioco.\n" +
            "**3.2.** Link esterni, contenuti multimediali o inviti ad altri server sono consentiti solo previa autorizzazione dello staff o nei canali dedicati."
    },
    {
        title: "4️⃣ Condotta di Gioco (War Thunder)",
        text:
            "**4.1.** Nelle partite di squadra è richiesta coordinazione e rispetto delle direttive del caposquadra.\n" +
            "**4.2.** Non tollerato comportamento antisportivo: teamkilling intenzionale o abbandono deliberato delle partite competitive.\n" +
            "**4.3.** Severamente vietato promuovere, diffondere o utilizzare cheat, exploit o modifiche client non autorizzate da Gaijin Entertainment."
    },
    {
        title: "5️⃣ Moderazione e Sanzioni",
        text:
            "**5.1.** Moderatori e amministratori hanno l'ultima parola sulla gestione delle controversie e sulle sanzioni.\n" +
            "**5.2.** Sanzioni applicabili: richiamo formale, mute temporaneo, kick o ban permanente, in base alla gravità.\n" +
            "**5.3.** Il mancato rispetto delle indicazioni dello staff comporta un aggravamento immediato della sanzione."
    }
];

function buildRulesEmbeds(guild) {
    const embeds = [];
    const header = new EmbedBuilder()
        .setTitle("📜 Regolamento del Server")
        .setDescription(
            "Benvenuto! Leggi con attenzione le regole prima di partecipare.\n\n" +
            "ℹ️ **Gli unici canali completamente \"free\" (senza restrizioni di moderazione) sono quelli con l'AI.**"
        )
        .setColor('#5865F2')
        .setTimestamp();
    if (guild?.iconURL) header.setThumbnail(guild.iconURL({ size: 256 }));
    embeds.push(header);

    const CHUNK = 5;
    for (let i = 0; i < RULES_SECTIONS.length; i += CHUNK) {
        const chunk = RULES_SECTIONS.slice(i, i + CHUNK);
        const embed = new EmbedBuilder().setColor('#5865F2');
        for (const s of chunk) embed.addFields({ name: s.title, value: s.text });
        embeds.push(embed);
    }

    const footer = new EmbedBuilder()
        .setDescription(
            "**Per ogni problema, taggate lo staff competente:**\n" +
            `${mentionStaffRole('helper')} · ${mentionStaffRole('moderator')} · ` +
            `${mentionStaffRole('founder')} · ${mentionStaffRole('headMedia')}`
        )
        .setColor('#2b2d31');
    embeds.push(footer);

    return embeds;
}

function mentionStaffRole(key) {
    const id = CONFIG.staffRoleIds[key];
    return id && id !== "0" ? `<@&${id}>` : `\`${key}\``;
}

// ================= INIZIALIZZAZIONE CLIENT =================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildModeration
    ],
    partials: [Partials.Channel, Partials.GuildMember]
});

// ================= CACHE =====================================

const antiViolation = new AntiViolationHandler(CONFIG);

const permessiTemporanei = new Map();
const announceChannels = new Map();

let raidModeActive = false;
let lockdownActive = false;

// Cleanup periodico
setInterval(() => {
    antiViolation.cleanup();
    cleanupProcessedAuditEntries();
    console.log('[Cleanup] Cache puliti');
}, 5 * 60 * 1000);

// Rete di sicurezza per i Server Stats: anche se per qualche motivo un
// evento di join/leave/ruolo non facesse scattare l'aggiornamento (es. mass
// prune, downtime), questo intervallo garantisce comunque un refresh
// periodico rispettando il cooldown per canale.
setInterval(() => {
    if (!CONFIG.statsEnabled) return;
    for (const guild of client.guilds.cache.values()) {
        scheduleStatsUpdate(guild);
    }
}, CONFIG.statsMinGapMs);

const delay = ms => new Promise(res => setTimeout(res, ms));

// ================= MEMBER NUMBER SYSTEM =================

const MEMBER_NUMBERS_FILE = './member_numbers.json';

function loadMemberNumbers() {
    try {
        if (fs.existsSync(MEMBER_NUMBERS_FILE)) {
            return JSON.parse(fs.readFileSync(MEMBER_NUMBERS_FILE, 'utf-8'));
        }
    } catch (e) { console.error('[MemberNumbers] Errore lettura file:', e); }
    return { members: {}, nextNumber: 1 };
}

function saveMemberNumbers(data) {
    try {
        fs.writeFileSync(MEMBER_NUMBERS_FILE, JSON.stringify(data, null, 2));
    } catch (e) { console.error('[MemberNumbers] Errore salvataggio file:', e); }
}

function getMemberNumber(userId, guild) {
    const data = loadMemberNumbers();
    if (data.members[userId] !== undefined) {
        return data.members[userId];
    }
    const num = guild ? guild.memberCount : data.nextNumber;
    data.members[userId] = num;
    if (num >= data.nextNumber) data.nextNumber = num + 1;
    saveMemberNumbers(data);
    return num;
}

// ================= LOCKDOWN =================

async function activateLockdown(guild, reason) {
    if (lockdownActive) return;
    lockdownActive = true;
    raidModeActive = true;
    antiViolation.violationTracker.violations.clear();

    const embed = new EmbedBuilder()
        .setTitle('🔒 LOCKDOWN ATTIVATO')
        .setDescription(
            `**Motivo:** ${reason}\n\n` +
            `Tutti i canali sono stati bloccati.\n` +
            `⚠️ Il lockdown **NON** si disattiva automaticamente: resterà attivo finché il founder ` +
            `non lo rimuove manualmente con \`!unlock\`.`
        )
        .setColor('#ff0000')
        .setTimestamp();

    // PRIORITÀ ASSOLUTA: blocca subito tutti i canali, in PARALLELO (non uno
    // alla volta), così il raid viene contenuto nel minor tempo possibile.
    const textChannels = guild.channels.cache.filter(c =>
        (c.isTextBased() && !c.isThread()) || c.type === 0
    );
    await Promise.all(textChannels.map(async ch => {
        try {
            const jobs = [
                ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {})
            ];
            if (typeof ch.setRateLimitPerUser === 'function') {
                jobs.push(ch.setRateLimitPerUser(120).catch(() => {}));
            }
            await Promise.all(jobs);
        } catch (e) { console.error('[lockdown] canale', ch.id, e.message); }
    }));

    console.log(`[Lockdown] ATTIVO — ${reason} (nessuno sblocco automatico: serve !unlock)`);

    // Notifiche in background: non devono rallentare il blocco dei canali.
    (async () => {
        const alertCh = (CONFIG.alertChannelId && CONFIG.alertChannelId !== "0")
            ? (guild.channels.cache.get(CONFIG.alertChannelId) || await guild.channels.fetch(CONFIG.alertChannelId).catch(() => null))
            : null;
        if (alertCh) {
            await alertCh.send({ content: `<@${CONFIG.ownerId}>`, embeds: [embed] }).catch(() => {});
        } else {
            await dmOwnerFallback(guild, embed);
        }
        await broadcastLog(guild, '🔒 Lockdown Attivato', reason, '#ff0000');
    })().catch(() => {});
}

async function deactivateLockdown(guild, reason = 'Lockdown rimosso dal founder') {
    if (!lockdownActive) return;
    lockdownActive = false;
    raidModeActive = false;
    antiViolation.raidTracker.reset();

    const embed = new EmbedBuilder()
        .setTitle('🔓 LOCKDOWN RIMOSSO')
        .setDescription(`**Motivo:** ${reason}\n\nI canali sono stati riaperti.`)
        .setColor('#2ecc71')
        .setTimestamp();

    // Sblocca subito tutti i canali, in PARALLELO.
    const textChannels = guild.channels.cache.filter(c =>
        (c.isTextBased() && !c.isThread()) || c.type === 0
    );
    await Promise.all(textChannels.map(async ch => {
        try {
            const jobs = [
                ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }).catch(() => {})
            ];
            if (typeof ch.setRateLimitPerUser === 'function') {
                jobs.push(ch.setRateLimitPerUser(0).catch(() => {}));
            }
            await Promise.all(jobs);
        } catch (e) { console.error('[unlock] canale', ch.id, e.message); }
    }));

    console.log(`[Lockdown] RIMOSSO — ${reason}`);

    // Notifiche in background: non devono rallentare lo sblocco dei canali.
    (async () => {
        const alertCh = (CONFIG.alertChannelId && CONFIG.alertChannelId !== "0")
            ? (guild.channels.cache.get(CONFIG.alertChannelId) || await guild.channels.fetch(CONFIG.alertChannelId).catch(() => null))
            : null;
        if (alertCh) {
            await alertCh.send({ embeds: [embed] }).catch(() => {});
        } else {
            await dmOwnerFallback(guild, embed);
        }
        await broadcastLog(guild, '🔓 Lockdown Rimosso', reason, '#2ecc71');
    })().catch(() => {});
}

// ================= UTILITY =================

function isImmune(member) {
    if (!member) return false;
    if (member.id === member.guild.ownerId || member.id === CONFIG.ownerId) return "OWNER";
    if (CONFIG.whitelistedIds.includes(member.id)) return "WHITELIST";
    if (member.roles.cache.has(CONFIG.immuneRoleId)) return "ROLE";
    return false;
}

function getPermessi(userId) {
    const e = permessiTemporanei.get(userId);
    if (!e) return 0;
    if (Date.now() > e.expiresAt) { permessiTemporanei.delete(userId); return 0; }
    return e.count;
}

function setPermessi(userId, count) {
    if (count <= 0) { permessiTemporanei.delete(userId); return; }
    permessiTemporanei.set(userId, { count, expiresAt: Date.now() + CONFIG.permessiTTL });
}

async function sendOwnerAlert(channel, user) {
    const embed = new EmbedBuilder()
        .setTitle('👑 Autorità Rilevata')
        .setDescription(`${user} ha attivato un controllo di sicurezza, ma **questo è l'Owner** (o superiore). Azione annullata.`)
        .setColor('#f1c40f')
        .setThumbnail(user.displayAvatarURL())
        .setFooter({ text: 'Immunità Regale Attiva' })
        .setTimestamp();
    return channel.send({ embeds: [embed] }).catch(() => {});
}

// Fallback: se nessun canale di log è configurato/raggiungibile, avvisa comunque
// il founder via DM così nessun evento anti-nuke/anti-raid passa inosservato.
async function dmOwnerFallback(guild, embed, pingUser = null) {
    try {
        const owner = await client.users.fetch(CONFIG.ownerId).catch(() => null);
        if (!owner) return false;
        const payload = { embeds: [embed] };
        payload.content = pingUser
            ? `⚠️ Nessun canale log disponibile — utente coinvolto: <@${pingUser}>`
            : `⚠️ Nessun canale log disponibile${guild ? ` — server: ${guild.name}` : ''}`;
        await owner.send(payload);
        return true;
    } catch (e) {
        console.error('[dmOwnerFallback] Impossibile contattare il founder via DM:', e.message);
        return false;
    }
}

function getUniqueLogChannelIds() {
    const raw = Array.isArray(CONFIG.logChannels) ? CONFIG.logChannels : [];
    // Dedup: evita invii multipli allo stesso canale se l'ID è presente più volte
    // (e limita il loop a un set finito, niente ripetizioni infinite).
    return [...new Set(raw.filter(id => id && id !== "0"))];
}

async function sendLog(guild, embed) {
    // Log su console SEMPRE, indipendentemente dai canali configurati:
    // così l'anti-nuke/anti-raid restano tracciabili anche senza canali log.
    console.log(`[Log] ${embed?.data?.title ?? 'Evento'} — ${embed?.data?.description ?? ''}`);
    if (!guild) return;

    let sent = false;
    const ids = getUniqueLogChannelIds();

    for (const channelId of ids) {
        try {
            const ch = await guild.channels.fetch(channelId).catch(() => null);
            if (!ch || !ch.isTextBased()) continue;
            const me = guild.members.me;
            if (me && !ch.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) continue;
            await ch.send({ embeds: [embed] }).catch(err => console.error(`[sendLog] ${channelId}:`, err));
            sent = true;
        } catch (e) { console.error(`[sendLog] ${channelId}:`, e); }
    }

    // Nessun canale valido/raggiungibile → avvisa il founder in DM.
    if (!sent) await dmOwnerFallback(guild, embed);
}

async function broadcastLog(guild, title, description, color = '#ff0000', pingUser = null) {
    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
    console.log(`[Broadcast] ${title} — ${description}`);
    if (!guild) return;

    let sent = false;
    const ids = getUniqueLogChannelIds();

    for (const id of ids) {
        let ch = guild.channels.cache.get(id);
        if (!ch) ch = await guild.channels.fetch(id).catch(() => null);
        if (!ch || !ch.isTextBased()) continue;
        const me = guild.members.me;
        if (me && !ch.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) continue;
        const payload = { embeds: [embed] };
        if (pingUser) payload.content = `⚠️ <@${pingUser}>`;
        await ch.send(payload).catch(() => {});
        sent = true;
    }

    // Nessun canale valido/raggiungibile → avvisa il founder in DM, così le
    // sanzioni anti-spam/anti-ping/anti-nuke/anti-raid restano notificate.
    if (!sent) await dmOwnerFallback(guild, embed, pingUser);
}

// Log dedicato ai bot sospetti: preferisce un canale ID configurato, altrimenti
// cerca un canale col nome convenuto. Il messaggio pinga il ruolo founder.
async function sendSuspiciousBotLog(guild, member) {
    if (!guild || !member) return false;
    const founderRoleId = CONFIG.staffRoleIds?.founder;
    const founderPing = founderRoleId && founderRoleId !== "0" ? `<@&${founderRoleId}>` : `<@${CONFIG.ownerId}>`;
    let channel = null;
    if (CONFIG.suspiciousBotLogChannelId && CONFIG.suspiciousBotLogChannelId !== "0") {
        channel = guild.channels.cache.get(CONFIG.suspiciousBotLogChannelId)
            || await guild.channels.fetch(CONFIG.suspiciousBotLogChannelId).catch(() => null);
    }
    if (!channel) {
        const names = Array.isArray(CONFIG.suspiciousBotLogChannelNames)
            ? CONFIG.suspiciousBotLogChannelNames.map(n => String(n).trim().toLowerCase()) : [];
        channel = guild.channels.cache.find(ch =>
            ch.isTextBased?.() && names.includes(String(ch.name || '').trim().toLowerCase())
        ) || null;
    }
    const embed = new EmbedBuilder()
        .setTitle('🤖 BOT SOSPETTO RILEVATO')
        .setDescription('È entrato un bot nel server e gli è stato applicato automaticamente un timeout di **7 giorni**.')
        .addFields(
            { name: 'Bot', value: `${member} — **${member.user.tag}**`, inline: false },
            { name: 'ID', value: `\`${member.id}\``, inline: true },
            { name: 'Timeout', value: '7 giorni', inline: true },
            { name: 'Account creato', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>`, inline: false }
        )
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setColor('#e67e22')
        .setTimestamp();
    const payload = { content: founderPing, embeds: [embed] };
    if (channel?.isTextBased?.()) {
        const me = guild.members.me;
        if (me && !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) return dmOwnerFallback(guild, embed);
        if (await channel.send(payload).then(() => true).catch(() => false)) return true;
    }
    return dmOwnerFallback(guild, embed);
}

// ================= BACKUP PER-SERVER (COMPLETO + STORICO) =================
const BACKUPS_DIR = './backups';
const BACKUPS_HISTORY_DIR = './backups/history';
const BACKUP_HISTORY_KEEP = 10; // quanti backup storici tenere per server

function getBackupPath(guildId) {
    return `${BACKUPS_DIR}/backup_${guildId}.json`; // sempre l'ULTIMO backup (usato da /restore_server)
}

function getBackupHistoryPath(guildId, timestamp) {
    const safeTs = timestamp.replace(/[:.]/g, '-');
    return `${BACKUPS_HISTORY_DIR}/backup_${guildId}_${safeTs}.json`;
}

function ensureBackupsDir() {
    try {
        if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
        if (!fs.existsSync(BACKUPS_HISTORY_DIR)) fs.mkdirSync(BACKUPS_HISTORY_DIR, { recursive: true });
    } catch (e) { console.error('[ensureBackupsDir]', e); }
}

function pruneBackupHistory(guildId) {
    try {
        const prefix = `backup_${guildId}_`;
        const files = fs.readdirSync(BACKUPS_HISTORY_DIR)
            .filter(f => f.startsWith(prefix))
            .map(f => ({ f, t: fs.statSync(`${BACKUPS_HISTORY_DIR}/${f}`).mtimeMs }))
            .sort((a, b) => b.t - a.t);
        for (const old of files.slice(BACKUP_HISTORY_KEEP)) {
            fs.unlinkSync(`${BACKUPS_HISTORY_DIR}/${old.f}`);
        }
    } catch (e) { console.error('[pruneBackupHistory]', e.message); }
}

function protectedRoleIdsFor(guild) {
    return new Set([
        CONFIG.memberRoleId,
        CONFIG.immuneRoleId,
        CONFIG.ogRoleId,
        ...Object.values(CONFIG.staffRoleIds || {}),
        ...Object.values(CONFIG.ticketReasonRoles || {}).map(r => r.roleId)
    ].filter(id => id && id !== "0"));
}

// Serializza gli overwrite di permesso di un canale/categoria in una forma
// che sopravvive al restore: i ruoli "protetti" (staff/member/immune/ticket)
// non vengono mai eliminati quindi il loro ID resta valido; i ruoli normali
// vengono invece ricreati con un nuovo ID, quindi li referenziamo con un
// tempId risolto DOPO la ricreazione.
function serializeOverwrites(channel, guild, roleTempIdByOldRoleId) {
    const list = [];
    for (const [, ow] of channel.permissionOverwrites.cache) {
        const entry = { allow: ow.allow.bitfield.toString(), deny: ow.deny.bitfield.toString() };
        if (ow.id === guild.id) {
            entry.targetType = 'everyone';
        } else if (ow.type === 0) { // ruolo
            if (roleTempIdByOldRoleId.has(ow.id)) {
                entry.targetType = 'role';
                entry.roleTempId = roleTempIdByOldRoleId.get(ow.id);
            } else {
                entry.targetType = 'role_direct'; // ruolo protetto/gestito, id invariato
                entry.id = ow.id;
            }
        } else { // membro
            entry.targetType = 'member';
            entry.id = ow.id;
        }
        list.push(entry);
    }
    return list;
}

async function performGuildBackup(guild) {
    // Assicura una cache membri fresca per catturare l'assegnazione ruoli.
    if (guild.members.cache.size < guild.memberCount) {
        await guild.members.fetch().catch(() => {});
    }

    const protectedRoleIds = protectedRoleIdsFor(guild);

    // ── RUOLI (esclusi @everyone, gestiti/bot, e protetti) ──────────────────
    const backupableRoles = guild.roles.cache
        .filter(r => !r.managed && r.id !== guild.id && !protectedRoleIds.has(r.id));

    const roleTempIdByOldRoleId = new Map();
    let idx = 0;
    for (const [, r] of backupableRoles) { roleTempIdByOldRoleId.set(r.id, idx++); }

    const roles = [...backupableRoles.values()].map(r => ({
        tempId: roleTempIdByOldRoleId.get(r.id),
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        mentionable: r.mentionable,
        permissions: r.permissions.bitfield.toString(),
        position: r.position
    }));

    // ── CATEGORIE ─────────────────────────────────────────────────────────
    const categoryChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory);
    const catTempIdByOldId = new Map();
    idx = 0;
    for (const [, c] of categoryChannels) { catTempIdByOldId.set(c.id, idx++); }

    const categories = [...categoryChannels.values()].map(c => ({
        tempId: catTempIdByOldId.get(c.id),
        name: c.name,
        position: c.position,
        overwrites: serializeOverwrites(c, guild, roleTempIdByOldRoleId)
    }));

    // ── CANALI TESTUALI + VOCALI (NESSUN LIMITE) ─────────────────────────────
    const channels = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice)
        .map(c => ({
            name: c.name,
            type: c.type,
            position: c.position,
            parentTempId: c.parentId ? (catTempIdByOldId.has(c.parentId) ? catTempIdByOldId.get(c.parentId) : null) : null,
            topic: c.topic ?? null,
            nsfw: c.nsfw ?? false,
            bitrate: c.bitrate || null,
            userLimit: c.userLimit || null,
            rateLimitPerUser: c.rateLimitPerUser || null,
            overwrites: serializeOverwrites(c, guild, roleTempIdByOldRoleId)
        }));

    // ── ASSEGNAZIONE RUOLI AI MEMBRI (solo ruoli non protetti/gestiti) ──────
    const memberRoles = [];
    for (const [, member] of guild.members.cache) {
        if (member.user.bot) continue;
        const roleTempIds = member.roles.cache
            .filter(r => roleTempIdByOldRoleId.has(r.id))
            .map(r => roleTempIdByOldRoleId.get(r.id));
        if (roleTempIds.length > 0) {
            memberRoles.push({ userId: member.id, roleTempIds });
        }
    }

    const timestamp = new Date().toISOString();
    const payload = {
        guildId: guild.id,
        guildName: guild.name,
        timestamp,
        roles,
        categories,
        channels,
        memberRoles
    };

    ensureBackupsDir();
    // Copia "ultima" (usata di default da /restore_server)
    await fs.promises.writeFile(getBackupPath(guild.id), JSON.stringify(payload, null, 2));
    // Copia storica (mai sovrascritta)
    await fs.promises.writeFile(getBackupHistoryPath(guild.id, timestamp), JSON.stringify(payload, null, 2));
    pruneBackupHistory(guild.id);

    return {
        channelsCount: channels.length,
        categoriesCount: categories.length,
        rolesCount: roles.length,
        membersCount: memberRoles.length
    };
}

// ── BACKUP AUTOMATICO ────────────────────────────────────────────────────
const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // ogni 24 ore

async function runAutoBackupForAllGuilds() {
    for (const guild of client.guilds.cache.values()) {
        try {
            const r = await performGuildBackup(guild);
            console.log(`[AutoBackup] ${guild.name}: ${r.channelsCount} canali, ${r.categoriesCount} categorie, ${r.rolesCount} ruoli, ${r.membersCount} membri`);
        } catch (e) {
            console.error(`[AutoBackup] Errore su ${guild.name}:`, e.message);
        }
    }
}

function startAutoBackup() {
    runAutoBackupForAllGuilds().catch(e => console.error('[AutoBackup] Errore avvio:', e));
    setInterval(() => {
        runAutoBackupForAllGuilds().catch(e => console.error('[AutoBackup] Errore periodico:', e));
    }, AUTO_BACKUP_INTERVAL_MS);
    console.log(`[AutoBackup] Attivo — ogni ${AUTO_BACKUP_INTERVAL_MS / (60 * 60 * 1000)} ore.`);
}

function deserializeOverwrites(overwrites, guild, newRoleIdByTempId) {
    if (!Array.isArray(overwrites)) return [];
    const result = [];
    for (const ow of overwrites) {
        let id = null;
        if (ow.targetType === 'everyone') id = guild.id;
        else if (ow.targetType === 'role') id = newRoleIdByTempId.get(ow.roleTempId);
        else if (ow.id) id = ow.id;
        if (!id) continue;
        result.push({
            id,
            allow: BigInt(ow.allow || '0'),
            deny: BigInt(ow.deny || '0')
        });
    }
    return result;
}

async function performGuildRestore(guild, data) {
    const protectedRoleIds = protectedRoleIdsFor(guild);

    const channelsToDelete = guild.channels.cache.filter(c =>
        c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice
    );
    await Promise.all([...channelsToDelete.values()].map(ch =>
        ch.delete().catch(e => console.error(`[restore] delete canale ${ch.id}:`, e.message))
    ));

    const catsToDelete = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory);
    await Promise.all([...catsToDelete.values()].map(ch =>
        ch.delete().catch(e => console.error(`[restore] delete categoria ${ch.id}:`, e.message))
    ));

    const rolesToDelete = guild.roles.cache.filter(r =>
        !r.managed && r.id !== guild.id && !protectedRoleIds.has(r.id)
    );
    for (const [, r] of rolesToDelete) {
        await r.delete().catch(e => console.error(`[restore] delete ruolo ${r.id}:`, e.message));
    }

    const newRoleIdByTempId = new Map();
    const rolesSorted = [...(data.roles ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    let createdRoles = 0;
    for (const r of rolesSorted) {
        const created = await guild.roles.create({
            name: r.name,
            color: r.color,
            hoist: r.hoist ?? false,
            mentionable: r.mentionable ?? false,
            permissions: BigInt(r.permissions),
            reason: 'Restore da backup'
        }).catch(e => { console.error('[restore] create ruolo:', e.message); return null; });
        if (created) {
            createdRoles++;
            if (r.tempId !== undefined) newRoleIdByTempId.set(r.tempId, created.id);
        }
    }

    const newCatIdByTempId = new Map();
    const catsSorted = [...(data.categories ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    let createdCategories = 0;
    for (const c of catsSorted) {
        const created = await guild.channels.create({
            name: c.name,
            type: ChannelType.GuildCategory,
            permissionOverwrites: deserializeOverwrites(c.overwrites, guild, newRoleIdByTempId),
            reason: 'Restore da backup'
        }).catch(e => { console.error('[restore] create categoria:', e.message); return null; });
        if (created) {
            createdCategories++;
            if (c.tempId !== undefined) newCatIdByTempId.set(c.tempId, created.id);
        }
    }

    const chSorted = [...(data.channels ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    let createdChannels = 0;
    for (const c of chSorted) {
        const parentId = (c.parentTempId !== null && c.parentTempId !== undefined)
            ? newCatIdByTempId.get(c.parentTempId)
            : undefined;
        const created = await guild.channels.create({
            name: c.name,
            type: c.type,
            parent: parentId,
            topic: c.topic ?? undefined,
            nsfw: c.nsfw ?? undefined,
            bitrate: c.bitrate ?? undefined,
            userLimit: c.userLimit ?? undefined,
            rateLimitPerUser: c.rateLimitPerUser ?? undefined,
            permissionOverwrites: deserializeOverwrites(c.overwrites, guild, newRoleIdByTempId),
            reason: 'Restore da backup'
        }).catch(e => { console.error('[restore] create canale:', e.message); return null; });
        if (created) createdChannels++;
    }

    let restoredMembers = 0;
    for (const mr of data.memberRoles ?? []) {
        const member = guild.members.cache.get(mr.userId)
            ?? await guild.members.fetch(mr.userId).catch(() => null);
        if (!member) continue;
        const roleIds = (mr.roleTempIds ?? [])
            .map(tid => newRoleIdByTempId.get(tid))
            .filter(Boolean);
        if (!roleIds.length) continue;
        const ok = await member.roles.add(roleIds, 'Restore da backup').then(() => true).catch(() => false);
        if (ok) restoredMembers++;
    }

    return { createdChannels, createdCategories, createdRoles, restoredMembers };
}


// ================= SERVER STATS (contatori in tempo reale) =================
// Crea/aggiorna automaticamente dei canali vocali "bloccati" (nessuno può
// entrarci, servono solo a mostrare un numero nel nome) che contano membri
// verificati, staff, bot e membri totali del server — stile "📊 SERVER STATS".
//
// Discord permette di rinominare un canale al massimo 2 volte ogni 10 minuti:
// per rispettare questo limite (ed evitare errori 429) ogni canale viene
// aggiornato al massimo una volta ogni CONFIG.statsMinGapMs (default 6 min).
// Se arriva un cambiamento (join/leave/ruolo) mentre un canale è ancora in
// "cooldown", l'aggiornamento non viene perso: viene semplicemente
// riprogrammato per il primo istante utile.

const STATS_FILE = './stats_channels.json';

function loadStatsData() {
    try {
        if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    } catch (e) { console.error('[Stats] Errore lettura file:', e); }
    return {};
}

function saveStatsData(data) {
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2));
    } catch (e) { console.error('[Stats] Errore salvataggio file:', e); }
}

// Stato runtime (non persistito): ultimo aggiornamento effettivo e timeout
// pendenti, per ogni guild.
const statsRuntime = new Map();

function getStatsRuntime(guildId) {
    if (!statsRuntime.has(guildId)) {
        statsRuntime.set(guildId, { lastUpdate: 0, pendingTimeout: null, updating: false, dirty: false });
    }
    return statsRuntime.get(guildId);
}

function computeStats(guild) {
    const members = guild.members.cache;
    const bots = members.filter(m => m.user.bot).size;

    const membri = members.filter(m => !m.user.bot && m.roles.cache.has(CONFIG.memberRoleId)).size;

    const all = guild.memberCount;

    return { membri, bots, all };
}

async function ensureStatsChannels(guild) {
    const data = loadStatsData();
    const entry = data[guild.id] || { categoryId: null, channelIds: {} };

    // ── CATEGORIA ────────────────────────────────────────────────────────
    let category = entry.categoryId ? guild.channels.cache.get(entry.categoryId) : null;
    if (!category && entry.categoryId) category = await guild.channels.fetch(entry.categoryId).catch(() => null);
    if (!category) {
        category = await guild.channels.create({
            name: CONFIG.statsCategoryName,
            type: ChannelType.GuildCategory,
            permissionOverwrites: [
                { id: guild.roles.everyone, deny: [PermissionFlagsBits.Connect] }
            ]
        }).catch(e => { console.error('[Stats] Errore creazione categoria:', e.message); return null; });
        if (!category) return null;
        entry.categoryId = category.id;
    }

    // ── CANALI VOCALI "BLOCCATI" (uno per statistica) ───────────────────
    entry.channelIds = entry.channelIds || {};
    let changed = !data[guild.id];
    for (const key of Object.keys(CONFIG.statsChannels)) {
        let ch = entry.channelIds[key] ? guild.channels.cache.get(entry.channelIds[key]) : null;
        if (!ch && entry.channelIds[key]) ch = await guild.channels.fetch(entry.channelIds[key]).catch(() => null);
        if (!ch) {
            const { label, emoji } = CONFIG.statsChannels[key];
            ch = await guild.channels.create({
                name: `${emoji} ${label}: 0`,
                type: ChannelType.GuildVoice,
                parent: category.id,
                permissionOverwrites: [
                    { id: guild.roles.everyone, deny: [PermissionFlagsBits.Connect] }
                ]
            }).catch(e => { console.error(`[Stats] Errore creazione canale ${key}:`, e.message); return null; });
            if (ch) { entry.channelIds[key] = ch.id; changed = true; }
        }
    }

    if (changed) {
        data[guild.id] = entry;
        saveStatsData(data);
    }
    return entry;
}

async function performStatsUpdate(guild) {
    if (!CONFIG.statsEnabled) return;
    const runtime = getStatsRuntime(guild.id);
    if (runtime.updating) { runtime.dirty = true; return; }
    runtime.updating = true;

    try {
        // Ricarica i membri in cache se necessario (evita conteggi sballati
        // subito dopo l'avvio del bot, quando la cache è ancora parziale).
        if (guild.members.cache.size < guild.memberCount) {
            await guild.members.fetch().catch(() => {});
        }

        const entry = await ensureStatsChannels(guild);
        if (!entry) return;

        const stats = computeStats(guild);

        for (const key of Object.keys(CONFIG.statsChannels)) {
            const chId = entry.channelIds[key];
            if (!chId) continue;
            const ch = guild.channels.cache.get(chId) ?? await guild.channels.fetch(chId).catch(() => null);
            if (!ch) continue;

            const { label, emoji } = CONFIG.statsChannels[key];
            const newName = `${emoji} ${label}: ${stats[key]}`;
            if (ch.name !== newName) {
                await ch.setName(newName, 'Aggiornamento automatico Server Stats').catch(e =>
                    console.error(`[Stats] Errore rename ${key}:`, e.message)
                );
            }
        }

        runtime.lastUpdate = Date.now();
    } catch (e) {
        console.error('[Stats] Errore aggiornamento:', e);
    } finally {
        runtime.updating = false;
        if (runtime.dirty) {
            runtime.dirty = false;
            scheduleStatsUpdate(guild);
        }
    }
}

// Punto d'ingresso "sicuro" da chiamare ad ogni evento (join/leave/ruolo):
// rispetta sempre il cooldown minimo per canale, senza mai perdere un
// aggiornamento richiesto nel frattempo.
function scheduleStatsUpdate(guild) {
    if (!CONFIG.statsEnabled || !guild) return;
    const runtime = getStatsRuntime(guild.id);
    const now = Date.now();
    const elapsed = now - runtime.lastUpdate;

    if (elapsed >= CONFIG.statsMinGapMs) {
        performStatsUpdate(guild).catch(() => {});
        return;
    }

    if (!runtime.pendingTimeout) {
        const wait = CONFIG.statsMinGapMs - elapsed;
        runtime.pendingTimeout = setTimeout(() => {
            runtime.pendingTimeout = null;
            performStatsUpdate(guild).catch(() => {});
        }, wait);
    }
}

// ================= TICKET SYSTEM (assistenza) =================
// Pannello con bottone verde in un canale "assistenza": chi clicca ottiene
// un canale privato dedicato dove il bot chiede il motivo della richiesta
// tramite embed con bottoni. In base alla scelta, pinga il ruolo competente
// (problemi tra membri / problema con il bot) e blocca ulteriori click sullo
// stesso ticket per evitare ping ripetuti.

const TICKET_FILE = './ticket_data.json';

function loadTicketData() {
    try {
        if (fs.existsSync(TICKET_FILE)) return JSON.parse(fs.readFileSync(TICKET_FILE, 'utf-8'));
    } catch (e) { console.error('[Ticket] Errore lettura file:', e); }
    return { panels: {}, tickets: {} };
}

function saveTicketData(data) {
    try {
        fs.writeFileSync(TICKET_FILE, JSON.stringify(data, null, 2));
    } catch (e) { console.error('[Ticket] Errore salvataggio file:', e); }
}

function buildTicketPanelEmbed() {
    const embed = new EmbedBuilder()
        .setTitle('🎫 Assistenza')
        .setDescription(
            'Hai bisogno di aiuto? Clicca il pulsante qui sotto per aprire un ticket privato ' +
            'con lo staff.\n\nRiceverai un canale dedicato dove potrai spiegare il tuo problema.'
        )
        .setColor('#2ecc71')
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('ticket_open')
            .setLabel('Apri Ticket')
            .setEmoji('🎫')
            .setStyle(ButtonStyle.Success)
    );

    return { embeds: [embed], components: [row] };
}

function buildTicketReasonEmbed(member) {
    const embed = new EmbedBuilder()
        .setTitle('🎫 Nuovo Ticket')
        .setDescription(
            `Ciao ${member}, grazie per averci contattato!\n\n` +
            `Seleziona qui sotto il motivo per cui hai richiesto assistenza, così potremo ` +
            `avvisare subito la persona giusta.`
        )
        .setColor('#5865F2')
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        Object.entries(CONFIG.ticketReasonRoles).map(([key, cfg]) =>
            new ButtonBuilder()
                .setCustomId(`ticket_reason_${key}`)
                .setLabel(cfg.label)
                .setEmoji(cfg.emoji)
                .setStyle(ButtonStyle.Primary)
        )
    );

    return { embeds: [embed], components: [row] };
}

function buildTicketCloseRow(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('ticket_close')
            .setLabel('Chiudi Ticket')
            .setEmoji('🔒')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled)
    );
}

async function ensureTicketPanel(guild) {
    if (!CONFIG.ticketEnabled) return null;
    const data = loadTicketData();
    const panelEntry = data.panels[guild.id] || {};

    // ── CATEGORIA TICKET ─────────────────────────────────────────────────
    let category = panelEntry.categoryId ? guild.channels.cache.get(panelEntry.categoryId) : null;
    if (!category && panelEntry.categoryId) category = await guild.channels.fetch(panelEntry.categoryId).catch(() => null);
    if (!category) {
        category = await guild.channels.create({
            name: CONFIG.ticketCategoryName,
            type: ChannelType.GuildCategory
        }).catch(e => { console.error('[Ticket] Errore creazione categoria:', e.message); return null; });
        if (!category) return null;
        panelEntry.categoryId = category.id;
    }

    // ── CANALE PANNELLO "assistenza" (sola lettura per gli utenti) ────────
    let panelChannel = panelEntry.panelChannelId ? guild.channels.cache.get(panelEntry.panelChannelId) : null;
    if (!panelChannel && panelEntry.panelChannelId) panelChannel = await guild.channels.fetch(panelEntry.panelChannelId).catch(() => null);
    if (!panelChannel) {
        panelChannel = await guild.channels.create({
            name: CONFIG.ticketPanelChannelName,
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone,
                    allow: [PermissionFlagsBits.ViewChannel],
                    deny: [PermissionFlagsBits.SendMessages]
                }
            ]
        }).catch(e => { console.error('[Ticket] Errore creazione canale pannello:', e.message); return null; });
        if (!panelChannel) return null;
        panelEntry.panelChannelId = panelChannel.id;
        panelEntry.panelMessageId = null;
    }

    // ── MESSAGGIO PANNELLO (embed + bottone verde) ────────────────────────
    let panelMessage = panelEntry.panelMessageId
        ? await panelChannel.messages.fetch(panelEntry.panelMessageId).catch(() => null)
        : null;
    if (!panelMessage) {
        panelMessage = await panelChannel.send(buildTicketPanelEmbed()).catch(e => {
            console.error('[Ticket] Errore invio pannello:', e.message);
            return null;
        });
        if (panelMessage) panelEntry.panelMessageId = panelMessage.id;
    }

    data.panels[guild.id] = panelEntry;
    saveTicketData(data);
    return panelEntry;
}

function findOpenTicket(data, guildId, userId) {
    for (const [channelId, t] of Object.entries(data.tickets)) {
        if (t.guildId === guildId && t.userId === userId && t.status === 'open') {
            return { channelId, ticket: t };
        }
    }
    return null;
}

async function handleTicketOpen(interaction) {
    const guild = interaction.guild;
    const data = loadTicketData();

    // Evita ticket duplicati per lo stesso utente.
    const existing = findOpenTicket(data, guild.id, interaction.user.id);
    if (existing) {
        const ch = guild.channels.cache.get(existing.channelId);
        return interaction.reply({
            content: ch ? `⚠️ Hai già un ticket aperto: ${ch}` : '⚠️ Risulti avere già un ticket aperto.',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    const panelEntry = data.panels[guild.id];
    const categoryId = panelEntry?.categoryId;

    // Permessi: solo l'utente che apre il ticket + ruoli staff/competenti
    // possono vedere il canale. Tutti gli altri (incluso @everyone) esclusi.
    const staffRoleIds = Object.values(CONFIG.staffRoleIds || {}).filter(id => id && id !== "0");
    const reasonRoleIds = Object.values(CONFIG.ticketReasonRoles || {}).map(r => r.roleId).filter(Boolean);
    const allowedRoleIds = [...new Set([...staffRoleIds, ...reasonRoleIds])];

    const overwrites = [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        {
            id: interaction.user.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
        }
    ];
    for (const rid of allowedRoleIds) {
        overwrites.push({
            id: rid,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
        });
    }

    const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'utente';

    let ticketChannel;
    try {
        ticketChannel = await guild.channels.create({
            name: `ticket-${safeName}`,
            type: ChannelType.GuildText,
            parent: categoryId || undefined,
            permissionOverwrites: overwrites,
            topic: `Ticket di ${interaction.user.tag} (${interaction.user.id})`
        });
    } catch (e) {
        console.error('[Ticket] Errore creazione canale ticket:', e.message);
        return interaction.editReply('❌ Errore durante la creazione del ticket. Contatta lo staff.');
    }

    data.tickets[ticketChannel.id] = {
        guildId: guild.id,
        userId: interaction.user.id,
        reason: null,
        status: 'open',
        createdAt: Date.now()
    };
    saveTicketData(data);

    const { embeds, components } = buildTicketReasonEmbed(interaction.member);
    await ticketChannel.send({ content: `${interaction.member}`, embeds, components }).catch(() => {});

    await interaction.editReply(`✅ Ticket creato: ${ticketChannel}`);
}

async function handleTicketReason(interaction, reasonKey) {
    const guild = interaction.guild;
    const data = loadTicketData();
    const ticket = data.tickets[interaction.channel.id];

    if (!ticket || ticket.guildId !== guild.id) {
        return interaction.reply({ content: '❌ Questo canale non risulta essere un ticket valido.', ephemeral: true });
    }
    if (ticket.userId !== interaction.user.id) {
        return interaction.reply({ content: '❌ Solo chi ha aperto il ticket può selezionare il motivo.', ephemeral: true });
    }
    if (ticket.reason) {
        return interaction.reply({
            content: `⚠️ Il motivo è già stato selezionato (**${CONFIG.ticketReasonRoles[ticket.reason]?.label}**).`,
            ephemeral: true
        });
    }

    const reasonCfg = CONFIG.ticketReasonRoles[reasonKey];
    if (!reasonCfg) {
        return interaction.reply({ content: '❌ Motivo non riconosciuto.', ephemeral: true });
    }

    ticket.reason = reasonKey;
    data.tickets[interaction.channel.id] = ticket;
    saveTicketData(data);

    // Disabilita i bottoni del motivo (uno per ticket) per evitare ping multipli.
    const disabledRow = new ActionRowBuilder().addComponents(
        Object.entries(CONFIG.ticketReasonRoles).map(([key, cfg]) =>
            new ButtonBuilder()
                .setCustomId(`ticket_reason_${key}`)
                .setLabel(cfg.label)
                .setEmoji(cfg.emoji)
                .setStyle(key === reasonKey ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setDisabled(true)
        )
    );
    await interaction.update({ components: [disabledRow] }).catch(() => {});

    const notifyEmbed = new EmbedBuilder()
        .setTitle(`${reasonCfg.emoji} ${reasonCfg.label}`)
        .setDescription(
            `${interaction.user} ha selezionato **${reasonCfg.label}** come motivo del ticket.\n` +
            `<@&${reasonCfg.roleId}> è stato notificato.`
        )
        .setColor('#f1c40f')
        .setTimestamp();

    await interaction.channel.send({
        content: `<@&${reasonCfg.roleId}>`,
        embeds: [notifyEmbed],
        components: [buildTicketCloseRow()]
    }).catch(() => {});
}

async function handleTicketClose(interaction) {
    const data = loadTicketData();
    const ticket = data.tickets[interaction.channel.id];

    if (!ticket) {
        return interaction.reply({ content: '❌ Questo canale non risulta essere un ticket valido.', ephemeral: true });
    }

    const staffRoleIds = Object.values(CONFIG.staffRoleIds || {}).filter(id => id && id !== "0");
    const member = interaction.member;
    const isStaff = (member && member.roles.cache.some(r => staffRoleIds.includes(r.id))) || isImmune(member);
    const isOwnerOfTicket = ticket.userId === interaction.user.id;

    if (!isStaff && !isOwnerOfTicket) {
        return interaction.reply({ content: '❌ Non puoi chiudere questo ticket.', ephemeral: true });
    }

    await interaction.reply({ content: '🔒 Chiusura ticket in corso… il canale verrà eliminato tra 5 secondi.' });

    ticket.status = 'closed';
    ticket.closedAt = Date.now();
    ticket.closedBy = interaction.user.id;
    data.tickets[interaction.channel.id] = ticket;
    saveTicketData(data);

    await broadcastLog(
        interaction.guild,
        '🔒 Ticket Chiuso',
        `Ticket <#${interaction.channel.id}> aperto da <@${ticket.userId}> chiuso da **${interaction.user.tag}**.`,
        '#95a5a6'
    ).catch(() => {});

    await delay(5000);
    await interaction.channel.delete('Ticket chiuso').catch(() => {});

    // Pulizia record (evita che ticket_data.json cresca all'infinito).
    const freshData = loadTicketData();
    delete freshData.tickets[interaction.channel.id];
    saveTicketData(freshData);
}

// ================= ANTI-NUKE: RIPARAZIONE AUTOMATICA =================
// Funzioni che tentano di ripristinare automaticamente ciò che è stato
// modificato/eliminato da un'azione NON autorizzata. Vengono chiamate SOLO
// quando l'esecutore non è owner/whitelist/ruolo immune e NON ha permessi
// !concedi attivi (cioè quando l'anti-nuke punisce davvero l'utente).

function extractOldChanges(entry) {
    const changes = {};
    for (const c of entry.changes ?? []) changes[c.key] = c.old;
    return changes;
}

async function repairChannelDelete(guild, entry) {
    const changes = extractOldChanges(entry);
    try {
        const created = await guild.channels.create({
            name: changes.name || `canale-ripristinato-${Date.now()}`,
            type: changes.type ?? ChannelType.GuildText,
            topic: changes.topic ?? undefined,
            nsfw: changes.nsfw ?? undefined,
            bitrate: changes.bitrate ?? undefined,
            userLimit: changes.user_limit ?? undefined,
            rateLimitPerUser: changes.rate_limit_per_user ?? undefined,
            reason: 'Anti-Nuke: ripristino automatico canale eliminato senza autorizzazione'
        });
        return created;
    } catch (e) {
        console.error('[repairChannelDelete]', e.message);
        return null;
    }
}

async function repairChannelCreate(guild, entry) {
    try {
        const ch = await guild.channels.fetch(entry.targetId).catch(() => null);
        if (ch) {
            await ch.delete('Anti-Nuke: rollback creazione canale non autorizzata');
            return true;
        }
        return false;
    } catch (e) {
        console.error('[repairChannelCreate]', e.message);
        return false;
    }
}

async function repairChannelUpdate(guild, entry) {
    try {
        const channel = guild.channels.cache.get(entry.targetId) ?? await guild.channels.fetch(entry.targetId).catch(() => null);
        if (!channel) return false;

        const updateData = {};
        for (const c of entry.changes ?? []) {
            if (c.key === 'name') updateData.name = c.old;
            if (c.key === 'topic') updateData.topic = c.old;
            if (c.key === 'nsfw') updateData.nsfw = c.old;
            if (c.key === 'bitrate') updateData.bitrate = c.old;
            if (c.key === 'user_limit') updateData.userLimit = c.old;
            if (c.key === 'rate_limit_per_user') updateData.rateLimitPerUser = c.old;
        }
        if (Object.keys(updateData).length === 0) return false;

        await channel.edit({ ...updateData, reason: 'Anti-Nuke: rollback automatico modifica canale non autorizzata' });
        return true;
    } catch (e) {
        console.error('[repairChannelUpdate]', e.message);
        return false;
    }
}

async function repairRoleDelete(guild, entry) {
    const changes = extractOldChanges(entry);
    try {
        const created = await guild.roles.create({
            name: changes.name || `ruolo-ripristinato-${Date.now()}`,
            color: changes.color ?? undefined,
            hoist: changes.hoist ?? undefined,
            mentionable: changes.mentionable ?? undefined,
            permissions: changes.permissions !== undefined ? BigInt(changes.permissions) : undefined,
            reason: 'Anti-Nuke: ripristino automatico ruolo eliminato senza autorizzazione'
        });
        return created;
    } catch (e) {
        console.error('[repairRoleDelete]', e.message);
        return null;
    }
}

async function repairRoleCreate(guild, entry) {
    try {
        const role = guild.roles.cache.get(entry.targetId) ?? await guild.roles.fetch(entry.targetId).catch(() => null);
        if (role) {
            await role.delete('Anti-Nuke: rollback creazione ruolo non autorizzata');
            return true;
        }
        return false;
    } catch (e) {
        console.error('[repairRoleCreate]', e.message);
        return false;
    }
}

async function repairRoleUpdate(guild, entry) {
    try {
        const role = guild.roles.cache.get(entry.targetId) ?? await guild.roles.fetch(entry.targetId).catch(() => null);
        if (!role) return false;

        const updateData = {};
        for (const c of entry.changes ?? []) {
            if (c.key === 'name') updateData.name = c.old;
            if (c.key === 'color') updateData.color = c.old;
            if (c.key === 'hoist') updateData.hoist = c.old;
            if (c.key === 'mentionable') updateData.mentionable = c.old;
            if (c.key === 'permissions') updateData.permissions = c.old !== undefined ? BigInt(c.old) : undefined;
        }
        if (Object.keys(updateData).length === 0) return false;

        await role.edit({ ...updateData, reason: 'Anti-Nuke: rollback automatico modifica ruolo non autorizzata' });
        return true;
    } catch (e) {
        console.error('[repairRoleUpdate]', e.message);
        return false;
    }
}

async function repairBan(guild, entry) {
    try {
        await guild.members.unban(entry.targetId, 'Anti-Nuke: rollback automatico ban non autorizzato');
        return true;
    } catch (e) {
        console.error('[repairBan]', e.message);
        return false;
    }
}

// Esegue UN tentativo di riparazione per l'entry data. Ritorna sempre
// { success, message }: "success" determina se la coda di riparazione (sotto)
// considera l'operazione conclusa oppure la rimette in coda per un nuovo
// tentativo.
async function autoRepairAttempt(guild, entry) {
    try {
        switch (entry.action) {
            case AuditLogEvent.ChannelDelete: {
                const created = await repairChannelDelete(guild, entry);
                return created
                    ? { success: true, message: `✅ Canale **#${created.name}** ricreato automaticamente.` }
                    : { success: false, message: '❌ Impossibile ricreare il canale eliminato.' };
            }
            case AuditLogEvent.ChannelCreate: {
                const ok = await repairChannelCreate(guild, entry);
                return ok
                    ? { success: true, message: '✅ Canale creato senza autorizzazione, eliminato automaticamente.' }
                    : { success: false, message: '⚠️ Canale non trovato (forse già rimosso).' };
            }
            case AuditLogEvent.ChannelUpdate: {
                const ok = await repairChannelUpdate(guild, entry);
                // Nessuna modifica da annullare / canale non trovato: non è un vero
                // fallimento (nulla da riparare), quindi non va ritentato.
                return { success: true, message: ok ? '✅ Modifiche al canale annullate automaticamente.' : '⚠️ Nessuna modifica da annullare o canale non trovato.' };
            }
            case AuditLogEvent.RoleDelete: {
                const created = await repairRoleDelete(guild, entry);
                return created
                    ? { success: true, message: `✅ Ruolo **@${created.name}** ricreato automaticamente.` }
                    : { success: false, message: '❌ Impossibile ricreare il ruolo eliminato.' };
            }
            case AuditLogEvent.RoleCreate: {
                const ok = await repairRoleCreate(guild, entry);
                return ok
                    ? { success: true, message: '✅ Ruolo creato senza autorizzazione, eliminato automaticamente.' }
                    : { success: false, message: '⚠️ Ruolo non trovato (forse già rimosso).' };
            }
            case AuditLogEvent.RoleUpdate: {
                const ok = await repairRoleUpdate(guild, entry);
                return { success: true, message: ok ? '✅ Modifiche al ruolo annullate automaticamente.' : '⚠️ Nessuna modifica da annullare o ruolo non trovato.' };
            }
            case AuditLogEvent.MemberBanAdd: {
                const ok = await repairBan(guild, entry);
                return ok
                    ? { success: true, message: '✅ Ban rimosso automaticamente.' }
                    : { success: false, message: '❌ Impossibile rimuovere il ban automaticamente.' };
            }
            case AuditLogEvent.MemberKick: {
                return { success: true, message: '⚠️ Il kick non può essere annullato automaticamente: l\'utente deve essere reinvitato manualmente.' };
            }
            default:
                return { success: true, message: null };
        }
    } catch (e) {
        return { success: false, message: `Errore: ${e.message}` };
    }
}

// ================= AGGREGAZIONE INCIDENTI ANTI-NUKE =================
// Raggruppa più azioni non autorizzate dello stesso esecutore (es. un nuke
// con decine di canali/ruoli eliminati in pochi secondi) in UN SOLO
// "incidente": un solo timeout, UN SOLO log di attivazione e UN SOLO log di
// riepilogo riparazione — invece di un embed per ogni singola azione, che
// altrimenti spamma il canale log e può far scattare rate limit su Discord.

const NUKE_INCIDENT_REPORT_DELAY_MS = 3000; // attesa "silenzio" prima del riepilogo attivazione
const nukeIncidents = new Map(); // key `${guildId}:${executorId}` -> incident

function getOrCreateNukeIncident(guild, executor) {
    const key = `${guild.id}:${executor.id}`;
    let incident = nukeIncidents.get(key);
    if (incident) return incident;

    incident = {
        key,
        guild,
        executorTag: executor.tag,
        executorId: executor.id,
        actions: [],
        punishStatus: null,
        reportTimer: null,
        totalJobs: 0,
        completedJobs: 0,
        repairSuccess: 0,
        repairFailed: 0,
        reportSent: false,
        repairSummarySent: false
    };
    nukeIncidents.set(key, incident);
    return incident;
}

async function punishIncident(incident, execMember) {
    if (incident.punishStatus) return; // già punito UNA volta per questo incidente
    if (!execMember) {
        incident.punishStatus = '⚠️ Membro non trovato in cache (impossibile punire).';
        return;
    }
    if (execMember.communicationDisabledUntilTimestamp && execMember.communicationDisabledUntilTimestamp > Date.now()) {
        incident.punishStatus = '✅ Già in timeout (nessuna azione ulteriore necessaria).';
        return;
    }

    // ── FALLBACK KICK ──────────────────────────────────────────────────────
    // Se il timeout non è applicabile (utente con permessi Administrator o
    // ruolo comunque "immune" al timeout per regole interne di Discord/gerarchia
    // ruoli del bot), proviamo comunque a espellerlo, se il bot ne ha il
    // permesso/gerarchia sufficiente.
    if (!execMember.moderatable) {
        if (execMember.kickable) {
            const kicked = await execMember.kick('Anti-Nuke: azioni multiple non autorizzate — timeout non applicabile, espulso come fallback')
                .then(() => true)
                .catch(err => {
                    console.error('[punishIncident] Errore kick fallback:', err.message);
                    return false;
                });
            incident.punishStatus = kicked
                ? '👢 Timeout non applicabile (utente immune) → espulso dal server.'
                : '❌ Timeout non applicabile e kick fallito.';
        } else {
            incident.punishStatus = '❌ Ruolo troppo alto: impossibile applicare timeout o kick.';
        }
        return;
    }

    await execMember.timeout(CONFIG.timeoutUnOra, 'Anti-Nuke: azioni multiple non autorizzate rilevate').catch(console.error);
    incident.punishStatus = '✅ Timeout 1h applicato.';
}

function scheduleNukeIncidentReport(incident) {
    if (incident.reportTimer) clearTimeout(incident.reportTimer);
    incident.reportTimer = setTimeout(() => sendNukeIncidentReport(incident.key), NUKE_INCIDENT_REPORT_DELAY_MS);
}

function sendNukeIncidentReport(key) {
    const incident = nukeIncidents.get(key);
    if (!incident || incident.reportSent) return;
    incident.reportSent = true;
    // Libera lo slot: se l'attaccante riprende dopo il report, parte un
    // nuovo incidente (nuovo log) invece di riaprire quello vecchio.
    nukeIncidents.delete(key);

    const counts = {};
    for (const a of incident.actions) counts[a.reason] = (counts[a.reason] || 0) + 1;
    const detailText = Object.entries(counts).map(([r, c]) => `${r} × ${c}`).join('\n') || 'N/A';

    const embed = new EmbedBuilder()
        .setTitle('⚠️ ANTI-NUKE ATTIVATO ⚠️')
        .setColor(0xFF0000)
        .addFields(
            { name: 'Utente Punito', value: `${incident.executorTag} (\`${incident.executorId}\`)`, inline: true },
            { name: 'Azioni Rilevate', value: `${incident.actions.length}`, inline: true },
            { name: 'Punizione', value: incident.punishStatus || 'N/A' },
            { name: 'Dettaglio Violazioni', value: detailText },
            { name: '🔧 Riparazione Automatica', value: `⏳ Accodata (${incident.totalJobs} elementi). Riceverai UN riepilogo a fine riparazione.` }
        ).setTimestamp();

    sendLog(incident.guild, embed).catch(() => {});

    // Se la riparazione ha già finito tutto prima di questo report, manda
    // subito anche il riepilogo finale.
    maybeSendRepairSummary(incident);
}

function maybeSendRepairSummary(incident) {
    if (!incident.reportSent) return;              // aspetta prima il report di attivazione
    if (incident.completedJobs < incident.totalJobs) return; // riparazione non ancora finita
    if (incident.repairSummarySent) return;
    incident.repairSummarySent = true;

    const embed = new EmbedBuilder()
        .setTitle('🔧 Riparazione Automatica — Riepilogo')
        .setColor(incident.repairFailed > 0 ? 0xe67e22 : 0x2ecc71)
        .setDescription(
            `Riparazione completata per l'incidente di **${incident.executorTag}**.\n` +
            `✅ Riusciti: **${incident.repairSuccess}**\n` +
            (incident.repairFailed > 0 ? `❌ Falliti: **${incident.repairFailed}** (verifica manuale consigliata)` : '')
        )
        .setTimestamp();

    sendLog(incident.guild, embed).catch(() => {});
}

// ================= CODA DI RIPARAZIONE PERSISTENTE =================
// A differenza di una singola chiamata sincrona, questa coda (una per guild)
// NON si ferma al primo fallimento o rate limit: ogni elemento fallito viene
// rimesso in coda con un backoff crescente e ritentato, finché non riesce o
// esaurisce i tentativi massimi. Elementi diversi (es. 20 canali eliminati
// in sequenza) restano tutti in coda e vengono lavorati uno dopo l'altro
// finché il server non è completamente sistemato — anche se vengono
// eliminati o modificati TUTTI i canali/ruoli contemporaneamente.
//
// I log per-singolo-elemento sono stati rimossi: i risultati vengono
// accumulati nell'"incidente" (vedi sopra) e comunicati con UN SOLO
// riepilogo finale, per evitare di spammare il canale log durante un nuke.

const REPAIR_MAX_ATTEMPTS = 15;
const REPAIR_BASE_DELAY_MS = 300;    // 0.3s — primo retry quasi immediato
const REPAIR_MAX_DELAY_MS = 8000;    // tetto massimo di attesa: 8s
// Quante riparazioni processare CONTEMPORANEAMENTE per ogni server: invece
// di sistemare un canale/ruolo alla volta, più worker lavorano in parallelo
// sulla stessa coda, così anche decine di elementi danneggiati insieme
// vengono sistemati quasi tutti assieme invece che in fila indiana.
const REPAIR_CONCURRENCY = 5;

const repairQueues = new Map();   // guildId -> array di { entry, attempts, incident }
const repairRunning = new Map();  // guildId -> boolean

function enqueueRepair(guild, entry, incident = null) {
    if (!guild || !entry) return;
    if (!repairQueues.has(guild.id)) repairQueues.set(guild.id, []);
    repairQueues.get(guild.id).push({ entry, attempts: 0, incident });
    runRepairQueue(guild).catch(e => console.error('[RepairQueue] Errore fatale:', e));
}

// Un singolo "worker": estrae un elemento alla volta dalla coda condivisa e
// lo lavora, rimettendolo in fondo alla coda in caso di fallimento (con
// backoff). Più worker attivi insieme = più riparazioni in parallelo.
// .shift() su un array è sincrono in JS: più worker possono chiamarlo senza
// race condition, ognuno prende sempre un elemento diverso.
async function repairWorker(guild, queue) {
    while (queue.length > 0) {
        const job = queue.shift();
        if (!job) return;

        const result = await autoRepairAttempt(guild, job.entry);

        if (result.success) {
            if (job.incident) {
                job.incident.repairSuccess++;
                job.incident.completedJobs++;
                maybeSendRepairSummary(job.incident);
            }
            continue;
        }

        job.attempts++;
        if (job.attempts < REPAIR_MAX_ATTEMPTS) {
            // Rimessa in coda: NON ci si ferma qui. Un backoff crescente
            // (0.3s, 0.6s, 1.2s, ... fino a un tetto di 8s) dà tempo a
            // eventuali rate limit di Discord di esaurirsi prima del prossimo
            // tentativo, senza bloccare gli altri worker che nel frattempo
            // continuano a lavorare sul resto della coda.
            const wait = Math.min(REPAIR_BASE_DELAY_MS * Math.pow(2, job.attempts - 1), REPAIR_MAX_DELAY_MS);
            await delay(wait);
            queue.push(job);
        } else {
            console.error(`[RepairQueue] Riparazione fallita definitivamente dopo ${REPAIR_MAX_ATTEMPTS} tentativi:`, result.message);
            if (job.incident) {
                job.incident.repairFailed++;
                job.incident.completedJobs++;
                maybeSendRepairSummary(job.incident);
            }
        }
    }
}

async function runRepairQueue(guild) {
    if (repairRunning.get(guild.id)) return; // già in esecuzione per questa guild
    repairRunning.set(guild.id, true);

    try {
        const queue = repairQueues.get(guild.id);
        if (!queue) return;

        // Avvia N worker in parallelo sulla stessa coda condivisa: la coda
        // continua ad essere lavorata da tutti finché non si svuota, anche
        // se nel frattempo arrivano nuovi elementi (es. altri canali
        // eliminati mentre la riparazione è già in corso).
        const workers = Array.from({ length: REPAIR_CONCURRENCY }, () => repairWorker(guild, queue));
        await Promise.all(workers);
    } finally {
        repairRunning.set(guild.id, false);
        // Se nel frattempo sono arrivati nuovi elementi (race condition tra lo
        // svuotamento della coda e l'arrivo di un nuovo evento), riavvia subito.
        const queue = repairQueues.get(guild.id);
        if (queue && queue.length > 0) runRepairQueue(guild).catch(() => {});
    }
}

// ================= ANTI-NUKE (VELOCIZZATO + AUTO-REPAIR) =================

// gestisciAzione ora riceve direttamente l'AuditLogEntry (non più stringhe
// pre-formattate): questo permette, in caso di azione non autorizzata, di
// passare l'entry completa alla riparazione automatica (autoRepair), che ha
// bisogno di entry.changes/entry.targetId per ripristinare lo stato precedente.
async function gestisciAzione(guild, entry) {
    if (!guild || !entry || !entry.executor) return;
    const executor = entry.executor;
    const botId = client.user?.id;

    if (botId && executor.id === botId) return;

    const reason = AUDIT_ACTION_REASONS.get(entry.action) || 'Azione sensibile rilevata';
    const targetInfo = formatAuditTargetInfo(entry);

    // Preferisci la cache (istantanea) al fetch REST (latenza di rete);
    // fetch solo se il membro non è già in cache.
    let execMember = guild.members.cache.get(executor.id) ?? null;
    if (!execMember) execMember = await guild.members.fetch(executor.id).catch(() => null);

    // ── ESECUTORE PROTETTO (owner/whitelist/ruolo immune) ───────────────────
    // Azione autorizzata a priori: NESSUNA punizione, NESSUNA riparazione.
    if (
        executor.id === CONFIG.ownerId ||
        CONFIG.whitelistedIds.includes(executor.id) ||
        (execMember && isImmune(execMember))
    ) {
        sendLog(guild, new EmbedBuilder()
            .setTitle("👑 AZIONE AUTORIZZATA")
            .setColor(0x00FF00)
            .setDescription("Azione sensibile da account protetto (founder/whitelist/ruolo immune). Nessuna contromisura, nessuna riparazione.")
            .addFields(
                { name: "Autore", value: `${executor.tag} (\`${executor.id}\`)`, inline: true },
                { name: "Azione", value: reason, inline: true },
                { name: "Bersaglio", value: targetInfo }
            ).setTimestamp()).catch(() => {});
        return;
    }

    // ── ESECUTORE CON PERMESSI !concedi ATTIVI ───────────────────────────────
    // Azione già autorizzata manualmente dal founder: consuma un permesso,
    // NESSUNA punizione, NESSUNA riparazione (è ciò che l'utente aveva chiesto
    // di controllare).
    const permRimasti = getPermessi(executor.id);
    if (permRimasti > 0) {
        setPermessi(executor.id, permRimasti - 1);
        sendLog(guild, new EmbedBuilder()
            .setTitle("🛡️ AZIONE AUTORIZZATA (STAFF)")
            .setColor(0x00AFFF)
            .addFields(
                { name: "Autore", value: `${executor.tag} (\`${executor.id}\`)`, inline: true },
                { name: "Azione", value: reason, inline: true },
                { name: "Bersaglio", value: targetInfo },
                { name: "Permessi Rimanenti", value: `${permRimasti - 1}` }
            ).setTimestamp()).catch(() => {});
        return;
    }

    // ── ESECUTORE NON AUTORIZZATO ────────────────────────────────────────────
    // Applica la punizione (solo timeout, nessuna rimozione ruoli) E accoda
    // la riparazione automatica dello stato del server. Questo ramo viene
    // raggiunto SOLO se l'esecutore non è owner/whitelist/ruolo immune E non
    // ha permessi !concedi attivi — in tutti gli altri casi (sopra) la
    // funzione è già uscita con un return, quindi né la punizione né la
    // riparazione vengono mai applicate a chi ha !concedi attivo.
    //
    // NOVITÀ: tutte le azioni dello stesso esecutore vengono raggruppate in
    // UN SOLO "incidente" (vedi sezione AGGREGAZIONE INCIDENTI ANTI-NUKE più
    // sopra): un solo timeout, UN SOLO embed di attivazione (dopo qualche
    // secondo di "silenzio" dall'attaccante) e UN SOLO riepilogo di
    // riparazione — invece di un embed per ogni singolo canale/ruolo colpito,
    // che con un nuke vero produceva centinaia di messaggi e rischiava
    // rate limit / "bug" del bot.
    try {
        const incident = getOrCreateNukeIncident(guild, executor);
        incident.actions.push({ reason, targetInfo });

        await punishIncident(incident, execMember); // timeout applicato UNA sola volta per incidente

        incident.totalJobs++;
        enqueueRepair(guild, entry, incident);

        // Riprogramma il riepilogo ad ogni nuova azione: un unico embed verrà
        // inviato solo dopo qualche secondo di "silenzio" dallo stesso utente.
        scheduleNukeIncidentReport(incident);
    } catch (e) { console.error('[gestisciAzione]', e); }
}

// ================= EVENTI: MESSAGGI =================

client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot || !message.member) return;

    // ── COMANDI CON PREFISSO ────────────────────────────────────────────────
    if (message.content.startsWith('!')) {
        const args    = message.content.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        if (command === 'concedi' || command === 'allow') {
            if (message.author.id !== CONFIG.ownerId) {
                return message.reply('❌ Solo il founder può usare questo comando.');
            }
            const target = message.mentions.members.first();
            const amount = parseInt(args[1]);
            if (!target || isNaN(amount) || amount <= 0) {
                return message.reply('⚠️ Uso: `!concedi @utente <numero>`');
            }
            const curr = getPermessi(target.id);
            setPermessi(target.id, curr + amount);
            return message.reply(
                `✅ **${amount}** permessi concessi a ${target.user.tag}. ` +
                `Totale: **${curr + amount}** (scadono in 30 min).`
            );
        }

        if (command === 'toglipermessi') {
            if (message.author.id !== CONFIG.ownerId) {
                return message.reply('❌ Solo il founder può usare questo comando.');
            }
            const target = message.mentions.members.first();
            const amount = parseInt(args[1]);
            if (!target || isNaN(amount) || amount <= 0) {
                return message.reply('⚠️ Uso: `!toglipermessi @utente <numero>`');
            }
            const curr = getPermessi(target.id);
            const newVal = Math.max(0, curr - amount);
            setPermessi(target.id, newVal);
            return message.reply(
                `✅ **${amount}** permessi rimossi a ${target.user.tag}. ` +
                `Rimasti: **${newVal}**.`
            );
        }

        if (command === 'lock') {
            if (message.author.id !== CONFIG.ownerId) {
                return message.reply('❌ Solo il founder può usare questo comando.');
            }
            if (lockdownActive) return message.reply('⚠️ Il lockdown è già attivo.');
            const motivo = args.join(' ') || 'Lockdown manuale dal founder';
            await activateLockdown(message.guild, motivo);
            return message.reply('🔒 Lockdown attivato.');
        }

        if (command === 'unlock') {
            if (message.author.id !== CONFIG.ownerId) {
                return message.reply('❌ Solo il founder può usare questo comando.');
            }
            if (!lockdownActive) return message.reply('⚠️ Il lockdown non è attivo.');
            await deactivateLockdown(message.guild, 'Sblocco manuale dal founder');
            return message.reply('🔓 Lockdown rimosso.');
        }
    }

    // ── IMMUNITY CHECK ──────────────────────────────────────────────────────
    const immunity = antiViolation.isImmune(
        message.member,
        CONFIG.ownerId,
        CONFIG.whitelistedIds,
        CONFIG.immuneRoleId
    );

    // ── VERIFY CHANNEL ──────────────────────────────────────────────────────
    if (message.channelId === CONFIG.verifyChannelId && !immunity) {
        return message.delete().catch(() => {});
    }

    // ── FREE CHANNELS (AI) ──────────────────────────────────────────────────
    if (antiViolation.isFreeChannel(message.channelId, CONFIG.aiFreeChannels)) {
        return;
    }

    // ── ANTI-LINK ──────────────────────────────────────────────────────────
    const inviteRegex = /(https?:\/\/)?(www\.)?(discord\.(gg|io|me|li)|discordapp\.com\/invite)\/.+/i;
    if (inviteRegex.test(message.content)) {
        if (immunity === 'OWNER') return sendOwnerAlert(message.channel, message.author);
        if (immunity) return;
        if (message.deletable) await message.delete().catch(() => {});
        await broadcastLog(message.guild, '⚠️ Anti-Link',
            `${message.author.tag} in <#${message.channelId}> ha inviato un invite link → eliminato.`, '#f39c12');
        return;
    }

    // ── ANTI-PING ──────────────────────────────────────────────────────────
    const totalPings = message.mentions.users.size +
                       message.mentions.roles.size +
                       (message.mentions.everyone ? 1 : 0);

    if (totalPings > 0) {
        if (immunity === 'OWNER' && totalPings >= CONFIG.textPingLimit) {
            return sendOwnerAlert(message.channel, message.author);
        }
        if (!immunity) {
            const targets = antiViolation.extractPingTargets(message);
            const sanctioned = await antiViolation.handlePing(message, targets, totalPings, broadcastLog);
            if (sanctioned) return;
        }
    }

    // ── ANTI-SPAM ──────────────────────────────────────────────────────────
    if (!immunity) {
        const wasSpam = await antiViolation.handleSpam(message, broadcastLog);
        if (wasSpam) return;
    }

    // ── RUOLO MEMBRO ────────────────────────────────────────────────────────
    if (!immunity && !message.member.roles.cache.has(CONFIG.memberRoleId)) {
        return message.delete().catch(() => {});
    }
});

// ================= EVENTI: MEMBRI =================

client.on('guildMemberAdd', async (member) => {
    // ── SERVER STATS ─────────────────────────────────────────────────────
    // Anche se il membro viene kickato subito dopo (lockdown/raid), il
    // conteggio si aggiorna comunque correttamente al momento del kick
    // tramite l'evento guildMemberRemove.
    scheduleStatsUpdate(member.guild);

    if (lockdownActive || raidModeActive) {
        if (member.kickable) await member.kick('Lockdown server attivo — riprova più tardi.').catch(() => {});
        return;
    }

    // ── ANTI-RAID (NUOVO) ───────────────────────────────────────────────────
    const shouldLockdown = await antiViolation.handleRaidJoin(member);
    if (shouldLockdown) {
        // Kick del membro che ha fatto scattare la soglia + attivazione lockdown
        // in PARALLELO: la contromisura non aspetta il completamento dell'altra.
        await Promise.all([
            member.kickable ? member.kick('Lockdown server attivo — riprova più tardi.').catch(() => {}) : Promise.resolve(),
            activateLockdown(
                member.guild,
                `Join flood: ${CONFIG.raidJoinLimit + 1}+ account entrati in ${CONFIG.raidJoinTime / 1000}s`
            )
        ]);
        return;
    }

    // ── BOT SOSPETTO: TIMEOUT 7 GIORNI + LOG DEDICATO ────────────────────────
    if (member.user.bot) {
        try {
            if (member.moderatable) {
                await member.timeout(CONFIG.suspiciousBotTimeoutMs, 'Bot sospetto entrato nel server — timeout automatico 7 giorni').catch(err => {
                    console.error(`[SuspiciousBot] Timeout ${member.id}:`, err.message);
                });
            } else {
                console.warn(`[SuspiciousBot] Impossibile applicare il timeout a ${member.user.tag}: membro non moderabile.`);
            }
            await sendSuspiciousBotLog(member.guild, member).catch(err => {
                console.error(`[SuspiciousBot] Errore log ${member.id}:`, err.message);
            });
        } catch (e) {
            console.error(`[SuspiciousBot] Errore gestione bot ${member.id}:`, e.message);
        }
        return;
    }

    const role = member.guild.roles.cache.get(CONFIG.memberRoleId);
    if (role) member.roles.add(role).catch(() => {});

    try {
        const welcomeChannel = member.guild.channels.cache.get(CONFIG.welcomeChannelId);
        if (welcomeChannel && welcomeChannel.isTextBased()) {
            const memberNumber = getMemberNumber(member.id, member.guild);

            function formatDateIT(date) {
                const days = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
                const months = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
                                'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
                const d = new Date(date);
                const dayName = days[d.getDay()];
                const day = d.getDate();
                const month = months[d.getMonth()];
                const year = d.getFullYear();
                const hh = String(d.getHours()).padStart(2, '0');
                const mm = String(d.getMinutes()).padStart(2, '0');

                const diffMs = Date.now() - d.getTime();
                const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                const diffMonths = Math.floor(diffDays / 30);
                const diffYears = Math.floor(diffDays / 365);
                let ago;
                if (diffYears >= 1) ago = diffYears === 1 ? '1 anno fa' : `${diffYears} anni fa`;
                else if (diffMonths >= 1) ago = diffMonths === 1 ? '1 mese fa' : `${diffMonths} mesi fa`;
                else if (diffDays >= 1) ago = diffDays === 1 ? '1 giorno fa' : `${diffDays} giorni fa`;
                else ago = 'oggi';

                return { formatted: `${dayName} ${day} ${month} ${year} ${hh}:${mm}`, ago };
            }

            const guildCreated = formatDateIT(member.guild.createdAt);
            const accountCreated = formatDateIT(member.user.createdAt);

            const welcomeEmbed = new EmbedBuilder()
                .setTitle(`Benvenuto nel server, ${member.user.username}!`)
                .setDescription(`Ciao ${member}, siamo felici di averti qui con noi!`)
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
                .setColor('#5865F2')
                .addFields(
                    {
                        name: '🏠 Server Creato il',
                        value: `${guildCreated.formatted} (${guildCreated.ago})`,
                        inline: false
                    },
                    {
                        name: '📅 Account Creato il',
                        value: `${accountCreated.formatted} (${accountCreated.ago})`,
                        inline: false
                    },
                    {
                        name: '👥 Numero Membro',
                        value: `Sei il membro numero **#${memberNumber}**`,
                        inline: false
                    }
                )
                .setFooter({ text: member.guild.name })
                .setTimestamp();

            await welcomeChannel.send({ embeds: [welcomeEmbed] }).catch(() => {});
        }
    } catch (e) { console.error('[guildMemberAdd] Errore welcome embed:', e); }
});

client.on('guildMemberRemove', async (member) => {
    // ── SERVER STATS ─────────────────────────────────────────────────────
    scheduleStatsUpdate(member.guild);

    try {
        const welcomeChannel = member.guild.channels.cache.get(CONFIG.welcomeChannelId);
        if (welcomeChannel && welcomeChannel.isTextBased()) {
            const data = loadMemberNumbers();
            const memberNumber = data.members[member.id];
            const numText = memberNumber !== undefined ? `**#${memberNumber}**` : 'sconosciuto';

            const leaveEmbed = new EmbedBuilder()
                .setTitle('👋 Membro uscito')
                .setDescription(`${member} (**${member.user.username}**) ha lasciato il server.`)
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
                .setColor('#ed4245')
                .addFields(
                    { name: '👥 Numero Membro', value: `Era il membro numero ${numText}`, inline: false }
                )
                .setFooter({ text: member.guild.name })
                .setTimestamp();

            await welcomeChannel.send({ embeds: [leaveEmbed] }).catch(() => {});
        }
    } catch (e) { console.error('[guildMemberRemove] Errore log uscita:', e); }
});

// ================= ANTI-NUKE: AUDIT LOG (VELOCIZZATO) =================

// Mappa azione → info per il rilevamento istantaneo via gateway.
const AUDIT_ACTION_REASONS = new Map([
    [AuditLogEvent.ChannelCreate, 'Creazione canale non autorizzata'],
    [AuditLogEvent.ChannelUpdate, 'Modifica canale non autorizzata'],
    [AuditLogEvent.ChannelDelete, 'Eliminazione canale non autorizzata'],
    [AuditLogEvent.RoleCreate, 'Creazione ruolo non autorizzata'],
    [AuditLogEvent.RoleUpdate, 'Modifica ruolo non autorizzata'],
    [AuditLogEvent.RoleDelete, 'Eliminazione ruolo non autorizzata'],
    [AuditLogEvent.MemberBanAdd, 'Ban non autorizzato'],
    [AuditLogEvent.MemberKick, 'Kick non autorizzato']
]);

function formatAuditTargetInfo(entry) {
    if (!entry.target) return entry.targetId ?? 'sconosciuto';
    if ('name' in entry.target && entry.target.name) {
        // Canale o ruolo: distinguiamo dal changes/extra se possibile, altrimenti usiamo #.
        return entry.action >= AuditLogEvent.RoleCreate && entry.action <= AuditLogEvent.RoleDelete
            ? `@${entry.target.name}`
            : `#${entry.target.name}`;
    }
    if ('tag' in entry.target && entry.target.tag) return entry.target.tag;
    return String(entry.targetId ?? entry.target.id ?? 'sconosciuto');
}

// PERCORSO PRIMARIO — istantaneo: l'evento arriva via websocket, zero chiamate
// REST e zero retry. È il modo più veloce possibile per reagire a un'azione.
// Passa l'entry COMPLETA a gestisciAzione, così in caso di violazione si può
// anche avviare la riparazione automatica (autoRepair) usando entry.changes.
// tryClaimAuditEntry evita doppia elaborazione se un fallback REST ha già
// gestito la stessa entry (o viceversa).
client.on('guildAuditLogEntryCreate', async (entry, guild) => {
    try {
        updateAuditLogHotCache(guild.id, entry);

        const reason = AUDIT_ACTION_REASONS.get(entry.action);
        if (!reason || !entry.executor) return;
        if (!tryClaimAuditEntry(entry.id)) return;

        await gestisciAzione(guild, entry);
    } catch (e) { console.error('[guildAuditLogEntryCreate]', e); }
});

// PERCORSI DI FALLBACK — usati solo se, per qualsiasi motivo, l'evento gateway
// sopra non fosse disponibile/arrivasse in ritardo. Controllano se l'entry è
// già stata gestita (dedup) per non applicare la sanzione (e la riparazione)
// due volte. Passano anch'essi l'entry completa a gestisciAzione.
client.on('channelCreate', async ch => {
    const log = await fetchAuditLogEntry(ch.guild, AuditLogEvent.ChannelCreate, ch.id);
    if (log?.executor && tryClaimAuditEntry(log.id)) {
        await gestisciAzione(ch.guild, log);
    }
});
client.on('channelUpdate', async (_, nCh) => {
    const log = await fetchAuditLogEntry(nCh.guild, AuditLogEvent.ChannelUpdate, nCh.id);
    if (log?.executor && tryClaimAuditEntry(log.id)) {
        await gestisciAzione(nCh.guild, log);
    }
});
client.on('channelDelete', async ch => {
    const log = await fetchAuditLogEntry(ch.guild, AuditLogEvent.ChannelDelete, ch.id);
    if (log?.executor && tryClaimAuditEntry(log.id)) {
        await gestisciAzione(ch.guild, log);
    }
});
client.on('roleCreate', async role => {
    const log = await fetchAuditLogEntry(role.guild, AuditLogEvent.RoleCreate, role.id);
    if (log?.executor && tryClaimAuditEntry(log.id)) {
        await gestisciAzione(role.guild, log);
    }
});
client.on('roleUpdate', async (_, nRole) => {
    const log = await fetchAuditLogEntry(nRole.guild, AuditLogEvent.RoleUpdate, nRole.id);
    if (log?.executor && tryClaimAuditEntry(log.id)) {
        await gestisciAzione(nRole.guild, log);
    }
});
client.on('roleDelete', async role => {
    const log = await fetchAuditLogEntry(role.guild, AuditLogEvent.RoleDelete, role.id);
    if (log?.executor && tryClaimAuditEntry(log.id)) {
        await gestisciAzione(role.guild, log);
    }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
    // ── SERVER STATS ─────────────────────────────────────────────────────
    // Un cambio ruoli può influire sul conteggio "STAFF" o "MEMBRI":
    // aggiorniamo solo se i ruoli sono effettivamente cambiati.
    if (!oldMember.roles.cache.equals(newMember.roles.cache)) {
        scheduleStatsUpdate(newMember.guild);
    }
});

client.on('guildBanAdd', async ban => {
    const log = await fetchAuditLogEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    if (log?.executor && tryClaimAuditEntry(log.id)) {
        await gestisciAzione(ban.guild, log);
    }
});
client.on('guildMemberRemove', async member => {
    const log = await fetchAuditLogEntry(member.guild, AuditLogEvent.MemberKick, member.id);
    if (log?.executor && tryClaimAuditEntry(log.id)) {
        await gestisciAzione(member.guild, log);
    }
});

// ================= SLASH COMMANDS =================

client.once('ready', async () => {
    console.log(`✅ Bot online come ${client.user.tag}`);

    await setupAuditLogListener(client);
    antiViolation.reset();

    // ── SERVER STATS: setup iniziale + primo aggiornamento ─────────────────
    if (CONFIG.statsEnabled) {
        for (const guild of client.guilds.cache.values()) {
            try {
                await ensureStatsChannels(guild);
                await performStatsUpdate(guild);
            } catch (e) { console.error(`[Stats] Errore init guild ${guild.id}:`, e.message); }
        }
        console.log('✅ Server Stats inizializzati.');
    }

    // ── TICKET SYSTEM: setup iniziale del pannello "assistenza" ────────────
    if (CONFIG.ticketEnabled) {
        for (const guild of client.guilds.cache.values()) {
            try {
                await ensureTicketPanel(guild);
            } catch (e) { console.error(`[Ticket] Errore init guild ${guild.id}:`, e.message); }
        }
        console.log('✅ Pannello Ticket inizializzato.');
    }

    // ── BACKUP AUTOMATICO: primo snapshot all'avvio, poi ogni 24 ore ──────
    startAutoBackup();

    const commands = [
        new SlashCommandBuilder().setName('verify').setDescription('Verificati per sbloccare i canali'),
        new SlashCommandBuilder().setName('regole').setDescription('Mostra il regolamento del server'),
        new SlashCommandBuilder().setName('controlla').setDescription('Cerca una richiesta di whitelist per un utente')
            .addStringOption(o => o.setName('utente').setDescription('Il nome dell\'utente da cercare').setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
        new SlashCommandBuilder().setName('roleall').setDescription('Assegna un ruolo a tutti')
            .addRoleOption(o => o.setName('ruolo').setDescription('Ruolo da assegnare').setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName('backup_server').setDescription('Forza un backup completo del server')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName('restore_server').setDescription('Ripristina dal backup')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName('clear').setDescription('Elimina fino a 1000 messaggi')
            .addIntegerOption(o => o.setName('quantita').setDescription('Numero (max 1000)').setMinValue(1).setMaxValue(1000).setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
        new SlashCommandBuilder().setName('kick').setDescription('Espelle un utente')
            .addUserOption(o => o.setName('utente').setDescription('Utente da espellere').setRequired(true))
            .addStringOption(o => o.setName('motivo').setDescription('Motivo'))
            .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
        new SlashCommandBuilder().setName('ban').setDescription('Banna un utente')
            .addUserOption(o => o.setName('utente').setDescription('Utente da bannare').setRequired(true))
            .addStringOption(o => o.setName('motivo').setDescription('Motivo'))
            .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
        new SlashCommandBuilder().setName('timeout').setDescription('Mette in timeout un utente')
            .addUserOption(o => o.setName('utente').setDescription('Utente').setRequired(true))
            .addIntegerOption(o => o.setName('durata').setDescription(`Minuti (max ${CONFIG.maxTimeoutMinutes})`).setMinValue(1).setMaxValue(CONFIG.maxTimeoutMinutes).setRequired(true))
            .addStringOption(o => o.setName('motivo').setDescription('Motivo'))
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
        new SlashCommandBuilder().setName('untimeout').setDescription('Rimuove il timeout a un utente')
            .addUserOption(o => o.setName('utente').setDescription('Utente').setRequired(true))
            .addStringOption(o => o.setName('motivo').setDescription('Motivo'))
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
        new SlashCommandBuilder().setName('unban').setDescription('Rimuove il ban a un utente')
            .addStringOption(o => o.setName('id').setDescription('ID utente da sbannare').setRequired(true))
            .addStringOption(o => o.setName('motivo').setDescription('Motivo'))
            .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
        new SlashCommandBuilder().setName('stats_setup').setDescription('Crea (o ripara se mancanti) i canali Server Stats')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName('stats_refresh').setDescription('Forza un aggiornamento immediato dei contatori Server Stats')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName('ticket_setup').setDescription('Crea (o ripara se eliminato) il pannello ticket "assistenza"')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName('comandi').setDescription('Mostra la lista completa dei comandi del bot (solo founder)'),
        creavideoCommand.data,

        // ── /config: gestione runtime della configurazione sensibile ────────
        new SlashCommandBuilder().setName('config').setDescription('Gestisci la configurazione del bot (whitelist, ruoli, canali...)')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommandGroup(g => g.setName('whitelist').setDescription('Gestisci la whitelist (immunità anti-nuke/anti-spam)')
                .addSubcommand(s => s.setName('add').setDescription('Aggiungi un utente in whitelist (solo founder)')
                    .addUserOption(o => o.setName('utente').setDescription('Utente da aggiungere').setRequired(true)))
                .addSubcommand(s => s.setName('remove').setDescription('Rimuovi un utente dalla whitelist (solo founder)')
                    .addUserOption(o => o.setName('utente').setDescription('Utente da rimuovere').setRequired(true)))
                .addSubcommand(s => s.setName('list').setDescription('Mostra la whitelist attuale')))
            .addSubcommandGroup(g => g.setName('role').setDescription('Imposta un ruolo di configurazione')
                .addSubcommand(s => s.setName('set').setDescription('Imposta un ruolo (solo founder)')
                    .addStringOption(o => o.setName('target').setDescription('Quale ruolo impostare')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Ruolo immune (anti-nuke/anti-spam)', value: 'immuneRoleId' },
                            { name: 'Ruolo membro verificato', value: 'memberRoleId' },
                            { name: 'Ruolo OG', value: 'ogRoleId' }
                        ))
                    .addRoleOption(o => o.setName('ruolo').setDescription('Ruolo Discord da usare').setRequired(true))))
            .addSubcommandGroup(g => g.setName('channel').setDescription('Imposta un canale di configurazione')
                .addSubcommand(s => s.setName('set').setDescription('Imposta un canale')
                    .addStringOption(o => o.setName('target').setDescription('Quale canale impostare')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Canale alert (lockdown/raid)', value: 'alertChannelId' },
                            { name: 'Canale verifica', value: 'verifyChannelId' },
                            { name: 'Canale benvenuto/uscita', value: 'welcomeChannelId' },
                            { name: 'Canale log bot sospetti', value: 'suspiciousBotLogChannelId' }
                        ))
                    .addChannelOption(o => o.setName('canale').setDescription('Canale Discord da usare').setRequired(true))))
            .addSubcommandGroup(g => g.setName('logchannel').setDescription('Gestisci i canali di log dello staff')
                .addSubcommand(s => s.setName('add').setDescription('Aggiungi un canale di log')
                    .addChannelOption(o => o.setName('canale').setDescription('Canale da aggiungere').setRequired(true)))
                .addSubcommand(s => s.setName('remove').setDescription('Rimuovi un canale di log')
                    .addChannelOption(o => o.setName('canale').setDescription('Canale da rimuovere').setRequired(true)))
                .addSubcommand(s => s.setName('list').setDescription('Mostra i canali di log attuali')))
            .addSubcommandGroup(g => g.setName('freechannel').setDescription('Gestisci i canali "free" (nessuna moderazione automatica)')
                .addSubcommand(s => s.setName('add').setDescription('Aggiungi un canale free')
                    .addChannelOption(o => o.setName('canale').setDescription('Canale da aggiungere').setRequired(true)))
                .addSubcommand(s => s.setName('remove').setDescription('Rimuovi un canale free')
                    .addChannelOption(o => o.setName('canale').setDescription('Canale da rimuovere').setRequired(true)))
                .addSubcommand(s => s.setName('list').setDescription('Mostra i canali free attuali')))
            .addSubcommandGroup(g => g.setName('staffrole').setDescription('Imposta i ruoli staff usati da /regole e dal sistema ticket')
                .addSubcommand(s => s.setName('set').setDescription('Imposta un ruolo staff')
                    .addStringOption(o => o.setName('chiave').setDescription('Quale ruolo staff impostare')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Helper', value: 'helper' },
                            { name: 'Moderator', value: 'moderator' },
                            { name: 'Founder', value: 'founder' },
                            { name: 'Head Media', value: 'headMedia' },
                            { name: 'Admin', value: 'admin' },
                            { name: 'Senior', value: 'senior' }
                        ))
                    .addRoleOption(o => o.setName('ruolo').setDescription('Ruolo Discord da usare').setRequired(true))))
            .addSubcommandGroup(g => g.setName('ticketrole').setDescription('Imposta i ruoli che il sistema ticket deve pingare')
                .addSubcommand(s => s.setName('set').setDescription('Imposta il ruolo per un motivo di ticket')
                    .addStringOption(o => o.setName('motivo').setDescription('Motivo del ticket')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Problema tra membri', value: 'membri' },
                            { name: 'Problema con il bot', value: 'bot' }
                        ))
                    .addRoleOption(o => o.setName('ruolo').setDescription('Ruolo Discord da pingare').setRequired(true))))
            .addSubcommand(s => s.setName('show').setDescription('Mostra la configurazione attuale (riepilogo)'))
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN || process.env.DISCORD_TOKEN);

    // ── REGISTRAZIONE ISTANTANEA SUL GUILD DI TEST ──────────────────────────
    // I comandi GLOBALI (sotto) impiegano fino a ~1h a propagarsi la prima
    // volta e possono comunque richiedere qualche minuto per gli aggiornamenti
    // successivi. Registrandoli ANCHE sul singolo guild configurato in
    // CONFIG.guildId, questi diventano visibili immediatamente (pochi secondi)
    // su quel server — utile soprattutto durante lo sviluppo/test.
    if (CONFIG.guildId && CONFIG.guildId !== "0") {
        try {
            await rest.put(Routes.applicationGuildCommands(CONFIG.clientId, CONFIG.guildId), { body: commands });
            console.log(`✅ Comandi Slash registrati ISTANTANEAMENTE sul guild ${CONFIG.guildId}.`);
        } catch (e) {
            console.error('[ready] Errore registrazione comandi guild-specifici:', e.message);
        }
    }

    try {
        // Comandi GLOBALI: funzionano su qualsiasi server in cui il bot è invitato,
        // non solo su CONFIG.guildId. Nota: Discord può metterci fino a ~1 ora
        // per propagare i comandi globali su tutti i server la prima volta.
        await rest.put(Routes.applicationCommands(CONFIG.clientId), { body: commands });
        console.log('✅ Comandi Slash globali registrati (validi su tutti i server, propagazione fino a 1h).');
    } catch (e) { console.error('[ready] Errore comandi slash:', e); }
});

// ================= HANDLER /config =================

async function handleConfigCommand(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const isOwner = interaction.user.id === CONFIG.ownerId;

    // La whitelist e il ruolo immune concedono un bypass totale dell'anti-nuke
    // e dell'anti-spam: possono essere modificati SOLO dal founder, anche se
    // /config in generale richiede "solo" il permesso Administrator.
    const OWNER_ONLY_GROUPS = new Set(['whitelist']);
    const isOwnerOnlyRoleTarget = group === 'role' && sub === 'set' &&
        interaction.options.getString('target') === 'immuneRoleId';

    if ((OWNER_ONLY_GROUPS.has(group) && sub !== 'list') || isOwnerOnlyRoleTarget) {
        if (!isOwner) {
            return interaction.reply({
                content: '❌ Solo il founder può modificare whitelist o ruolo immune (garantiscono un bypass totale delle protezioni).',
                ephemeral: true
            });
        }
    }

    // ── /config show ──────────────────────────────────────────────────────
    if (!group && sub === 'show') {
        const embed = new EmbedBuilder()
            .setTitle('⚙️ Configurazione Attuale')
            .setColor('#5865F2')
            .addFields(
                { name: 'Founder', value: `<@${CONFIG.ownerId}>`, inline: false },
                { name: 'Whitelist', value: CONFIG.whitelistedIds.length ? CONFIG.whitelistedIds.map(id => `<@${id}>`).join(', ') : 'Vuota', inline: false },
                { name: 'Ruolo immune', value: CONFIG.immuneRoleId && CONFIG.immuneRoleId !== '0' ? `<@&${CONFIG.immuneRoleId}>` : 'Non impostato', inline: true },
                { name: 'Ruolo membro', value: CONFIG.memberRoleId && CONFIG.memberRoleId !== '0' ? `<@&${CONFIG.memberRoleId}>` : 'Non impostato', inline: true },
                { name: 'Ruolo OG', value: CONFIG.ogRoleId && CONFIG.ogRoleId !== '0' ? `<@&${CONFIG.ogRoleId}>` : 'Non impostato', inline: true },
                { name: 'Canale alert', value: CONFIG.alertChannelId && CONFIG.alertChannelId !== '0' ? `<#${CONFIG.alertChannelId}>` : 'Non impostato', inline: true },
                { name: 'Canale verifica', value: CONFIG.verifyChannelId && CONFIG.verifyChannelId !== '0' ? `<#${CONFIG.verifyChannelId}>` : 'Non impostato', inline: true },
                { name: 'Canale benvenuto', value: CONFIG.welcomeChannelId && CONFIG.welcomeChannelId !== '0' ? `<#${CONFIG.welcomeChannelId}>` : 'Non impostato', inline: true },
                { name: 'Canali log', value: CONFIG.logChannels.length ? CONFIG.logChannels.map(id => `<#${id}>`).join(', ') : 'Nessuno', inline: false },
                { name: 'Canali free (no moderazione)', value: CONFIG.aiFreeChannels.length ? CONFIG.aiFreeChannels.map(id => `<#${id}>`).join(', ') : 'Nessuno', inline: false },
                {
                    name: 'Ruoli staff', value: Object.entries(CONFIG.staffRoleIds)
                        .map(([k, id]) => `${k}: ${id && id !== '0' ? `<@&${id}>` : 'non impostato'}`).join('\n') || 'Nessuno',
                    inline: false
                }
            )
            .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── /config whitelist ─────────────────────────────────────────────────
    if (group === 'whitelist') {
        if (sub === 'add') {
            const user = interaction.options.getUser('utente');
            addToIdList('whitelistedIds', user.id);
            await broadcastLog(interaction.guild, '⚙️ Config: Whitelist', `${interaction.user.tag} ha aggiunto **${user.tag}** alla whitelist.`, '#2ecc71');
            return interaction.reply({ content: `✅ **${user.tag}** aggiunto alla whitelist.`, ephemeral: true });
        }
        if (sub === 'remove') {
            const user = interaction.options.getUser('utente');
            removeFromIdList('whitelistedIds', user.id);
            await broadcastLog(interaction.guild, '⚙️ Config: Whitelist', `${interaction.user.tag} ha rimosso **${user.tag}** dalla whitelist.`, '#e67e22');
            return interaction.reply({ content: `✅ **${user.tag}** rimosso dalla whitelist.`, ephemeral: true });
        }
        if (sub === 'list') {
            const list = CONFIG.whitelistedIds.length ? CONFIG.whitelistedIds.map(id => `<@${id}>`).join('\n') : 'Whitelist vuota.';
            return interaction.reply({ content: list, ephemeral: true });
        }
    }

    // ── /config role set ──────────────────────────────────────────────────
    if (group === 'role' && sub === 'set') {
        const target = interaction.options.getString('target');
        const role = interaction.options.getRole('ruolo');
        setConfigField(target, role.id);
        await broadcastLog(interaction.guild, '⚙️ Config: Ruolo', `${interaction.user.tag} ha impostato **${target}** = ${role}.`, '#3498db');
        return interaction.reply({ content: `✅ **${target}** impostato su ${role}.`, ephemeral: true });
    }

    // ── /config channel set ────────────────────────────────────────────────
    if (group === 'channel' && sub === 'set') {
        const target = interaction.options.getString('target');
        const channel = interaction.options.getChannel('canale');
        setConfigField(target, channel.id);
        await broadcastLog(interaction.guild, '⚙️ Config: Canale', `${interaction.user.tag} ha impostato **${target}** = ${channel}.`, '#3498db');
        return interaction.reply({ content: `✅ **${target}** impostato su ${channel}.`, ephemeral: true });
    }

    // ── /config logchannel ────────────────────────────────────────────────
    if (group === 'logchannel') {
        if (sub === 'add') {
            const channel = interaction.options.getChannel('canale');
            addToIdList('logChannels', channel.id);
            return interaction.reply({ content: `✅ ${channel} aggiunto ai canali di log.`, ephemeral: true });
        }
        if (sub === 'remove') {
            const channel = interaction.options.getChannel('canale');
            removeFromIdList('logChannels', channel.id);
            return interaction.reply({ content: `✅ ${channel} rimosso dai canali di log.`, ephemeral: true });
        }
        if (sub === 'list') {
            const list = CONFIG.logChannels.length ? CONFIG.logChannels.map(id => `<#${id}>`).join('\n') : 'Nessun canale di log configurato.';
            return interaction.reply({ content: list, ephemeral: true });
        }
    }

    // ── /config freechannel ───────────────────────────────────────────────
    if (group === 'freechannel') {
        if (sub === 'add') {
            const channel = interaction.options.getChannel('canale');
            addToIdList('aiFreeChannels', channel.id);
            return interaction.reply({ content: `✅ ${channel} aggiunto ai canali free.`, ephemeral: true });
        }
        if (sub === 'remove') {
            const channel = interaction.options.getChannel('canale');
            removeFromIdList('aiFreeChannels', channel.id);
            return interaction.reply({ content: `✅ ${channel} rimosso dai canali free.`, ephemeral: true });
        }
        if (sub === 'list') {
            const list = CONFIG.aiFreeChannels.length ? CONFIG.aiFreeChannels.map(id => `<#${id}>`).join('\n') : 'Nessun canale free configurato.';
            return interaction.reply({ content: list, ephemeral: true });
        }
    }

    // ── /config staffrole set ─────────────────────────────────────────────
    if (group === 'staffrole' && sub === 'set') {
        const key = interaction.options.getString('chiave');
        const role = interaction.options.getRole('ruolo');
        setStaffRoleField(key, role.id);
        return interaction.reply({ content: `✅ Ruolo staff **${key}** impostato su ${role}.`, ephemeral: true });
    }

    // ── /config ticketrole set ────────────────────────────────────────────
    if (group === 'ticketrole' && sub === 'set') {
        const key = interaction.options.getString('motivo');
        const role = interaction.options.getRole('ruolo');
        const ok = setTicketReasonRole(key, role.id);
        if (!ok) return interaction.reply({ content: '❌ Motivo non riconosciuto.', ephemeral: true });
        return interaction.reply({ content: `✅ Ruolo per il motivo ticket **${key}** impostato su ${role}.`, ephemeral: true });
    }

    return interaction.reply({ content: '❌ Sottocomando non riconosciuto.', ephemeral: true });
}

client.on('interactionCreate', async interaction => {
    // ── BOTTONI SISTEMA TICKET ───────────────────────────────────────────
    if (interaction.isButton()) {
        try {
            if (interaction.customId === 'ticket_open') {
                return await handleTicketOpen(interaction);
            }
            if (interaction.customId.startsWith('ticket_reason_')) {
                const reasonKey = interaction.customId.replace('ticket_reason_', '');
                return await handleTicketReason(interaction, reasonKey);
            }
            if (interaction.customId === 'ticket_close') {
                return await handleTicketClose(interaction);
            }
        } catch (e) {
            console.error('[Ticket] Errore gestione bottone:', e);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Si è verificato un errore.', ephemeral: true }).catch(() => {});
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'config') {
        try {
            return await handleConfigCommand(interaction);
        } catch (e) {
            console.error('[config]', e);
            if (!interaction.replied && !interaction.deferred) {
                return interaction.reply({ content: '❌ Errore durante l\'esecuzione del comando.', ephemeral: true }).catch(() => {});
            }
            return;
        }
    }

    if (interaction.commandName === 'regole') {
        const embeds = buildRulesEmbeds(interaction.guild);
        return interaction.reply({ embeds, ephemeral: false });
    }

    if (interaction.commandName === 'controlla') {
        await interaction.deferReply({ ephemeral: false });
        const query = interaction.options.getString('utente').toLowerCase();

        let found = false;
        let lastId = undefined;
        let fetchedCount = 0;
        const MAX_MESSAGES_TO_FETCH = 500;

        try {
            while (fetchedCount < MAX_MESSAGES_TO_FETCH) {
                const options = { limit: 100 };
                if (lastId) options.before = lastId;

                const messages = await interaction.channel.messages.fetch(options);
                if (messages.size === 0) break;

                const match = messages.find(m => m.content.toLowerCase().includes(query));
                if (match) {
                    found = true;
                    break;
                }

                lastId = messages.last().id;
                fetchedCount += messages.size;
            }

            if (found) {
                return interaction.editReply(`✅ **Attenzione:** È stata trovata una richiesta di whitelist che include il nome **${query}** in questo canale.`);
            } else {
                return interaction.editReply(`nessuna richiesta di whitelist si puo procedere all'espulsione dalla squadriglia`);
            }
        } catch (error) {
            console.error('[controlla]', error);
            return interaction.editReply('❌ Si è verificato un errore durante la lettura dei messaggi.');
        }
    }

    if (interaction.commandName === 'kick') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getUser('utente');
        const reason     = interaction.options.getString('motivo') || 'Nessun motivo.';
        const member     = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!member)             return interaction.editReply('❌ Utente non trovato.');
        if (isImmune(member))    return interaction.editReply('👑 Questo utente è immune (founder/whitelist/ruolo immune) e non può essere espulso.');
        if (!member.kickable)    return interaction.editReply('❌ Non posso espellere questo utente.');
        setPermessi(interaction.user.id, getPermessi(interaction.user.id) + 1);
        await member.kick(`Da ${interaction.user.tag}: ${reason}`);
        await broadcastLog(interaction.guild, '👢 Kick', `**${interaction.user.tag}** → **${targetUser.tag}**. Motivo: ${reason}`, '#e74c3c');
        return interaction.editReply(`✅ **${targetUser.tag}** espulso.`);
    }

    if (interaction.commandName === 'ban') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getUser('utente');
        const reason     = interaction.options.getString('motivo') || 'Nessun motivo.';
        const member     = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (member && isImmune(member)) return interaction.editReply('👑 Questo utente è immune (founder/whitelist/ruolo immune) e non può essere bannato.');
        if (member && !member.bannable) return interaction.editReply('❌ Non posso bannare questo utente.');
        setPermessi(interaction.user.id, getPermessi(interaction.user.id) + 1);
        await interaction.guild.members.ban(targetUser.id, { reason: `Da ${interaction.user.tag}: ${reason}` });
        await broadcastLog(interaction.guild, '🔨 Ban', `**${interaction.user.tag}** → **${targetUser.tag}**. Motivo: ${reason}`, '#c0392b');
        return interaction.editReply(`✅ **${targetUser.tag}** bannato.`);
    }

    if (interaction.commandName === 'timeout') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getUser('utente');
        const minutes    = Math.min(interaction.options.getInteger('durata'), CONFIG.maxTimeoutMinutes);
        const reason     = interaction.options.getString('motivo') || 'Nessun motivo.';
        const member     = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!member)              return interaction.editReply('❌ Utente non trovato.');
        if (isImmune(member))     return interaction.editReply('👑 Questo utente è immune (founder/whitelist/ruolo immune) e non può essere messo in timeout.');
        if (!member.moderatable)  return interaction.editReply('❌ Non posso mettere in timeout questo utente.');
        await member.timeout(minutes * 60 * 1000, `Da ${interaction.user.tag}: ${reason}`);
        await broadcastLog(interaction.guild, '🔇 Timeout', `**${interaction.user.tag}** → **${targetUser.tag}** per **${minutes}m**. Motivo: ${reason}`, '#e67e22');
        return interaction.editReply(`✅ Timeout di **${minutes} minuti** applicato a **${targetUser.tag}**.`);
    }

    if (interaction.commandName === 'untimeout') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getUser('utente');
        const reason     = interaction.options.getString('motivo') || 'Nessun motivo.';
        const member     = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!member)              return interaction.editReply('❌ Utente non trovato.');
        if (!member.moderatable)  return interaction.editReply('❌ Non posso rimuovere il timeout a questo utente.');
        if (!member.communicationDisabledUntil) return interaction.editReply('⚠️ Questo utente non è in timeout.');
        await member.timeout(null, `Da ${interaction.user.tag}: ${reason}`);
        await broadcastLog(interaction.guild, '🔊 Timeout Rimosso', `**${interaction.user.tag}** → **${targetUser.tag}**. Motivo: ${reason}`, '#2ecc71');
        return interaction.editReply(`✅ Timeout rimosso per **${targetUser.tag}**.`);
    }

    if (interaction.commandName === 'unban') {
        await interaction.deferReply({ ephemeral: true });
        const userId = interaction.options.getString('id').trim();
        const reason  = interaction.options.getString('motivo') || 'Nessun motivo.';
        const banInfo = await interaction.guild.bans.fetch(userId).catch(() => null);
        if (!banInfo) return interaction.editReply('❌ Nessun ban trovato per questo ID.');
        await interaction.guild.members.unban(userId, `Da ${interaction.user.tag}: ${reason}`).catch(() => {});
        await broadcastLog(interaction.guild, '🔓 Ban Rimosso', `**${interaction.user.tag}** → **${banInfo.user.tag}** (\`${userId}\`). Motivo: ${reason}`, '#2ecc71');
        return interaction.editReply(`✅ Ban rimosso per **${banInfo.user.tag}**.`);
    }

    if (interaction.commandName === 'verify') {
        if (interaction.channelId !== CONFIG.verifyChannelId)
            return interaction.reply({ content: 'Usa il canale di verifica.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const member = interaction.member;
        if (member.roles.cache.has(CONFIG.memberRoleId))
            return interaction.editReply('Sei già verificato!');
        try {
            const roles = [CONFIG.memberRoleId];
            if (interaction.guild.memberCount <= 150) roles.push(CONFIG.ogRoleId);
            await member.roles.add(roles);
            return interaction.editReply('✅ Verifica completata!');
        } catch { return interaction.editReply('❌ Errore assegnazione ruoli.'); }
    }

    if (interaction.commandName === 'roleall') {
        const role = interaction.options.getRole('ruolo');
        await interaction.reply({ content: `⏳ Assegnazione **${role.name}** in corso…`, ephemeral: true });
        const members = await interaction.guild.members.fetch();
        let count = 0;
        for (const [, m] of members) {
            if (!m.roles.cache.has(role.id) && !m.user.bot) {
                await m.roles.add(role).catch(() => {});
                count++;
            }
        }
        return interaction.editReply(`✅ Ruolo assegnato a ${count} utenti.`);
    }

    if (interaction.commandName === 'clear') {
        const amount = interaction.options.getInteger('quantita');
        await interaction.deferReply({ ephemeral: true });
        let deleted = 0, toDelete = amount, hitOld = false;
        while (toDelete > 0) {
            const lim = Math.min(toDelete, 100);
            const fetched = await interaction.channel.messages.fetch({ limit: lim });
            if (!fetched.size) break;
            try {
                const del = await interaction.channel.bulkDelete(fetched, true);
                deleted  += del.size;
                toDelete -= lim;
                if (del.size < fetched.size) { hitOld = true; break; }
                if (del.size === 0) break;
            } catch { break; }
        }
        let reply = `🗑️ Eliminati **${deleted}** messaggi.`;
        if (hitOld) reply += '\n⚠️ Alcuni messaggi >14 giorni non possono essere eliminati con bulkDelete.';
        return interaction.editReply(reply);
    }

    if (interaction.commandName === 'backup_server') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const r = await performGuildBackup(interaction.guild);
            return interaction.editReply(
                `💾 Backup di **${interaction.guild.name}** salvato: ` +
                `${r.channelsCount} canali, ${r.categoriesCount} categorie, ` +
                `${r.rolesCount} ruoli, ${r.membersCount} assegnazioni membri.`
            );
        } catch (e) {
            console.error('[backup_server]', e);
            return interaction.editReply('❌ Errore salvataggio backup.');
        }
    }

    if (interaction.commandName === 'stats_setup') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const entry = await ensureStatsChannels(interaction.guild);
            if (!entry) return interaction.editReply('❌ Errore durante la creazione dei canali Server Stats (controlla i permessi del bot).');
            await performStatsUpdate(interaction.guild);
            return interaction.editReply('✅ Canali Server Stats creati/verificati e aggiornati.');
        } catch (e) {
            console.error('[stats_setup]', e);
            return interaction.editReply('❌ Errore durante il setup dei Server Stats.');
        }
    }

    if (interaction.commandName === 'stats_refresh') {
        await interaction.deferReply({ ephemeral: true });
        try {
            // Bypassa il cooldown di sicurezza: usare con moderazione, ripetuto
            // troppo spesso può comunque far scattare i rate limit di Discord.
            const runtime = getStatsRuntime(interaction.guild.id);
            runtime.lastUpdate = 0;
            await performStatsUpdate(interaction.guild);
            return interaction.editReply('✅ Contatori Server Stats aggiornati manualmente.');
        } catch (e) {
            console.error('[stats_refresh]', e);
            return interaction.editReply('❌ Errore durante l\'aggiornamento manuale.');
        }
    }

    if (interaction.commandName === 'ticket_setup') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const entry = await ensureTicketPanel(interaction.guild);
            if (!entry) return interaction.editReply('❌ Errore durante la creazione del pannello ticket (controlla i permessi del bot).');
            const ch = interaction.guild.channels.cache.get(entry.panelChannelId);
            return interaction.editReply(`✅ Pannello ticket pronto in ${ch ?? `#${CONFIG.ticketPanelChannelName}`}.`);
        } catch (e) {
            console.error('[ticket_setup]', e);
            return interaction.editReply('❌ Errore durante il setup del pannello ticket.');
        }
    }

    if (interaction.commandName === 'comandi') {
        if (interaction.user.id !== CONFIG.ownerId) {
            return interaction.reply({ content: '❌ Solo il founder può usare questo comando.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setTitle('📖 Lista Comandi del Bot')
            .setDescription('Elenco completo di tutti i comandi disponibili, divisi per categoria.')
            .setColor('#5865F2')
            .addFields(
                {
                    name: '🛡️ Moderazione (slash)',
                    value:
                        '`/kick @utente [motivo]` — espelle un utente\n' +
                        '`/ban @utente [motivo]` — banna un utente\n' +
                        '`/unban <id> [motivo]` — rimuove un ban\n' +
                        '`/timeout @utente <minuti> [motivo]` — mette in timeout\n' +
                        '`/untimeout @utente [motivo]` — rimuove il timeout\n' +
                        '`/clear <quantità>` — elimina fino a 1000 messaggi\n' +
                        '`/roleall <ruolo>` — assegna un ruolo a tutti i membri\n' +
                        '`/controlla <utente>` — cerca una richiesta whitelist nel canale'
                },
                {
                    name: '⚙️ Configurazione runtime (slash, admin/founder)',
                    value:
                        '`/config show` — mostra la configurazione attuale\n' +
                        '`/config whitelist add|remove|list` — gestisce la whitelist (solo founder)\n' +
                        '`/config role set <target> <ruolo>` — imposta ruolo immune/membro/OG\n' +
                        '`/config channel set <target> <canale>` — imposta canale alert/verifica/benvenuto/bot sospetti\n' +
                        '`/config logchannel add|remove|list` — gestisce i canali di log\n' +
                        '`/config freechannel add|remove|list` — gestisce i canali senza moderazione automatica\n' +
                        '`/config staffrole set <chiave> <ruolo>` — imposta i ruoli staff\n' +
                        '`/config ticketrole set <motivo> <ruolo>` — imposta i ruoli pingati dai ticket'
                },
                {
                    name: '👑 Solo Founder (prefisso "!")',
                    value:
                        '`!concedi @utente <numero>` — concede permessi anti-nuke temporanei (30 min)\n' +
                        '`!toglipermessi @utente <numero>` — rimuove permessi anti-nuke\n' +
                        '`!lock [motivo]` — attiva il lockdown manuale del server\n' +
                        '`!unlock` — disattiva il lockdown manuale'
                },
                {
                    name: '💾 Backup & Restore (admin)',
                    value:
                        '`/backup_server` — forza un backup completo (canali, categorie, ruoli, permessi, assegnazioni)\n' +
                        '`/restore_server` — elimina tutto e ripristina dall\'ultimo backup salvato\n' +
                        'Backup automatico ogni 24 ore (tiene le ultime 10 copie per server)'
                },
                {
                    name: '📊 Server Stats (admin)',
                    value:
                        '`/stats_setup` — crea/ripara i canali contatore (MEMBRI, STAFF, Bots, All Members)\n' +
                        '`/stats_refresh` — forza un aggiornamento immediato dei contatori'
                },
                {
                    name: '🎫 Ticket (admin)',
                    value: '`/ticket_setup` — crea/ripara il pannello ticket nel canale "assistenza"'
                },
                {
                    name: '🎬 Creazione contenuti (tutti)',
                    value: '`/creavideo <clip> <testo> [voce]` — genera un video con voce sintetica (Edge TTS, gratis) e sottotitoli bruciati con ffmpeg'
                },
                {
                    name: '🌐 Generali (tutti)',
                    value:
                        '`/verify` — verifica l\'account nel canale di verifica\n' +
                        '`/regole` — mostra il regolamento del server'
                },
                {
                    name: '🤖 Automatismi (nessun comando richiesto)',
                    value:
                        'Anti-Nuke con riparazione automatica · Anti-Spam · Anti-Ping · Anti-Raid/Lockdown ' +
                        'automatico · Anti-Link · Server Stats · Pannello Ticket · Benvenuto/Uscita membri · Backup automatico ogni 24h'
                }
            )
            .setFooter({ text: 'Comando riservato al founder' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'creavideo') {
        return creavideoCommand.execute(interaction);
    }

    if (interaction.commandName === 'restore_server') {
        const backupPath = getBackupPath(interaction.guild.id);
        if (!fs.existsSync(backupPath))
            return interaction.reply({ content: `❌ Nessun backup trovato per **${interaction.guild.name}**.`, ephemeral: true });

        // Leggo e valido il backup PRIMA di distruggere qualsiasi cosa.
        let data;
        try { data = JSON.parse(await fs.promises.readFile(backupPath, 'utf-8')); }
        catch (e) {
            console.error('[restore_server] Errore lettura backup:', e);
            return interaction.reply({ content: '❌ Errore lettura backup.', ephemeral: true });
        }
        if (data.guildId && data.guildId !== interaction.guild.id) {
            return interaction.reply({ content: '❌ Il backup trovato appartiene a un altro server, ripristino annullato.', ephemeral: true });
        }

        await interaction.reply({
            content: '⚠️ Eliminazione di TUTTI i canali testuali/vocali/categorie e dei ruoli tra 10s…\n' +
                      'Il canale in cui hai lanciato il comando verrà eliminato: riceverai conferma via DM.',
            ephemeral: true
        });
        await delay(10000);

        try {
            const r = await performGuildRestore(interaction.guild, data);
            const esito =
                `✅ Ripristino completato per **${interaction.guild.name}**!\n` +
                `Canali ricreati: **${r.createdChannels}/${(data.channels ?? []).length}**\n` +
                `Categorie ricreate: **${r.createdCategories}/${(data.categories ?? []).length}**\n` +
                `Ruoli ricreati: **${r.createdRoles}/${(data.roles ?? []).length}**\n` +
                `Assegnazioni ruoli: **${r.restoredMembers}/${(data.memberRoles ?? []).length}**`;

            // Il canale originale non esiste più: uso una DM invece di editReply (fallirebbe).
            await interaction.user.send(esito).catch(() => {});
            await broadcastLog(interaction.guild, '♻️ Restore Completato', esito, '#2ecc71');
        } catch (e) {
            console.error('[restore_server] Errore generale:', e);
            await interaction.user.send(`❌ Errore durante il ripristino di **${interaction.guild.name}**: ${e.message}`).catch(() => {});
        }
    }

});

// ================= ERROR HANDLING =================
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

const LOGIN_RETRY_BASE_DELAY_MS = 5000;   // 5s
const LOGIN_RETRY_MAX_DELAY_MS = 60000;   // tetto: 60s
let loginAttempt = 0;

async function loginWithRetry() {
    const token = process.env.TOKEN || process.env.DISCORD_TOKEN;
    try {
        await client.login(token);
        console.log('✅ Login riuscito.');
        loginAttempt = 0;
    } catch (err) {
        loginAttempt++;
        const wait = Math.min(
            LOGIN_RETRY_BASE_DELAY_MS * Math.pow(1.5, loginAttempt - 1),
            LOGIN_RETRY_MAX_DELAY_MS
        );
        console.error(`❌ Login fallito (tentativo ${loginAttempt}): ${err.message}. Riprovo tra ${Math.round(wait / 1000)}s...`);
        setTimeout(loginWithRetry, wait);
    }
}

loginWithRetry();