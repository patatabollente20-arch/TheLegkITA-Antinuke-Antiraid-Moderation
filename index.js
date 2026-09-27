require('dotenv').config();
console.log('TOKEN esiste?', process.env.TOKEN !== undefined);
const fs = require('fs');
const path = require('path');
const {
    Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes,
    SlashCommandBuilder, PermissionFlagsBits, ChannelType, AuditLogEvent,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder
} = require('discord.js');

const creavideoCommand = require('./commands/creavideo.js');

// ================= LOGGER =================
const Logger = {
    levels: { debug: 0, info: 1, warn: 2, error: 3 },
    current: process.env.LOG_LEVEL || 'info',
    ts() { return new Date().toISOString().slice(11, 19); },
    log(level, tag, ...args) {
        if (this.levels[level] < this.levels[this.current]) return;
        const prefix = `[${this.ts()}] [${level.toUpperCase()}] [${tag}]`;
        console.log(prefix, ...args);
    },
    debug(tag, ...a) { this.log('debug', tag, ...a); },
    info(tag, ...a) { this.log('info', tag, ...a); },
    warn(tag, ...a) { this.log('warn', tag, ...a); },
    error(tag, ...a) { this.log('error', tag, ...a); }
};

const delay = ms => new Promise(res => setTimeout(res, ms));

// ================= VIOLATION TRACKER =================
class ViolationTracker {
    constructor(windowMs = 15_000, thresholdCount = 3) {
        this.violations = new Map();
        this.windowMs = windowMs;
        this.thresholdCount = thresholdCount;
    }
    register(userId, type = 'generic') {
        const now = Date.now();
        if (!this.violations.has(userId)) this.violations.set(userId, { count: 0, firstTime: now, lastTime: now, violations: [] });
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
        if (filtered.length === 0) { this.violations.delete(userId); return null; }
        return { count: filtered.length, violations: filtered };
    }
    clear(userId) { this.violations.delete(userId); }
    cleanup() {
        const now = Date.now();
        for (const [userId, record] of this.violations) {
            if (now - record.lastTime > this.windowMs * 3) this.violations.delete(userId);
        }
    }
}

// ================= ESCALATION TRACKER =================
class EscalationTracker {
    constructor(windowMs = 48 * 60 * 60 * 1000) {
        this.escalations = new Map();
        this.windowMs = windowMs;
    }
    getLevel(userId) {
        const entry = this.escalations.get(userId);
        if (!entry) return 0;
        const now = Date.now();
        if (now - entry.lastTime > this.windowMs) { this.escalations.delete(userId); return 0; }
        return entry.level;
    }
    increment(userId) {
        const now = Date.now();
        const current = this.getLevel(userId);
        const newLevel = Math.min(current + 1, 2);
        this.escalations.set(userId, { level: newLevel, lastTime: now, history: (this.escalations.get(userId)?.history || []).concat({ level: newLevel, time: now }) });
        return newLevel;
    }
    getTimeout(level) { return { 0: 10 * 60 * 1000, 1: 60 * 60 * 1000, 2: 24 * 60 * 60 * 1000 }[Math.min(level, 2)]; }
    getLabel(level) { return { 0: '10 minuti', 1: '1 ora', 2: '24 ore' }[Math.min(level, 2)]; }
    cleanup() {
        const now = Date.now();
        for (const [userId, entry] of this.escalations) {
            if (now - entry.lastTime > this.windowMs) this.escalations.delete(userId);
        }
    }
}

// ================= EVERYONE ESCALATION =================
class EveryoneEscalationTracker {
    constructor(windowMs = 24 * 60 * 60 * 1000) { this.escalations = new Map(); this.windowMs = windowMs; }
    getLevel(userId) {
        const entry = this.escalations.get(userId);
        if (!entry) return 0;
        const now = Date.now();
        if (now - entry.lastTime > this.windowMs) { this.escalations.delete(userId); return 0; }
        return entry.level;
    }
    increment(userId) {
        const now = Date.now();
        const current = this.getLevel(userId);
        const newLevel = Math.min(current + 1, 4);
        this.escalations.set(userId, { level: newLevel, lastTime: now });
        return newLevel;
    }
    getTimeout(level) { return { 0: 5 * 60 * 1000, 1: 15 * 60 * 1000, 2: 60 * 60 * 1000, 3: 6 * 60 * 60 * 1000, 4: 24 * 60 * 60 * 1000 }[Math.min(level, 4)]; }
    getLabel(level) { return { 0: '5 minuti', 1: '15 minuti', 2: '1 ora', 3: '6 ore', 4: '24 ore' }[Math.min(level, 4)]; }
    cleanup() {
        const now = Date.now();
        for (const [userId, entry] of this.escalations) {
            if (now - entry.lastTime > this.windowMs) this.escalations.delete(userId);
        }
    }
}

// ================= SPAM TRACKER =================
class SpamTracker {
    constructor(config) { this.config = config; this.cache = new Map(); }
    addLocalSpam(userId, channelId, timestamp = Date.now()) {
        if (!this.cache.has(userId)) this.cache.set(userId, { local: [], rotational: [], voice: [] });
        const record = this.cache.get(userId);
        const now = Date.now();
        if (record.localChannel && record.localChannel !== channelId) record.local = [];
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
        return { totalMessages: record.rotational.length, uniqueChannels };
    }
    addVoiceSpam(userId, timestamp = Date.now()) {
        if (!this.cache.has(userId)) this.cache.set(userId, { local: [], rotational: [], voice: [] });
        const record = this.cache.get(userId);
        const now = Date.now();
        record.voice = this.filterWindow(record.voice, now, this.config.voiceSpamWindow);
        record.voice.push(timestamp);
        return record.voice.length;
    }
    filterWindow(arr, now, windowMs) { return arr.filter(t => (now - t) < windowMs); }
    clear(userId) { this.cache.delete(userId); }
    cleanup() {
        const now = Date.now();
        const maxAge = 10 * 60 * 1000;
        for (const [userId, record] of this.cache) {
            record.local = this.filterWindow(record.local, now, maxAge);
            record.rotational = record.rotational.filter(e => now - e.time < maxAge);
            record.voice = this.filterWindow(record.voice, now, maxAge);
            if (!record.local.length && !record.rotational.length && !record.voice.length) this.cache.delete(userId);
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
        this.everyoneAbuseCache = new Map();
        this.everyoneRapidCache = new Map();
        this.ghostCache = new Map();
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
        if (!this.rotationalCache.has(userId)) this.rotationalCache.set(userId, new Map());
        const userTargets = this.rotationalCache.get(userId);
        if (!userTargets.has(targetId)) userTargets.set(targetId, []);
        let arr = userTargets.get(targetId).filter(e => now - e.time < this.config.rotPingWindow);
        for (let i = 0; i < Math.min(count, 3); i++) arr.push({ channelId, isVoice, time: timestamp });
        userTargets.set(targetId, arr);
        const uniqueChannels = new Set(arr.map(e => e.channelId)).size;
        return { totalPings: arr.length, uniqueChannels };
    }
    addEveryonePing(userId, channelId, timestamp = Date.now()) {
        const now = Date.now();
        const WINDOW = 5 * 60 * 1000;
        if (!this.everyoneCache.has(userId)) this.everyoneCache.set(userId, { channels: new Set(), timestamps: [] });
        const entry = this.everyoneCache.get(userId);
        entry.timestamps = this.filterWindow(entry.timestamps, now, WINDOW);
        entry.timestamps.push(timestamp);
        entry.channels.add(channelId);
        return { totalPings: entry.timestamps.length, uniqueChannels: entry.channels.size };
    }
    addEveryoneAbusePing(userId, channelId, timestamp = Date.now()) {
        const now = Date.now();
        const windowMs = this.config.everyoneAbuseWindow;
        if (!this.everyoneAbuseCache.has(userId)) this.everyoneAbuseCache.set(userId, []);
        let arr = this.everyoneAbuseCache.get(userId).filter(e => (now - e.time) < windowMs);
        arr.push({ channelId, time: timestamp });
        this.everyoneAbuseCache.set(userId, arr);
        return { totalMessages: arr.length, uniqueChannels: new Set(arr.map(e => e.channelId)).size };
    }
    addEveryoneRapid(userId, timestamp = Date.now()) {
        const now = Date.now();
        const WINDOW = 60 * 1000;
        if (!this.everyoneRapidCache.has(userId)) this.everyoneRapidCache.set(userId, []);
        let arr = this.everyoneRapidCache.get(userId).filter(t => now - t < WINDOW);
        arr.push(timestamp);
        this.everyoneRapidCache.set(userId, arr);
        return arr.length;
    }
    addGhostPing(messageId, userId, channelId, targetId) {
        const key = `${userId}-${channelId}-${targetId}`;
        this.ghostCache.set(key, { messageId, timestamp: Date.now() });
        return true;
    }
    consumeGhostPing(userId, channelId, targetId) {
        const key = `${userId}-${channelId}-${targetId}`;
        const entry = this.ghostCache.get(key);
        if (!entry) return null;
        this.ghostCache.delete(key);
        return entry;
    }
    clearEveryoneRapid(userId) { this.everyoneRapidCache.delete(userId); }
    filterWindow(arr, now, windowMs) { return arr.filter(t => (now - t) < windowMs); }
    clearUser(userId) {
        for (const key of this.textCache.keys()) if (key.startsWith(userId + '-')) this.textCache.delete(key);
        for (const key of this.voiceCache.keys()) if (key.startsWith(userId + '-')) this.voiceCache.delete(key);
        this.rotationalCache.delete(userId);
        this.globalCache.delete(userId);
        this.everyoneCache.delete(userId);
        this.everyoneRapidCache.delete(userId);
    }
    clearEveryoneAbuse(userId) { this.everyoneAbuseCache.delete(userId); }
    cleanup() {
        const now = Date.now();
        const maxAge = 10 * 60 * 1000;
        for (const [key, arr] of this.textCache) {
            const filtered = this.filterWindow(arr, now, maxAge);
            if (filtered.length === 0) this.textCache.delete(key); else this.textCache.set(key, filtered);
        }
        for (const [key, arr] of this.voiceCache) {
            const filtered = this.filterWindow(arr, now, maxAge);
            if (filtered.length === 0) this.voiceCache.delete(key); else this.voiceCache.set(key, filtered);
        }
        for (const [userId, userTargets] of this.rotationalCache) {
            for (const [targetId, arr] of userTargets) {
                const filtered = arr.filter(e => now - e.time < maxAge);
                if (filtered.length === 0) userTargets.delete(targetId); else userTargets.set(targetId, filtered);
            }
            if (userTargets.size === 0) this.rotationalCache.delete(userId);
        }
        for (const [userId, arr] of this.globalCache) {
            const filtered = this.filterWindow(arr, now, maxAge);
            if (filtered.length === 0) this.globalCache.delete(userId); else this.globalCache.set(userId, filtered);
        }
        for (const [userId, entry] of this.everyoneCache) {
            entry.timestamps = this.filterWindow(entry.timestamps, now, maxAge);
            if (entry.timestamps.length === 0) this.everyoneCache.delete(userId);
        }
        for (const [userId, arr] of this.everyoneAbuseCache) {
            const filtered = arr.filter(e => (now - e.time) < this.config.everyoneAbuseWindow);
            if (filtered.length === 0) this.everyoneAbuseCache.delete(userId); else this.everyoneAbuseCache.set(userId, filtered);
        }
        for (const [userId, arr] of this.everyoneRapidCache) {
            const filtered = arr.filter(t => now - t < 60 * 1000);
            if (filtered.length === 0) this.everyoneRapidCache.delete(userId); else this.everyoneRapidCache.set(userId, filtered);
        }
        for (const [key, entry] of this.ghostCache) {
            if (now - entry.timestamp > 30_000) this.ghostCache.delete(key);
        }
    }
}

// ================= RAID TRACKER =================
class RaidTracker {
    constructor(config) {
        this.config = config;
        this.joinTimes = [];
        this.slowJoinTimes = [];
        this.newAccountJoinTimes = [];
        this.recentJoiners = new Map();
        this.recentJoinerSpam = new Map();
        this.waveTimes = [];
    }
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
        this.recentJoiners.set(member.id, { joinedAt: timestamp, accountAgeMs: accountAge });
        return { fastCount: this.joinTimes.length, slowCount: this.slowJoinTimes.length, newAccountCount: this.newAccountJoinTimes.length };
    }
    checkRaidThreshold(counts) {
        const reasons = [];
        if (counts.fastCount > this.config.raidJoinLimit) reasons.push(`Burst rapido: ${counts.fastCount} account in ${this.config.raidJoinTime / 1000}s`);
        if (counts.slowCount > this.config.raidSlowJoinLimit) reasons.push(`Flusso: ${counts.slowCount} account in ${Math.round(this.config.raidSlowJoinTime / 1000)}s`);
        if (counts.newAccountCount >= this.config.raidNewAccountJoinLimit) {
            const days = Math.round(this.config.raidNewAccountAgeMs / (24 * 60 * 60 * 1000));
            reasons.push(`Account nuovi: ${counts.newAccountCount} creati da < ${days}gg in ${this.config.raidNewAccountJoinTime / 1000}s`);
        }
        return reasons;
    }
    isRecentJoiner(userId, now = Date.now()) {
        const info = this.recentJoiners.get(userId);
        if (!info) return false;
        if (now - info.joinedAt > this.config.raidRecentJoinerWindowMs) { this.recentJoiners.delete(userId); return false; }
        return true;
    }
    registerRecentJoinerMessage(userId, timestamp = Date.now()) {
        if (!this.recentJoinerSpam.has(userId)) this.recentJoinerSpam.set(userId, []);
        let arr = this.recentJoinerSpam.get(userId).filter(t => timestamp - t < this.config.raidRecentJoinerSpamWindowMs);
        arr.push(timestamp);
        this.recentJoinerSpam.set(userId, arr);
        return arr.length;
    }
    registerWave(timestamp = Date.now()) {
        this.waveTimes.push(timestamp);
        this.waveTimes = this.waveTimes.filter(t => timestamp - t < this.config.raidWaveWindowMs);
        return this.waveTimes.length;
    }
    reset() { this.joinTimes = []; this.slowJoinTimes = []; this.newAccountJoinTimes = []; }
    cleanup() {
        const now = Date.now();
        this.joinTimes = this.joinTimes.filter(t => now - t < this.config.raidJoinTime);
        this.slowJoinTimes = this.slowJoinTimes.filter(t => now - t < this.config.raidSlowJoinTime);
        this.newAccountJoinTimes = this.newAccountJoinTimes.filter(t => now - t < this.config.raidNewAccountJoinTime);
        for (const [uid, info] of this.recentJoiners) if (now - info.joinedAt > this.config.raidRecentJoinerWindowMs) this.recentJoiners.delete(uid);
        for (const [uid, arr] of this.recentJoinerSpam) {
            const filtered = arr.filter(t => now - t < this.config.raidRecentJoinerSpamWindowMs);
            if (filtered.length === 0) this.recentJoinerSpam.delete(uid); else this.recentJoinerSpam.set(uid, filtered);
        }
        this.waveTimes = this.waveTimes.filter(t => now - t < this.config.raidWaveWindowMs);
    }
}

// ================= ANTI-VIOLATION HANDLER =================
class AntiViolationHandler {
    constructor(CONFIG) {
        this.CONFIG = CONFIG;
        this.violationTracker = new ViolationTracker(15_000, 3);
        this.escalationTracker = new EscalationTracker(CONFIG.escalationWindow);
        this.everyoneEscalation = new EveryoneEscalationTracker(CONFIG.escalationWindow);
        this.spamTracker = new SpamTracker(CONFIG);
        this.pingTracker = new PingTracker(CONFIG);
        this.raidTracker = new RaidTracker(CONFIG);
        this.strikeCount = new Map();
    }
    addStrike(userId) {
        const current = this.strikeCount.get(userId) || 0;
        this.strikeCount.set(userId, current + 1);
        return current + 1;
    }
    getStrikes(userId) { return this.strikeCount.get(userId) || 0; }
    isImmune(member, ownerId, whitelistedIds, immuneRoleId) {
        if (!member) return false;
        if (member.id === member.guild.ownerId || member.id === ownerId) return "OWNER";
        if (whitelistedIds.includes(member.id)) return "WHITELIST";
        if (member.roles.cache.has(immuneRoleId)) return "ROLE";
        return false;
    }
    isFreeChannel(channelId, freeChannels) { return freeChannels.includes(channelId); }
    async applyTimeout(member, guild, escalationTracker, authorId, reason, logLabel, pingUser = null) {
        if (!member || !member.moderatable) return { success: false };
        try {
            const level = escalationTracker.increment(member.id);
            const timeoutMs = escalationTracker.getTimeout(level);
            const label = escalationTracker.getLabel(level);
            await member.timeout(timeoutMs, reason).catch(err => Logger.error('applyTimeout', `${member.id}: ${err.message}`));
            if (level === 2) {
                try { await member.send({ content: `⚠️ **TIMEOUT 24 ORE** per ripetute violazioni. Al prossimo episodio verrai segnalato allo staff.` }); } catch (e) {}
            }
            return { success: true, level, label, timeoutMs };
        } catch (err) {
            Logger.error('applyTimeout', err.message);
            return { success: false };
        }
    }
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
                .setDescription(`Sei stato messo in timeout per **${label}** a causa di **${typeLabel}** nel canale <#${channelId}>.\n\n**Livello Escalation:** ${level + 1}/3\n\nSe pensi si tratti di un errore, contatta lo staff.`)
                .setColor(level === 0 ? '#f1c40f' : level === 1 ? '#e67e22' : '#e74c3c')
                .setTimestamp();
            await member.send({ embeds: [embed] });
        } catch {}
    }
    async handleSpam(message, broadcastLog) {
        if (!message.member || this.isImmune(message.member, this.CONFIG.ownerId, this.CONFIG.whitelistedIds, this.CONFIG.immuneRoleId)) return false;
        if (this.isFreeChannel(message.channelId, this.CONFIG.aiFreeChannels)) return false;
        const uid = message.author.id;
        const chId = message.channelId;
        const isVoice = message.channel.isVoiceBased?.();
        if (isVoice) {
            const voiceCount = this.spamTracker.addVoiceSpam(uid);
            if (voiceCount >= this.CONFIG.voiceSpamLimit) {
                this.spamTracker.clear(uid);
                const [, result] = await Promise.all([
                    message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                    this.applyTimeout(message.member, message.guild, this.escalationTracker, uid, `Spam canale vocale (step ${this.escalationTracker.getLevel(uid) + 1})`, `🔇 Anti-Spam Vocale`)
                ]);
                if (result.success) {
                    const strikes = this.addStrike(uid);
                    this.sendEscalationDM(message.member, 'spam', result.level, chId).catch(() => {});
                    broadcastLog(message.guild, `🔇 Anti-Spam Vocale [step ${result.level + 1}]`, `**${message.author.tag}** → Timeout **${result.label}**\nMessaggi: ${voiceCount}\n**Strike: ${strikes}**`, '#e74c3c', uid).catch(() => {});
                }
                return true;
            }
            return false;
        }
        const rotData = this.spamTracker.addRotationalSpam(uid, chId);
        if (rotData.totalMessages >= this.CONFIG.rotSpamLimit && rotData.uniqueChannels >= this.CONFIG.rotSpamChannels) {
            this.spamTracker.clear(uid);
            const [, result] = await Promise.all([
                message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                this.punish(message.member, message.guild, this.escalationTracker, uid, `Spam rotazionale (step ${this.escalationTracker.getLevel(uid) + 1})`, `🔄 Anti-Spam Rotazionale`)
            ]);
            if (result.success) {
                const strikes = this.addStrike(uid);
                this.sendEscalationDM(message.member, 'spam', result.level, chId).catch(() => {});
                broadcastLog(message.guild, `🔄 Anti-Spam Rotazionale [step ${result.level + 1}]`, `**${message.author.tag}** → Timeout **${result.label}**\nMessaggi: ${rotData.totalMessages} canali: ${rotData.uniqueChannels}\n**Strike: ${strikes}**`, '#e67e22', uid).catch(() => {});
            }
            return true;
        }
        const localCount = this.spamTracker.addLocalSpam(uid, chId);
        if (localCount >= this.CONFIG.localSpamLimit) {
            this.spamTracker.clear(uid);
            const [, result] = await Promise.all([
                message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                this.applyTimeout(message.member, message.guild, this.escalationTracker, uid, `Spam locale (step ${this.escalationTracker.getLevel(uid) + 1})`, `🛑 Anti-Spam Locale`)
            ]);
            if (result.success) {
                const strikes = this.addStrike(uid);
                this.sendEscalationDM(message.member, 'spam', result.level, chId).catch(() => {});
                broadcastLog(message.guild, `🛑 Anti-Spam Locale [step ${result.level + 1}]`, `**${message.author.tag}** → Timeout **${result.label}**\nMessaggi: ${localCount}\n**Strike: ${strikes}**`, '#e74c3c', uid).catch(() => {});
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
        if (!message.member || this.isImmune(message.member, this.CONFIG.ownerId, this.CONFIG.whitelistedIds, this.CONFIG.immuneRoleId)) return false;
        if (this.isFreeChannel(message.channelId, this.CONFIG.aiFreeChannels)) return false;
        if (totalPings === 0) return false;
        const uid = message.author.id;
        const chId = message.channelId;
        const isVoice = message.channel.isVoiceBased?.();
        const guild = message.guild;
        const messagePingCount = 1;
        if (targets.has('everyone')) {
            const rapidCount = this.pingTracker.addEveryoneRapid(uid);
            if (rapidCount >= 3) {
                this.pingTracker.clearEveryoneRapid(uid);
                const level = this.everyoneEscalation.increment(uid);
                const timeoutMs = this.everyoneEscalation.getTimeout(level);
                const label = this.everyoneEscalation.getLabel(level);
                const reason = `Abuso @everyone: ${rapidCount} menzioni in 1 minuto (livello ${level + 1}/5)`;
                const [, result] = await Promise.all([
                    message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                    message.member.timeout(timeoutMs, reason).then(() => ({ success: true })).catch(err => {
                        Logger.error('everyone-rapido', `Timeout ${uid}: ${err.message}`);
                        return { success: false };
                    })
                ]);
                if (result.success) {
                    const strikes = this.addStrike(uid);
                    broadcastLog(guild, `🚨 @Everyone Abuso Rapido [livello ${level + 1}/5]`, `**${message.author.tag}** → Timeout **${label}**\nMenzioni: ${rapidCount} in 1 minuto\n**Strike: ${strikes}**`, level >= 3 ? '#c0392b' : '#e67e22', uid).catch(() => {});
                    if (message.member.user.bot && level >= 4 && message.member.bannable) {
                        try {
                            await message.member.ban({ reason: `Auto-ban bot: @everyone abusivo livello massimo` });
                            await broadcastLog(guild, `🔨 AUTO-BAN BOT`, `**${message.author.tag}** (bot) bannato per @everyone abusivo ripetuto.`, '#c0392b', uid).catch(() => {});
                        } catch (e) { Logger.error('AutoBan', `${uid}: ${e.message}`); }
                    }
                }
                return true;
            }
            const evResult = this.pingTracker.addEveryonePing(uid, chId);
            if (evResult.uniqueChannels >= 2) {
                const abuseResult = this.pingTracker.addEveryoneAbusePing(uid, chId);
                this.pingTracker.everyoneCache.delete(uid);
                this.pingTracker.rotationalCache.delete(uid);
                this.pingTracker.globalCache.delete(uid);
                if (abuseResult.totalMessages >= this.CONFIG.everyoneAbuseLimit && abuseResult.uniqueChannels >= this.CONFIG.everyoneAbuseLimit) {
                    this.pingTracker.clearEveryoneAbuse(uid);
                    const timeoutMs = this.CONFIG.everyoneAbuseTimeoutMs;
                    const reason = `Abuso @everyone multi-canale: ${abuseResult.totalMessages} incidenti in ${abuseResult.uniqueChannels} canali`;
                    const [, timeoutResult] = await Promise.all([
                        message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                        message.member.timeout(timeoutMs, reason).then(() => ({ success: true })).catch(() => ({ success: false }))
                    ]);
                    if (timeoutResult.success) {
                        const strikes = this.addStrike(uid);
                        broadcastLog(guild, `🚨 @Everyone Multi-Canale Ripetuto`, `**${message.author.tag}** → Timeout **6 ore**\nIncidenti: ${abuseResult.totalMessages} | Canali: ${abuseResult.uniqueChannels}\n**Strike: ${strikes}**`, '#c0392b', uid).catch(() => {});
                    }
                    return true;
                }
                const [, result] = await Promise.all([
                    message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                    this.applyTimeout(message.member, guild, this.escalationTracker, uid, `@everyone su ${evResult.uniqueChannels} canali (step ${this.escalationTracker.getLevel(uid) + 1})`, `@Everyone Multi-Canale`)
                ]);
                if (result.success) {
                    const strikes = this.addStrike(uid);
                    this.sendEscalationDM(message.member, 'ping', result.level, chId).catch(() => {});
                    broadcastLog(guild, `⚠️ @Everyone Multi-Canale [step ${result.level + 1}]`, `**${message.author.tag}** → Timeout **${result.label}**\nCanali: ${evResult.uniqueChannels}\n**Strike: ${strikes}**`, '#e67e22', uid).catch(() => {});
                    if (message.member.user.bot && strikes >= 5 && message.member.bannable) {
                        try {
                            await message.member.ban({ reason: `Auto-ban bot: 5+ violazioni anti-ping` });
                            await broadcastLog(guild, `🔨 AUTO-BAN BOT`, `**${message.author.tag}** (bot) bannato dopo **5 violazioni anti-ping**.`, '#c0392b', uid).catch(() => {});
                        } catch (e) { Logger.error('AutoBan', `${uid}: ${e.message}`); }
                    }
                }
                return true;
            }
        }
        for (const targetId of targets) {
            if (targetId === 'everyone') continue;
            const rotResult = this.pingTracker.addRotationalPing(uid, targetId, chId, isVoice, messagePingCount);
            if (rotResult.uniqueChannels >= this.CONFIG.rotPingChannels) {
                this.pingTracker.clearUser(uid);
                const targetName = guild.roles.cache.get(targetId) ? `@${guild.roles.cache.get(targetId).name}` : `target:${targetId}`;
                const [, result] = await Promise.all([
                    message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                    this.punish(message.member, guild, this.escalationTracker, uid, `Ping rotazionale ${targetName} su ${rotResult.uniqueChannels} canali`, `🔁 Anti-Ping Rotazionale`)
                ]);
                if (result.success) {
                    const strikes = this.addStrike(uid);
                    this.sendEscalationDM(message.member, 'ping', result.level, chId).catch(() => {});
                    broadcastLog(guild, `🔁 Anti-Ping Rotazionale [step ${result.level + 1}]`, `**${message.author.tag}** → Timeout **${result.label}**\nTarget: ${targetName} | Canali: ${rotResult.uniqueChannels}\n**Strike: ${strikes}**`, '#e67e22', uid).catch(() => {});
                }
                return true;
            }
        }
        const globalCount = this.pingTracker.addGlobalPing(uid, messagePingCount);
        if (globalCount >= this.CONFIG.globalPingLimit) {
            this.pingTracker.clearUser(uid);
            const [, result] = await Promise.all([
                message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                this.punish(message.member, guild, this.escalationTracker, uid, `Ping globale ${globalCount} in ${this.CONFIG.globalPingWindow / 1000}s (step ${this.escalationTracker.getLevel(uid) + 1})`, `🌐 Anti-Ping Globale`)
            ]);
            if (result.success) {
                const strikes = this.addStrike(uid);
                this.sendEscalationDM(message.member, 'ping', result.level, chId).catch(() => {});
                broadcastLog(guild, `🌐 Anti-Ping Globale [step ${result.level + 1}]`, `**${message.author.tag}** → Timeout **${result.label}**\nPing totali: ${globalCount}\n**Strike: ${strikes}**`, '#c0392b', uid).catch(() => {});
            }
            return true;
        }
        if (isVoice) {
            const voiceCount = this.pingTracker.addVoicePing(uid, chId, messagePingCount);
            if (voiceCount >= this.CONFIG.voicePingLimit) {
                this.pingTracker.clearUser(uid);
                const [, result] = await Promise.all([
                    message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                    this.applyTimeout(message.member, guild, this.escalationTracker, uid, `Ping canale vocale ${voiceCount} in ${this.CONFIG.voicePingWindow / 1000}s (step ${this.escalationTracker.getLevel(uid) + 1})`, `🔊 Anti-Ping Vocale`)
                ]);
                if (result.success) {
                    const strikes = this.addStrike(uid);
                    this.sendEscalationDM(message.member, 'ping', result.level, chId).catch(() => {});
                    broadcastLog(guild, `🔊 Anti-Ping Vocale [step ${result.level + 1}]`, `**${message.author.tag}** → Timeout **${result.label}**\nPing: ${voiceCount}\n**Strike: ${strikes}**`, result.level === 0 ? '#f1c40f' : result.level === 1 ? '#e67e22' : '#e74c3c', uid).catch(() => {});
                }
                return true;
            }
            return false;
        }
        const textCount = this.pingTracker.addTextPing(uid, chId, messagePingCount);
        if (textCount >= this.CONFIG.textPingLimit) {
            this.pingTracker.clearUser(uid);
            const [, result] = await Promise.all([
                message.deletable ? message.delete().catch(() => {}) : Promise.resolve(),
                this.applyTimeout(message.member, guild, this.escalationTracker, uid, `Ping testuale ${textCount} in ${this.CONFIG.textPingWindow / 1000}s (step ${this.escalationTracker.getLevel(uid) + 1})`, `📢 Anti-Ping Testuale`)
            ]);
            if (result.success) {
                const strikes = this.addStrike(uid);
                this.sendEscalationDM(message.member, 'ping', result.level, chId).catch(() => {});
                broadcastLog(guild, `📢 Anti-Ping Testuale [step ${result.level + 1}]`, `**${message.author.tag}** → Timeout **${result.label}**\nPing: ${textCount}\n**Strike: ${strikes}**`, '#f1c40f', uid).catch(() => {});
            }
            return true;
        }
        return false;
    }
    async handleRaidJoin(member) {
        if (this.isImmune(member, this.CONFIG.ownerId, this.CONFIG.whitelistedIds, this.CONFIG.immuneRoleId)) return false;
        const counts = this.raidTracker.registerJoin(member);
        const reasons = this.raidTracker.checkRaidThreshold(counts);
        if (reasons.length > 0) { this.raidTracker.reset(); return reasons; }
        return false;
    }
    cleanup() {
        this.spamTracker.cleanup();
        this.pingTracker.cleanup();
        this.violationTracker.cleanup();
        this.escalationTracker.cleanup();
        this.everyoneEscalation.cleanup();
    }
    reset() {
        this.spamTracker = new SpamTracker(this.CONFIG);
        this.pingTracker = new PingTracker(this.CONFIG);
        this.raidTracker = new RaidTracker(this.CONFIG);
        this.violationTracker = new ViolationTracker(15_000, 3);
        this.everyoneEscalation = new EveryoneEscalationTracker(this.CONFIG.escalationWindow);
    }
}

// ================= CONFIGURAZIONE =================
function envList(name) { return (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean); }

const CONFIG = {
    ownerId: process.env.OWNER_ID || "0",
    clientId: process.env.CLIENT_ID || "0",
    guildId: process.env.GUILD_ID || "0",
    logChannels: envList('LOG_CHANNEL_IDS'),
    alertChannelId: process.env.ALERT_CHANNEL_ID || "0",
    suspiciousBotLogChannelId: process.env.SUSPICIOUS_BOT_LOG_CHANNEL_ID || "0",
    suspiciousBotLogChannelNames: ["bot-sospetto", "bot sospetto", "bot_sospetto"],
    verifyChannelId: process.env.VERIFY_CHANNEL_ID || "0",
    welcomeChannelId: process.env.WELCOME_CHANNEL_ID || "0",
    immuneRoleId: process.env.IMMUNE_ROLE_ID || "0",
    memberRoleId: process.env.MEMBER_ROLE_ID || "0",
    ogRoleId: process.env.OG_ROLE_ID || "0",
    whitelistedIds: envList('WHITELISTED_IDS'),

    // logging
    messageLogChannelId: process.env.MESSAGE_LOG_CHANNEL_ID || "0",
    voiceLogChannelId: process.env.VOICE_LOG_CHANNEL_ID || "0",
    memberLogChannelId: process.env.MEMBER_LOG_CHANNEL_ID || "0",
    modLogChannelId: process.env.MOD_LOG_CHANNEL_ID || "0",

    // spam
    localSpamLimit: 3,
    localSpamWindow: 5000,
    rotSpamLimit: 3,
    rotSpamChannels: 2,
    rotSpamWindow: 6000,
    voiceSpamLimit: 3,
    voiceSpamWindow: 7000,

    // ping
    textPingLimit: 5,
    textPingWindow: 6000,
    voicePingLimit: 4,
    voicePingWindow: 8000,
    rotPingChannels: 3,
    rotPingWindow: 8000,
    globalPingLimit: 8,
    globalPingWindow: 10000,

    // timeout
    timeoutDueMin: 2 * 60 * 1000,
    timeoutDieciMin: 10 * 60 * 1000,
    timeoutUnOra: 60 * 60 * 1000,

    // raid
    raidJoinLimit: 5,
    raidJoinTime: 10000,
    raidSlowJoinLimit: 15,
    raidSlowJoinTime: 60000,
    raidNewAccountJoinLimit: 3,
    raidNewAccountAgeMs: 7 * 24 * 60 * 60 * 1000,
    raidNewAccountJoinTime: 60000,
    raidRecentJoinerWindowMs: 5 * 60 * 1000,
    raidRecentJoinerSpamWindowMs: 10000,
    raidRecentJoinerSpamLimit: 5,
    raidWaveWindowMs: 60 * 60 * 1000,

    // altri
    maxTimeoutMinutes: 40320,
    suspiciousBotTimeoutMs: 7 * 24 * 60 * 60 * 1000,
    everyoneAbuseWindow: 2 * 60 * 60 * 1000,
    everyoneAbuseLimit: 2,
    everyoneAbuseTimeoutMs: 6 * 60 * 60 * 1000,
    auditLogWindow: 2500,
    permessiTTL: 30 * 60 * 1000,
    aiFreeChannels: envList('AI_FREE_CHANNEL_IDS'),
    escalationWindow: 48 * 60 * 60 * 1000,

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
        bots: { label: 'Bots', emoji: '🤖' },
        staff: { label: 'Staff', emoji: '🛡️' },
        all: { label: 'Tutti', emoji: '🌐' }
    },
    statsMinGapMs: 6 * 60 * 1000,

    ticketEnabled: true,
    ticketCategoryName: '🎫 TICKET',
    ticketPanelChannelName: 'assistenza',
    ticketReasonRoles: {
        membri: { label: 'Problema tra membri', emoji: '⚔️', roleId: process.env.TICKET_ROLE_MEMBRI || "0" },
        bot: { label: 'Problema con il bot', emoji: '🤖', roleId: process.env.TICKET_ROLE_BOT || "0" }
    },

    // novità
    autoPublishChannels: envList('AUTO_PUBLISH_CHANNELS'),
    autoThreadChannels: envList('AUTO_THREAD_CHANNELS'),
    antiGhostPingEnabled: true,
    antiEveryoneFromBots: true
};

const SETTINGS_FILE = './config.settings.json';
const SETTABLE_FIELDS = [
    'ownerId', 'logChannels', 'alertChannelId', 'suspiciousBotLogChannelId',
    'verifyChannelId', 'welcomeChannelId', 'immuneRoleId', 'memberRoleId',
    'ogRoleId', 'whitelistedIds', 'aiFreeChannels', 'staffRoleIds', 'ticketReasonRoles',
    'messageLogChannelId', 'voiceLogChannelId', 'memberLogChannelId', 'modLogChannelId',
    'autoPublishChannels', 'autoThreadChannels'
];

function loadSettings() {
    try { if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')); } catch (e) { Logger.error('Settings', e.message); }
    return null;
}
function applyPersistedSettings() {
    const saved = loadSettings();
    if (!saved) return;
    for (const key of SETTABLE_FIELDS) {
        if (saved[key] === undefined) continue;
        if (key === 'staffRoleIds' || key === 'ticketReasonRoles') CONFIG[key] = { ...CONFIG[key], ...saved[key] };
        else CONFIG[key] = saved[key];
    }
    Logger.info('Settings', 'Configurazione caricata da', SETTINGS_FILE);
}
function persistSettings() {
    try {
        const snapshot = {};
        for (const key of SETTABLE_FIELDS) snapshot[key] = CONFIG[key];
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(snapshot, null, 2));
    } catch (e) { Logger.error('Settings', e.message); }
}
applyPersistedSettings();

function addToIdList(fieldName, id) { if (!CONFIG[fieldName].includes(id)) CONFIG[fieldName].push(id); persistSettings(); }
function removeFromIdList(fieldName, id) { CONFIG[fieldName] = CONFIG[fieldName].filter(v => v !== id); persistSettings(); }
function setConfigField(fieldName, value) { CONFIG[fieldName] = value; persistSettings(); }
function setStaffRoleField(key, roleId) { CONFIG.staffRoleIds[key] = roleId; persistSettings(); }
function setTicketReasonRole(key, roleId) {
    if (!CONFIG.ticketReasonRoles[key]) return false;
    CONFIG.ticketReasonRoles[key].roleId = roleId;
    persistSettings();
    return true;
}

// ================= AUDIT LOG CACHE =================
const auditLogHotCache = new Map();
const auditLogPending = new Map();
const AUDIT_LOG_CACHE_SIZE = 50;

function updateAuditLogHotCache(guildId, entry) {
    if (!auditLogHotCache.has(guildId)) auditLogHotCache.set(guildId, []);
    const cache = auditLogHotCache.get(guildId);
    cache.unshift({ type: entry.action, targetId: entry.target?.id, executor: entry.executor, timestamp: entry.createdTimestamp, entry });
    if (cache.length > AUDIT_LOG_CACHE_SIZE) cache.pop();
}
function searchAuditLogHotCache(guildId, type, targetId, maxAge = CONFIG.auditLogWindow) {
    const cache = auditLogHotCache.get(guildId);
    if (!cache || cache.length === 0) return null;
    const now = Date.now();
    for (const item of cache) {
        if (item.type === type && item.targetId === targetId && (now - item.timestamp) < maxAge) return item.entry;
    }
    return null;
}
async function fetchAuditLogEntry(guild, type, targetId, maxWait = CONFIG.auditLogWindow) {
    if (!guild) return null;
    const cachedEntry = searchAuditLogHotCache(guild.id, type, targetId, maxWait);
    if (cachedEntry) return cachedEntry;
    const pendingKey = `${guild.id}-${type}-${targetId}`;
    if (auditLogPending.has(pendingKey)) return auditLogPending.get(pendingKey);
    const fetchPromise = (async () => {
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const logs = await guild.fetchAuditLogs({ limit: 10, type }).catch(() => null);
                    if (!logs?.entries.size) { if (attempt < 1) await delay(25 * Math.pow(2, attempt)); continue; }
                    for (const [, entry] of logs.entries) {
                        updateAuditLogHotCache(guild.id, entry);
                        if (entry.target?.id === targetId && Date.now() - entry.createdTimestamp < maxWait + 1000) return entry;
                    }
                    break;
                } catch (err) { if (attempt < 1) await delay(25); }
            }
        } catch (e) { Logger.error('fetchAuditLogEntry', e.message); }
        return null;
    })();
    auditLogPending.set(pendingKey, fetchPromise);
    const result = await fetchPromise;
    auditLogPending.delete(pendingKey);
    return result;
}

const processedAuditEntries = new Map();
const PROCESSED_ENTRY_TTL = 10_000;
function markAuditEntryProcessed(entryId) { if (entryId) processedAuditEntries.set(entryId, Date.now()); }
function isAuditEntryProcessed(entryId) {
    if (!entryId) return false;
    const t = processedAuditEntries.get(entryId);
    if (!t) return false;
    if (Date.now() - t > PROCESSED_ENTRY_TTL) { processedAuditEntries.delete(entryId); return false; }
    return true;
}
function tryClaimAuditEntry(entryId) {
    if (!entryId) return false;
    if (isAuditEntryProcessed(entryId)) return false;
    markAuditEntryProcessed(entryId);
    return true;
}
function cleanupProcessedAuditEntries() {
    const now = Date.now();
    for (const [id, t] of processedAuditEntries) if (now - t > PROCESSED_ENTRY_TTL) processedAuditEntries.delete(id);
}

async function setupAuditLogListener(client) {
    const trackedTypes = [
        AuditLogEvent.ChannelCreate, AuditLogEvent.ChannelUpdate, AuditLogEvent.ChannelDelete,
        AuditLogEvent.RoleCreate, AuditLogEvent.RoleUpdate, AuditLogEvent.RoleDelete,
        AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberKick
    ];
    setInterval(async () => {
        for (const guild of client.guilds.cache.values()) {
            guild.fetchAuditLogs({ limit: 5 }).then(logs => {
                for (const [, entry] of logs.entries) {
                    if (trackedTypes.includes(entry.action)) updateAuditLogHotCache(guild.id, entry);
                }
            }).catch(() => {});
        }
    }, 20_000);
    Logger.info('AuditLog', 'Listener configurato.');
}

// ================= REGOLAMENTO =================
const RULES_SECTIONS = [
    { title: "1️⃣ Comportamento Generale e Rispetto", text: "**1.1.** È richiesto un comportamento civile, educato e rispettoso verso tutti i membri e lo staff.\n**1.2.** Non sono tollerati insulti, molestie, provocazioni, atteggiamenti tossici o discriminazioni di qualsiasi natura.\n**1.3.** Discussioni e dibattiti sono ammessi, purché restino costruttivi." },
    { title: "2️⃣ Canali Testuali e Vocali", text: "**2.1.** Ogni canale ha una funzione specifica: rispettate la destinazione d'uso.\n**2.2.** Vietati spam di messaggi, abuso di menzioni non necessarie e invio massivo di media/link.\n**2.3.** Nei canali vocali è vietato l'uso di soundboard, musica ad alto volume o rumori molesti." },
    { title: "3️⃣ Contenuti di Gioco e Condivisione", text: "**3.1.** Vietata la condivisione di materiale classificato, documenti militari protetti da segreto o dati tecnici sensibili.\n**3.2.** Link esterni, contenuti multimediali o inviti ad altri server sono consentiti solo previa autorizzazione dello staff." },
    { title: "4️⃣ Condotta di Gioco (War Thunder)", text: "**4.1.** Nelle partite di squadra è richiesta coordinazione e rispetto delle direttive del caposquadra.\n**4.2.** Non tollerato comportamento antisportivo: teamkilling intenzionale o abbandono deliberato.\n**4.3.** Severamente vietato promuovere, diffondere o utilizzare cheat, exploit o modifiche client non autorizzate." },
    { title: "5️⃣ Moderazione e Sanzioni", text: "**5.1.** Moderatori e amministratori hanno l'ultima parola sulla gestione delle controversie.\n**5.2.** Sanzioni applicabili: richiamo formale, mute temporaneo, kick o ban permanente.\n**5.3.** Il mancato rispetto delle indicazioni dello staff comporta un aggravamento immediato." }
];

function buildRulesEmbeds(guild) {
    const embeds = [];
    const header = new EmbedBuilder()
        .setTitle("📜 Regolamento del Server")
        .setDescription("Benvenuto! Leggi con attenzione le regole prima di partecipare.\n\nℹ️ **Gli unici canali completamente \"free\" sono quelli con l'AI.**")
        .setColor('#5865F2')
        .setTimestamp();
    if (guild?.iconURL) header.setThumbnail(guild.iconURL({ size: 256 }));
    embeds.push(header);
    for (let i = 0; i < RULES_SECTIONS.length; i += 5) {
        const chunk = RULES_SECTIONS.slice(i, i + 5);
        const embed = new EmbedBuilder().setColor('#5865F2');
        for (const s of chunk) embed.addFields({ name: s.title, value: s.text });
        embeds.push(embed);
    }
    const footer = new EmbedBuilder()
        .setDescription(`**Per ogni problema, taggate lo staff competente:**\n${mentionStaffRole('helper')} · ${mentionStaffRole('moderator')} · ${mentionStaffRole('founder')} · ${mentionStaffRole('headMedia')}`)
        .setColor('#2b2d31');
    embeds.push(footer);
    return embeds;
}
function mentionStaffRole(key) {
    const id = CONFIG.staffRoleIds[key];
    return id && id !== "0" ? `<@&${id}>` : `\`${key}\``;
}

// ================= CLIENT =================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildModeration
    ],
    partials: [Partials.Channel, Partials.GuildMember, Partials.Message]
});

const antiViolation = new AntiViolationHandler(CONFIG);
const permessiTemporanei = new Map();
let raidModeActive = false;
let lockdownActive = false;

setInterval(() => {
    antiViolation.cleanup();
    cleanupProcessedAuditEntries();
    Logger.debug('Cleanup', 'Cache puliti');
}, 5 * 60 * 1000);

setInterval(() => {
    if (!CONFIG.statsEnabled) return;
    for (const guild of client.guilds.cache.values()) scheduleStatsUpdate(guild);
}, CONFIG.statsMinGapMs);

// ================= MEMBER NUMBERS =================
const MEMBER_NUMBERS_FILE = './member_numbers.json';
function loadMemberNumbers() {
    try { if (fs.existsSync(MEMBER_NUMBERS_FILE)) return JSON.parse(fs.readFileSync(MEMBER_NUMBERS_FILE, 'utf-8')); } catch (e) { Logger.error('MemberNumbers', e.message); }
    return { members: {}, nextNumber: 1 };
}
function saveMemberNumbers(data) {
    try { fs.writeFileSync(MEMBER_NUMBERS_FILE, JSON.stringify(data, null, 2)); } catch (e) { Logger.error('MemberNumbers', e.message); }
}
function getMemberNumber(userId, guild) {
    const data = loadMemberNumbers();
    if (data.members[userId] !== undefined) return data.members[userId];
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
        .setDescription(`**Motivo:** ${reason}\n\nTutti i canali sono stati bloccati.\n⚠️ Il lockdown **NON** si disattiva automaticamente: serve \`!unlock\`.`)
        .setColor('#ff0000')
        .setTimestamp();

    const textChannels = guild.channels.cache.filter(c => (c.isTextBased() && !c.isThread()) || c.type === 0);
    await Promise.all(textChannels.map(async ch => {
        try {
            const jobs = [ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {})];
            if (typeof ch.setRateLimitPerUser === 'function') jobs.push(ch.setRateLimitPerUser(120).catch(() => {}));
            await Promise.all(jobs);
        } catch (e) { Logger.error('lockdown', `${ch.id}: ${e.message}`); }
    }));

    Logger.warn('Lockdown', `ATTIVO — ${reason}`);

    (async () => {
        const alertCh = (CONFIG.alertChannelId && CONFIG.alertChannelId !== "0")
            ? (guild.channels.cache.get(CONFIG.alertChannelId) || await guild.channels.fetch(CONFIG.alertChannelId).catch(() => null))
            : null;
        if (alertCh) await alertCh.send({ content: `<@${CONFIG.ownerId}>`, embeds: [embed] }).catch(() => {});
        else await dmOwnerFallback(guild, embed);
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

    const textChannels = guild.channels.cache.filter(c => (c.isTextBased() && !c.isThread()) || c.type === 0);
    await Promise.all(textChannels.map(async ch => {
        try {
            const jobs = [ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }).catch(() => {})];
            if (typeof ch.setRateLimitPerUser === 'function') jobs.push(ch.setRateLimitPerUser(0).catch(() => {}));
            await Promise.all(jobs);
        } catch (e) { Logger.error('unlock', `${ch.id}: ${e.message}`); }
    }));

    Logger.warn('Lockdown', `RIMOSSO — ${reason}`);

    (async () => {
        const alertCh = (CONFIG.alertChannelId && CONFIG.alertChannelId !== "0")
            ? (guild.channels.cache.get(CONFIG.alertChannelId) || await guild.channels.fetch(CONFIG.alertChannelId).catch(() => null))
            : null;
        if (alertCh) await alertCh.send({ embeds: [embed] }).catch(() => {});
        else await dmOwnerFallback(guild, embed);
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
        .setDescription(`${user} ha attivato un controllo di sicurezza, ma **questo è l'Owner**. Azione annullata.`)
        .setColor('#f1c40f')
        .setThumbnail(user.displayAvatarURL())
        .setFooter({ text: 'Immunità Regale Attiva' })
        .setTimestamp();
    return channel.send({ embeds: [embed] }).catch(() => {});
}
async function dmOwnerFallback(guild, embed, pingUser = null) {
    try {
        const owner = await client.users.fetch(CONFIG.ownerId).catch(() => null);
        if (!owner) return false;
        const payload = { embeds: [embed] };
        payload.content = pingUser ? `⚠️ Nessun canale log — utente: <@${pingUser}>` : `⚠️ Nessun canale log${guild ? ` — server: ${guild.name}` : ''}`;
        await owner.send(payload);
        return true;
    } catch (e) { Logger.error('dmOwnerFallback', e.message); return false; }
}
function getUniqueLogChannelIds() {
    const raw = Array.isArray(CONFIG.logChannels) ? CONFIG.logChannels : [];
    return [...new Set(raw.filter(id => id && id !== "0"))];
}
async function sendLog(guild, embed, specificChannelId = null) {
    Logger.info('Log', `${embed?.data?.title ?? 'Evento'} — ${embed?.data?.description ?? ''}`);
    if (!guild) return;
    let sent = false;
    const channelIds = specificChannelId && specificChannelId !== "0"
        ? [specificChannelId]
        : getUniqueLogChannelIds();
    for (const channelId of channelIds) {
        try {
            const ch = await guild.channels.fetch(channelId).catch(() => null);
            if (!ch || !ch.isTextBased()) continue;
            const me = guild.members.me;
            if (me && !ch.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) continue;
            await ch.send({ embeds: [embed] }).catch(() => {});
            sent = true;
        } catch (e) { Logger.error('sendLog', e.message); }
    }
    if (!sent && !specificChannelId) await dmOwnerFallback(guild, embed);
}
async function broadcastLog(guild, title, description, color = '#ff0000', pingUser = null) {
    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
    Logger.info('Broadcast', `${title} — ${description}`);
    if (!guild) return;
    let sent = false;
    for (const id of getUniqueLogChannelIds()) {
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
    if (!sent) await dmOwnerFallback(guild, embed, pingUser);
}
async function sendSuspiciousBotLog(guild, member) {
    if (!guild || !member) return false;
    const founderRoleId = CONFIG.staffRoleIds?.founder;
    const founderPing = founderRoleId && founderRoleId !== "0" ? `<@&${founderRoleId}>` : `<@${CONFIG.ownerId}>`;
    let channel = null;
    if (CONFIG.suspiciousBotLogChannelId && CONFIG.suspiciousBotLogChannelId !== "0") {
        channel = guild.channels.cache.get(CONFIG.suspiciousBotLogChannelId) || await guild.channels.fetch(CONFIG.suspiciousBotLogChannelId).catch(() => null);
    }
    if (!channel) {
        const names = (CONFIG.suspiciousBotLogChannelNames || []).map(n => String(n).trim().toLowerCase());
        channel = guild.channels.cache.find(ch => ch.isTextBased?.() && names.includes(String(ch.name || '').trim().toLowerCase())) || null;
    }
    const embed = new EmbedBuilder()
        .setTitle('🤖 BOT SOSPETTO RILEVATO')
        .setDescription('È entrato un bot nel server e gli è stato applicato un timeout di **7 giorni**.')
        .addFields(
            { name: 'Bot', value: `${member} — **${member.user.tag}**`, inline: false },
            { name: 'ID', value: `\`${member.id}\``, inline: true },
            { name: 'Timeout', value: '7 giorni', inline: true }
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

// ================= BACKUP =================
const BACKUPS_DIR = './backups';
const BACKUPS_HISTORY_DIR = './backups/history';
const BACKUP_HISTORY_KEEP = 10;
function getBackupPath(guildId) { return `${BACKUPS_DIR}/backup_${guildId}.json`; }
function getBackupHistoryPath(guildId, timestamp) { return `${BACKUPS_HISTORY_DIR}/backup_${guildId}_${timestamp.replace(/[:.]/g, '-')}.json`; }
function ensureBackupsDir() {
    try {
        if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
        if (!fs.existsSync(BACKUPS_HISTORY_DIR)) fs.mkdirSync(BACKUPS_HISTORY_DIR, { recursive: true });
    } catch (e) { Logger.error('ensureBackupsDir', e.message); }
}
function pruneBackupHistory(guildId) {
    try {
        const prefix = `backup_${guildId}_`;
        const files = fs.readdirSync(BACKUPS_HISTORY_DIR).filter(f => f.startsWith(prefix))
            .map(f => ({ f, t: fs.statSync(`${BACKUPS_HISTORY_DIR}/${f}`).mtimeMs }))
            .sort((a, b) => b.t - a.t);
        for (const old of files.slice(BACKUP_HISTORY_KEEP)) fs.unlinkSync(`${BACKUPS_HISTORY_DIR}/${old.f}`);
    } catch (e) { Logger.error('pruneBackupHistory', e.message); }
}
function protectedRoleIdsFor(guild) {
    return new Set([
        CONFIG.memberRoleId, CONFIG.immuneRoleId, CONFIG.ogRoleId,
        ...Object.values(CONFIG.staffRoleIds || {}),
        ...Object.values(CONFIG.ticketReasonRoles || {}).map(r => r.roleId)
    ].filter(id => id && id !== "0"));
}
function serializeOverwrites(channel, guild, roleTempIdByOldRoleId) {
    const list = [];
    for (const [, ow] of channel.permissionOverwrites.cache) {
        const entry = { allow: ow.allow.bitfield.toString(), deny: ow.deny.bitfield.toString() };
        if (ow.id === guild.id) entry.targetType = 'everyone';
        else if (ow.type === 0) {
            if (roleTempIdByOldRoleId.has(ow.id)) { entry.targetType = 'role'; entry.roleTempId = roleTempIdByOldRoleId.get(ow.id); }
            else { entry.targetType = 'role_direct'; entry.id = ow.id; }
        } else { entry.targetType = 'member'; entry.id = ow.id; }
        list.push(entry);
    }
    return list;
}
async function performGuildBackup(guild) {
    if (guild.members.cache.size < guild.memberCount) await guild.members.fetch().catch(() => {});
    const protectedRoleIds = protectedRoleIdsFor(guild);
    const backupableRoles = guild.roles.cache.filter(r => !r.managed && r.id !== guild.id && !protectedRoleIds.has(r.id));
    const roleTempIdByOldRoleId = new Map();
    let idx = 0;
    for (const [, r] of backupableRoles) roleTempIdByOldRoleId.set(r.id, idx++);
    const roles = [...backupableRoles.values()].map(r => ({
        tempId: roleTempIdByOldRoleId.get(r.id), name: r.name, color: r.color, hoist: r.hoist,
        mentionable: r.mentionable, permissions: r.permissions.bitfield.toString(), position: r.position
    }));
    const categoryChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory);
    const catTempIdByOldId = new Map();
    idx = 0;
    for (const [, c] of categoryChannels) catTempIdByOldId.set(c.id, idx++);
    const categories = [...categoryChannels.values()].map(c => ({
        tempId: catTempIdByOldId.get(c.id), name: c.name, position: c.position,
        overwrites: serializeOverwrites(c, guild, roleTempIdByOldRoleId)
    }));
    const backupableChannelTypes = [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum];
    const channels = guild.channels.cache.filter(c => backupableChannelTypes.includes(c.type)).map(c => ({
        name: c.name, type: c.type, position: c.position,
        parentTempId: c.parentId ? (catTempIdByOldId.has(c.parentId) ? catTempIdByOldId.get(c.parentId) : null) : null,
        topic: c.topic ?? null, nsfw: c.nsfw ?? false, bitrate: c.bitrate || null,
        userLimit: c.userLimit || null, rateLimitPerUser: c.rateLimitPerUser || null,
        availableTags: c.availableTags ? c.availableTags.map(t => ({ name: t.name, moderated: t.moderated })) : [],
        overwrites: serializeOverwrites(c, guild, roleTempIdByOldRoleId)
    }));
    const threads = guild.channels.cache.filter(c => c.isThread && c.isThread()).map(t => {
        const parent = t.parent ? guild.channels.cache.get(t.parent.id) : null;
        return { name: t.name, type: t.type, parentName: parent ? parent.name : null, autoArchiveDuration: t.autoArchiveDuration || 1440 };
    });
    const memberRoles = [];
    for (const [, member] of guild.members.cache) {
        if (member.user.bot) continue;
        const roleTempIds = [];
        const directRoleIds = [];
        for (const [, role] of member.roles.cache) {
            if (role.id === guild.id) continue;
            if (roleTempIdByOldRoleId.has(role.id)) roleTempIds.push(roleTempIdByOldRoleId.get(role.id));
            else if (protectedRoleIds.has(role.id) || role.managed) directRoleIds.push(role.id);
        }
        if (roleTempIds.length > 0 || directRoleIds.length > 0) memberRoles.push({ userId: member.id, roleTempIds, directRoleIds });
    }
    const timestamp = new Date().toISOString();
    const payload = {
        guildId: guild.id, guildName: guild.name, timestamp, roles, categories, channels, threads,
        settings: {
            verificationLevel: guild.verificationLevel,
            defaultMessageNotifications: guild.defaultMessageNotifications,
            explicitContentFilter: guild.explicitContentFilter,
            preferredLocale: guild.preferredLocale
        },
        memberRoles
    };
    ensureBackupsDir();
    await fs.promises.writeFile(getBackupPath(guild.id), JSON.stringify(payload, null, 2));
    await fs.promises.writeFile(getBackupHistoryPath(guild.id, timestamp), JSON.stringify(payload, null, 2));
    pruneBackupHistory(guild.id);
    return { channelsCount: channels.length, categoriesCount: categories.length, rolesCount: roles.length, threadsCount: threads.length, membersCount: memberRoles.length };
}

const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
async function runAutoBackupForAllGuilds() {
    for (const guild of client.guilds.cache.values()) {
        try {
            const r = await performGuildBackup(guild);
            Logger.info('AutoBackup', `${guild.name}: ${r.channelsCount} canali, ${r.categoriesCount} categorie, ${r.rolesCount} ruoli`);
        } catch (e) { Logger.error('AutoBackup', `${guild.name}: ${e.message}`); }
    }
}
function startAutoBackup() {
    runAutoBackupForAllGuilds().catch(e => Logger.error('AutoBackup', e.message));
    setInterval(() => runAutoBackupForAllGuilds().catch(e => Logger.error('AutoBackup', e.message)), AUTO_BACKUP_INTERVAL_MS);
    Logger.info('AutoBackup', `Attivo — ogni ${AUTO_BACKUP_INTERVAL_MS / (60 * 60 * 1000)} ore.`);
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
        result.push({ id, allow: BigInt(ow.allow || '0'), deny: BigInt(ow.deny || '0') });
    }
    return result;
}

async function performGuildRestore(guild, data) {
    const protectedRoleIds = protectedRoleIdsFor(guild);
    const channelsToDelete = guild.channels.cache.filter(c => [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum].includes(c.type));
    await Promise.all([...channelsToDelete.values()].map(ch => ch.delete().catch(() => {})));
    const catsToDelete = guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory);
    await Promise.all([...catsToDelete.values()].map(ch => ch.delete().catch(() => {})));
    const rolesToDelete = guild.roles.cache.filter(r => !r.managed && r.id !== guild.id && !protectedRoleIds.has(r.id));
    for (const [, r] of rolesToDelete) await r.delete().catch(() => {});
    const newRoleIdByTempId = new Map();
    const rolesSorted = [...(data.roles ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    let createdRoles = 0;
    for (const r of rolesSorted) {
        const created = await guild.roles.create({ name: r.name, color: r.color, hoist: r.hoist ?? false, mentionable: r.mentionable ?? false, permissions: BigInt(r.permissions), reason: 'Restore da backup' }).catch(() => null);
        if (created) {
            createdRoles++;
            if (r.tempId !== undefined) newRoleIdByTempId.set(r.tempId, created.id);
            if (typeof created.setPosition === 'function' && r.position !== undefined) await created.setPosition(r.position).catch(() => {});
        }
    }
    const newCatIdByTempId = new Map();
    const catsSorted = [...(data.categories ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    let createdCategories = 0;
    for (const c of catsSorted) {
        const created = await guild.channels.create({ name: c.name, type: ChannelType.GuildCategory, permissionOverwrites: deserializeOverwrites(c.overwrites, guild, newRoleIdByTempId), reason: 'Restore da backup' }).catch(() => null);
        if (created) {
            createdCategories++;
            if (c.tempId !== undefined) newCatIdByTempId.set(c.tempId, created.id);
            if (typeof created.setPosition === 'function' && c.position !== undefined) await created.setPosition(c.position).catch(() => {});
        }
    }
    const newChannelIdByName = new Map();
    const chSorted = [...(data.channels ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    let createdChannels = 0;
    for (const c of chSorted) {
        const parentId = (c.parentTempId !== null && c.parentTempId !== undefined) ? newCatIdByTempId.get(c.parentTempId) : undefined;
        const channelData = { name: c.name, type: c.type, parent: parentId, topic: c.topic ?? undefined, nsfw: c.nsfw ?? undefined, bitrate: c.bitrate ?? undefined, userLimit: c.userLimit ?? undefined, rateLimitPerUser: c.rateLimitPerUser ?? undefined, permissionOverwrites: deserializeOverwrites(c.overwrites, guild, newRoleIdByTempId), reason: 'Restore da backup' };
        if (c.type === ChannelType.GuildForum && c.availableTags && c.availableTags.length > 0) channelData.availableTags = c.availableTags;
        const created = await guild.channels.create(channelData).catch(() => null);
        if (created) {
            createdChannels++;
            newChannelIdByName.set(c.name, created.id);
            if (typeof created.setPosition === 'function' && c.position !== undefined) await created.setPosition(c.position).catch(() => {});
        }
    }
    let createdThreads = 0;
    for (const t of data.threads ?? []) {
        const parentId = t.parentName ? newChannelIdByName.get(t.parentName) : null;
        const parentChannel = parentId ? guild.channels.cache.get(parentId) : null;
        if (!parentChannel || !parentChannel.threads) continue;
        try {
            await parentChannel.threads.create({ name: t.name, type: (t.type === ChannelType.PublicThread || t.type === ChannelType.PrivateThread) ? t.type : ChannelType.PublicThread, autoArchiveDuration: t.autoArchiveDuration || 1440, reason: 'Restore da backup' });
            createdThreads++;
        } catch (e) {}
    }
    if (data.settings) {
        const s = {};
        if (data.settings.verificationLevel !== undefined) s.verificationLevel = data.settings.verificationLevel;
        if (data.settings.defaultMessageNotifications !== undefined) s.defaultMessageNotifications = data.settings.defaultMessageNotifications;
        if (data.settings.explicitContentFilter !== undefined) s.explicitContentFilter = data.settings.explicitContentFilter;
        if (data.settings.preferredLocale && data.settings.preferredLocale !== guild.preferredLocale) s.preferredLocale = data.settings.preferredLocale;
        if (Object.keys(s).length > 0) await guild.edit(s).catch(() => {});
    }
    let restoredMembers = 0;
    for (const mr of data.memberRoles ?? []) {
        const member = guild.members.cache.get(mr.userId) ?? await guild.members.fetch(mr.userId).catch(() => null);
        if (!member) continue;
        const roleIdsToAdd = [];
        for (const directId of (mr.directRoleIds ?? [])) if (guild.roles.cache.has(directId)) roleIdsToAdd.push(directId);
        for (const tid of (mr.roleTempIds ?? [])) { const newId = newRoleIdByTempId.get(tid); if (newId) roleIdsToAdd.push(newId); }
        if (!roleIdsToAdd.length) continue;
        const ok = await member.roles.add(roleIdsToAdd, 'Restore da backup').then(() => true).catch(() => false);
        if (ok) restoredMembers++;
    }
    return { createdChannels, createdCategories, createdRoles, restoredMembers, createdThreads };
}

// ================= STATS =================
const STATS_FILE = './stats_channels.json';
function loadStatsData() {
    try { if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8')); } catch (e) { Logger.error('Stats', e.message); }
    return {};
}
function saveStatsData(data) {
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2)); } catch (e) { Logger.error('Stats', e.message); }
}
const statsRuntime = new Map();
function getStatsRuntime(guildId) {
    if (!statsRuntime.has(guildId)) statsRuntime.set(guildId, { lastUpdate: 0, pendingTimeout: null, updating: false, dirty: false });
    return statsRuntime.get(guildId);
}
function computeStats(guild) {
    const members = guild.members.cache;
    const bots = members.filter(m => m.user.bot).size;
    const membri = members.filter(m => !m.user.bot && m.roles.cache.has(CONFIG.memberRoleId)).size;
    const staff = members.filter(m => !m.user.bot && Object.values(CONFIG.staffRoleIds).some(id => id && id !== "0" && m.roles.cache.has(id))).size;
    return { membri, bots, staff, all: guild.memberCount };
}
async function ensureStatsChannels(guild) {
    const data = loadStatsData();
    const entry = data[guild.id] || { categoryId: null, channelIds: {} };
    let category = entry.categoryId ? guild.channels.cache.get(entry.categoryId) : null;
    if (!category && entry.categoryId) category = await guild.channels.fetch(entry.categoryId).catch(() => null);
    if (!category) {
        category = await guild.channels.create({ name: CONFIG.statsCategoryName, type: ChannelType.GuildCategory, permissionOverwrites: [{ id: guild.roles.everyone, deny: [PermissionFlagsBits.Connect] }] }).catch(() => null);
        if (!category) return null;
        entry.categoryId = category.id;
    }
    entry.channelIds = entry.channelIds || {};
    let changed = !data[guild.id];
    for (const key of Object.keys(CONFIG.statsChannels)) {
        let ch = entry.channelIds[key] ? guild.channels.cache.get(entry.channelIds[key]) : null;
        if (!ch && entry.channelIds[key]) ch = await guild.channels.fetch(entry.channelIds[key]).catch(() => null);
        if (!ch) {
            const { label, emoji } = CONFIG.statsChannels[key];
            ch = await guild.channels.create({ name: `${emoji} ${label}: 0`, type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: [{ id: guild.roles.everyone, deny: [PermissionFlagsBits.Connect] }] }).catch(() => null);
            if (ch) { entry.channelIds[key] = ch.id; changed = true; }
        }
    }
    if (changed) { data[guild.id] = entry; saveStatsData(data); }
    return entry;
}
async function performStatsUpdate(guild) {
    if (!CONFIG.statsEnabled) return;
    const runtime = getStatsRuntime(guild.id);
    if (runtime.updating) { runtime.dirty = true; return; }
    runtime.updating = true;
    try {
        if (guild.members.cache.size < guild.memberCount) await guild.members.fetch().catch(() => {});
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
            if (ch.name !== newName) await ch.setName(newName, 'Stats update').catch(() => {});
        }
        runtime.lastUpdate = Date.now();
    } catch (e) { Logger.error('Stats', e.message); }
    finally {
        runtime.updating = false;
        if (runtime.dirty) { runtime.dirty = false; scheduleStatsUpdate(guild); }
    }
}
function scheduleStatsUpdate(guild) {
    if (!CONFIG.statsEnabled || !guild) return;
    const runtime = getStatsRuntime(guild.id);
    const now = Date.now();
    const elapsed = now - runtime.lastUpdate;
    if (elapsed >= CONFIG.statsMinGapMs) { performStatsUpdate(guild).catch(() => {}); return; }
    if (!runtime.pendingTimeout) {
        const wait = CONFIG.statsMinGapMs - elapsed;
        runtime.pendingTimeout = setTimeout(() => { runtime.pendingTimeout = null; performStatsUpdate(guild).catch(() => {}); }, wait);
    }
}

// ================= TICKET =================
const TICKET_FILE = './ticket_data.json';
function loadTicketData() {
    try { if (fs.existsSync(TICKET_FILE)) return JSON.parse(fs.readFileSync(TICKET_FILE, 'utf-8')); } catch (e) { Logger.error('Ticket', e.message); }
    return { panels: {}, tickets: {} };
}
function saveTicketData(data) {
    try { fs.writeFileSync(TICKET_FILE, JSON.stringify(data, null, 2)); } catch (e) { Logger.error('Ticket', e.message); }
}
function buildTicketPanelEmbed() {
    const embed = new EmbedBuilder().setTitle('🎫 Assistenza').setDescription('Hai bisogno di aiuto? Clicca il pulsante qui sotto per aprire un ticket privato con lo staff.\n\nRiceverai un canale dedicato.').setColor('#2ecc71').setTimestamp();
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_open').setLabel('Apri Ticket').setEmoji('🎫').setStyle(ButtonStyle.Success));
    return { embeds: [embed], components: [row] };
}
function buildTicketReasonEmbed(member) {
    const embed = new EmbedBuilder().setTitle('🎫 Nuovo Ticket').setDescription(`Ciao ${member}, grazie per averci contattato!\n\nSeleziona il motivo della richiesta.`).setColor('#5865F2').setTimestamp();
    const row = new ActionRowBuilder().addComponents(
        Object.entries(CONFIG.ticketReasonRoles).map(([key, cfg]) =>
            new ButtonBuilder().setCustomId(`ticket_reason_${key}`).setLabel(cfg.label).setEmoji(cfg.emoji).setStyle(ButtonStyle.Primary)
        )
    );
    return { embeds: [embed], components: [row] };
}
function buildTicketCloseRow(disabled = false) {
    return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_close').setLabel('Chiudi Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger).setDisabled(disabled));
}
async function ensureTicketPanel(guild) {
    if (!CONFIG.ticketEnabled) return null;
    const data = loadTicketData();
    const panelEntry = data.panels[guild.id] || {};
    let category = panelEntry.categoryId ? guild.channels.cache.get(panelEntry.categoryId) : null;
    if (!category && panelEntry.categoryId) category = await guild.channels.fetch(panelEntry.categoryId).catch(() => null);
    if (!category) {
        category = await guild.channels.create({ name: CONFIG.ticketCategoryName, type: ChannelType.GuildCategory }).catch(() => null);
        if (!category) return null;
        panelEntry.categoryId = category.id;
    }
    let panelChannel = panelEntry.panelChannelId ? guild.channels.cache.get(panelEntry.panelChannelId) : null;
    if (!panelChannel && panelEntry.panelChannelId) panelChannel = await guild.channels.fetch(panelEntry.panelChannelId).catch(() => null);
    if (!panelChannel) {
        panelChannel = await guild.channels.create({
            name: CONFIG.ticketPanelChannelName, type: ChannelType.GuildText, parent: category.id,
            permissionOverwrites: [{ id: guild.roles.everyone, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] }]
        }).catch(() => null);
        if (!panelChannel) return null;
        panelEntry.panelChannelId = panelChannel.id;
        panelEntry.panelMessageId = null;
    }
    let panelMessage = panelEntry.panelMessageId ? await panelChannel.messages.fetch(panelEntry.panelMessageId).catch(() => null) : null;
    if (!panelMessage) {
        panelMessage = await panelChannel.send(buildTicketPanelEmbed()).catch(() => null);
        if (panelMessage) panelEntry.panelMessageId = panelMessage.id;
    }
    data.panels[guild.id] = panelEntry;
    saveTicketData(data);
    return panelEntry;
}
function findOpenTicket(data, guildId, userId) {
    for (const [channelId, t] of Object.entries(data.tickets)) {
        if (t.guildId === guildId && t.userId === userId && t.status === 'open') return { channelId, ticket: t };
    }
    return null;
}
async function handleTicketOpen(interaction) {
    const guild = interaction.guild;
    const data = loadTicketData();
    const existing = findOpenTicket(data, guild.id, interaction.user.id);
    if (existing) {
        const ch = guild.channels.cache.get(existing.channelId);
        return interaction.reply({ content: ch ? `⚠️ Hai già un ticket aperto: ${ch}` : '⚠️ Ticket già aperto.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const panelEntry = data.panels[guild.id];
    const categoryId = panelEntry?.categoryId;
    const staffRoleIds = Object.values(CONFIG.staffRoleIds || {}).filter(id => id && id !== "0");
    const reasonRoleIds = Object.values(CONFIG.ticketReasonRoles || {}).map(r => r.roleId).filter(Boolean);
    const allowedRoleIds = [...new Set([...staffRoleIds, ...reasonRoleIds])];
    const overwrites = [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
    ];
    for (const rid of allowedRoleIds) overwrites.push({ id: rid, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'utente';
    let ticketChannel;
    try {
        ticketChannel = await guild.channels.create({ name: `ticket-${safeName}`, type: ChannelType.GuildText, parent: categoryId || undefined, permissionOverwrites: overwrites, topic: `Ticket di ${interaction.user.tag}` });
    } catch (e) { return interaction.editReply('❌ Errore creazione ticket.'); }
    data.tickets[ticketChannel.id] = { guildId: guild.id, userId: interaction.user.id, reason: null, status: 'open', createdAt: Date.now() };
    saveTicketData(data);
    await ticketChannel.send({ content: `${interaction.member}`, ...buildTicketReasonEmbed(interaction.member) }).catch(() => {});
    await interaction.editReply(`✅ Ticket creato: ${ticketChannel}`);
}
async function handleTicketReason(interaction, reasonKey) {
    const guild = interaction.guild;
    const data = loadTicketData();
    const ticket = data.tickets[interaction.channel.id];
    if (!ticket || ticket.guildId !== guild.id) return interaction.reply({ content: '❌ Ticket non valido.', ephemeral: true });
    if (ticket.userId !== interaction.user.id) return interaction.reply({ content: '❌ Solo chi ha aperto il ticket può selezionare.', ephemeral: true });
    if (ticket.reason) return interaction.reply({ content: `⚠️ Motivo già selezionato.`, ephemeral: true });
    const reasonCfg = CONFIG.ticketReasonRoles[reasonKey];
    if (!reasonCfg) return interaction.reply({ content: '❌ Motivo non riconosciuto.', ephemeral: true });
    ticket.reason = reasonKey;
    data.tickets[interaction.channel.id] = ticket;
    saveTicketData(data);
    const disabledRow = new ActionRowBuilder().addComponents(
        Object.entries(CONFIG.ticketReasonRoles).map(([key, cfg]) =>
            new ButtonBuilder().setCustomId(`ticket_reason_${key}`).setLabel(cfg.label).setEmoji(cfg.emoji).setStyle(key === reasonKey ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(true)
        )
    );
    await interaction.update({ components: [disabledRow] }).catch(() => {});
    await interaction.channel.send({ content: `<@&${reasonCfg.roleId}>`, embeds: [new EmbedBuilder().setTitle(`${reasonCfg.emoji} ${reasonCfg.label}`).setDescription(`${interaction.user} ha selezionato **${reasonCfg.label}**.`).setColor('#f1c40f').setTimestamp()], components: [buildTicketCloseRow()] }).catch(() => {});
}
async function handleTicketClose(interaction) {
    const data = loadTicketData();
    const ticket = data.tickets[interaction.channel.id];
    if (!ticket) return interaction.reply({ content: '❌ Ticket non valido.', ephemeral: true });
    const staffRoleIds = Object.values(CONFIG.staffRoleIds || {}).filter(id => id && id !== "0");
    const member = interaction.member;
    const isStaff = (member && member.roles.cache.some(r => staffRoleIds.includes(r.id))) || isImmune(member);
    const isOwnerOfTicket = ticket.userId === interaction.user.id;
    if (!isStaff && !isOwnerOfTicket) return interaction.reply({ content: '❌ Non puoi chiudere questo ticket.', ephemeral: true });
    await interaction.reply({ content: '🔒 Chiusura ticket in corso…' });
    ticket.status = 'closed';
    ticket.closedAt = Date.now();
    ticket.closedBy = interaction.user.id;
    data.tickets[interaction.channel.id] = ticket;
    saveTicketData(data);
    await broadcastLog(interaction.guild, '🔒 Ticket Chiuso', `Ticket <#${interaction.channel.id}> chiuso da **${interaction.user.tag}**.`, '#95a5a6').catch(() => {});
    await delay(5000);
    await interaction.channel.delete('Ticket chiuso').catch(() => {});
    const freshData = loadTicketData();
    delete freshData.tickets[interaction.channel.id];
    saveTicketData(freshData);
}

// ================= ANTI-NUKE =================
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
    if ('name' in entry.target && entry.target.name) return entry.action >= AuditLogEvent.RoleCreate && entry.action <= AuditLogEvent.RoleDelete ? `@${entry.target.name}` : `#${entry.target.name}`;
    if ('tag' in entry.target && entry.target.tag) return entry.target.tag;
    return String(entry.targetId ?? entry.target.id ?? 'sconosciuto');
}
function loadLastBackupForGuild(guildId) {
    try {
        const p = getBackupPath(guildId);
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) { return null; }
}
function findOriginalPosition(backup, itemName, itemType) {
    if (!backup) return null;
    if (itemType !== null && itemType !== undefined) {
        const ch = (backup.channels ?? []).find(c => c.name === itemName && c.type === itemType);
        if (ch && ch.position !== undefined) return ch.position;
    }
    const cat = (backup.categories ?? []).find(c => c.name === itemName);
    if (cat && cat.position !== undefined) return cat.position;
    const role = (backup.roles ?? []).find(r => r.name === itemName);
    if (role && role.position !== undefined) return role.position;
    return null;
}
async function restoreChannelPosition(guild, channel) {
    if (!channel || channel.isThread?.()) return;
    const backup = loadLastBackupForGuild(guild.id);
    if (!backup) return;
    const originalPos = findOriginalPosition(backup, channel.name, channel.type);
    if (originalPos === null || originalPos === undefined) return;
    try { if (typeof channel.setPosition === 'function') await channel.setPosition(originalPos); } catch (e) {}
}
async function restoreRolePosition(guild, role) {
    if (!role) return;
    const backup = loadLastBackupForGuild(guild.id);
    if (!backup) return;
    const originalPos = findOriginalPosition(backup, role.name, null);
    if (originalPos === null || originalPos === undefined) return;
    try { if (typeof role.setPosition === 'function') await role.setPosition(originalPos); } catch (e) {}
}
async function restoreChannelParent(guild, channel) {
    if (!channel || channel.isThread?.()) return;
    const backup = loadLastBackupForGuild(guild.id);
    if (!backup) return;
    const chData = (backup.channels ?? []).find(c => c.name === channel.name && c.type === channel.type);
    if (!chData || chData.parentTempId === null || chData.parentTempId === undefined) return;
    const originalCategory = (backup.categories ?? [])[chData.parentTempId];
    if (!originalCategory) return;
    const currentCat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === originalCategory.name);
    if (!currentCat) return;
    try { await channel.setParent(currentCat.id); } catch (e) {}
}
function extractOldChanges(entry) {
    const changes = {};
    for (const c of entry.changes ?? []) changes[c.key] = c.old;
    return changes;
}
async function repairChannelDelete(guild, entry) {
    const changes = extractOldChanges(entry);
    try {
        return await guild.channels.create({
            name: changes.name || `canale-ripristinato-${Date.now()}`,
            type: changes.type ?? ChannelType.GuildText,
            topic: changes.topic ?? undefined, nsfw: changes.nsfw ?? undefined,
            bitrate: changes.bitrate ?? undefined, userLimit: changes.user_limit ?? undefined,
            rateLimitPerUser: changes.rate_limit_per_user ?? undefined,
            reason: 'Anti-Nuke: ripristino'
        });
    } catch (e) { return null; }
}
async function repairChannelCreate(guild, entry) {
    try {
        const ch = await guild.channels.fetch(entry.targetId).catch(() => null);
        if (ch) { await ch.delete('Anti-Nuke: rollback creazione'); return true; }
        return false;
    } catch (e) { return false; }
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
        await channel.edit({ ...updateData, reason: 'Anti-Nuke: rollback modifica' });
        return true;
    } catch (e) { return false; }
}
async function repairRoleDelete(guild, entry) {
    const changes = extractOldChanges(entry);
    try {
        return await guild.roles.create({
            name: changes.name || `ruolo-ripristinato-${Date.now()}`,
            color: changes.color ?? undefined, hoist: changes.hoist ?? undefined,
            mentionable: changes.mentionable ?? undefined,
            permissions: changes.permissions !== undefined ? BigInt(changes.permissions) : undefined,
            reason: 'Anti-Nuke: ripristino'
        });
    } catch (e) { return null; }
}
async function repairRoleCreate(guild, entry) {
    try {
        const role = guild.roles.cache.get(entry.targetId) ?? await guild.roles.fetch(entry.targetId).catch(() => null);
        if (role) { await role.delete('Anti-Nuke: rollback creazione'); return true; }
        return false;
    } catch (e) { return false; }
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
        await role.edit({ ...updateData, reason: 'Anti-Nuke: rollback modifica' });
        return true;
    } catch (e) { return false; }
}
async function repairBan(guild, entry) {
    try { await guild.members.unban(entry.targetId, 'Anti-Nuke: rollback ban'); return true; } catch (e) { return false; }
}
async function repairChannelDeleteWithPosition(guild, entry) {
    const created = await repairChannelDelete(guild, entry);
    if (!created) return null;
    await delay(500);
    await restoreChannelPosition(guild, created);
    await restoreChannelParent(guild, created);
    return created;
}
async function repairRoleDeleteWithPosition(guild, entry) {
    const created = await repairRoleDelete(guild, entry);
    if (!created) return null;
    await delay(500);
    await restoreRolePosition(guild, created);
    return created;
}
async function autoRepairAttempt(guild, entry) {
    try {
        switch (entry.action) {
            case AuditLogEvent.ChannelDelete: { const c = await repairChannelDeleteWithPosition(guild, entry); return c ? { success: true, message: `✅ #${c.name} ricreato.` } : { success: false, message: '❌ Errore.' }; }
            case AuditLogEvent.ChannelCreate: { const ok = await repairChannelCreate(guild, entry); return { success: ok, message: ok ? '✅ Canale rollback.' : '⚠️ Non trovato.' }; }
            case AuditLogEvent.ChannelUpdate: { const ok = await repairChannelUpdate(guild, entry); return { success: true, message: ok ? '✅ Modifiche annullate.' : '⚠️ Niente.' }; }
            case AuditLogEvent.RoleDelete: { const c = await repairRoleDeleteWithPosition(guild, entry); return c ? { success: true, message: `✅ @${c.name} ricreato.` } : { success: false, message: '❌ Errore.' }; }
            case AuditLogEvent.RoleCreate: { const ok = await repairRoleCreate(guild, entry); return { success: ok, message: ok ? '✅ Ruolo rollback.' : '⚠️ Non trovato.' }; }
            case AuditLogEvent.RoleUpdate: { const ok = await repairRoleUpdate(guild, entry); return { success: true, message: ok ? '✅ Modifiche annullate.' : '⚠️ Niente.' }; }
            case AuditLogEvent.MemberBanAdd: { const ok = await repairBan(guild, entry); return { success: ok, message: ok ? '✅ Ban rimosso.' : '❌ Errore.' }; }
            case AuditLogEvent.MemberKick: { return { success: true, message: '⚠️ Kick non annullabile.' }; }
            default: return { success: true, message: null };
        }
    } catch (e) { return { success: false, message: `Errore: ${e.message}` }; }
}

const NUKE_INCIDENT_REPORT_DELAY_MS = 3000;
const nukeIncidents = new Map();
function getOrCreateNukeIncident(guild, executor) {
    const key = `${guild.id}:${executor.id}`;
    let incident = nukeIncidents.get(key);
    if (incident) return incident;
    incident = { key, guild, executorTag: executor.tag, executorId: executor.id, actions: [], punishStatus: null, reportTimer: null, totalJobs: 0, completedJobs: 0, repairSuccess: 0, repairFailed: 0, reportSent: false, repairSummarySent: false };
    nukeIncidents.set(key, incident);
    return incident;
}
async function punishIncident(incident, execMember) {
    if (incident.punishStatus) return;
    if (!execMember) { incident.punishStatus = '⚠️ Membro non trovato.'; return; }
    if (execMember.communicationDisabledUntilTimestamp && execMember.communicationDisabledUntilTimestamp > Date.now()) { incident.punishStatus = '✅ Già in timeout.'; return; }
    if (!execMember.moderatable) { incident.punishStatus = '❌ Ruolo bot troppo basso.'; return; }
    await execMember.timeout(CONFIG.timeoutUnOra, 'Anti-Nuke: azioni multiple non autorizzate').catch(e => Logger.error('punishIncident', e.message));
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
    nukeIncidents.delete(key);
    const counts = {};
    for (const a of incident.actions) counts[a.reason] = (counts[a.reason] || 0) + 1;
    const detailText = Object.entries(counts).map(([r, c]) => `${r} × ${c}`).join('\n') || 'N/A';
    const embed = new EmbedBuilder()
        .setTitle('⚠️ ANTI-NUKE ATTIVATO ⚠️')
        .setColor(0xFF0000)
        .addFields(
            { name: 'Utente Punito', value: `${incident.executorTag} (\`${incident.executorId}\`)`, inline: true },
            { name: 'Azioni', value: `${incident.actions.length}`, inline: true },
            { name: 'Punizione', value: incident.punishStatus || 'N/A' },
            { name: 'Dettaglio', value: detailText },
            { name: '🔧 Riparazione', value: `⏳ Accodata (${incident.totalJobs})` }
        ).setTimestamp();
    sendLog(incident.guild, embed).catch(() => {});
    maybeSendRepairSummary(incident);
}
function maybeSendRepairSummary(incident) {
    if (!incident.reportSent) return;
    if (incident.completedJobs < incident.totalJobs) return;
    if (incident.repairSummarySent) return;
    incident.repairSummarySent = true;
    const embed = new EmbedBuilder()
        .setTitle('🔧 Riparazione — Riepilogo')
        .setColor(incident.repairFailed > 0 ? 0xe67e22 : 0x2ecc71)
        .setDescription(`Riparazione completata per **${incident.executorTag}**.\n✅ Riusciti: **${incident.repairSuccess}**\n${incident.repairFailed > 0 ? `❌ Falliti: **${incident.repairFailed}**` : ''}`)
        .setTimestamp();
    sendLog(incident.guild, embed).catch(() => {});
}

const REPAIR_MAX_ATTEMPTS = 15;
const REPAIR_BASE_DELAY_MS = 300;
const REPAIR_MAX_DELAY_MS = 8000;
const REPAIR_CONCURRENCY = 5;
const repairQueues = new Map();
const repairRunning = new Map();
function enqueueRepair(guild, entry, incident = null) {
    if (!guild || !entry) return;
    if (!repairQueues.has(guild.id)) repairQueues.set(guild.id, []);
    repairQueues.get(guild.id).push({ entry, attempts: 0, incident });
    runRepairQueue(guild).catch(e => Logger.error('RepairQueue', e.message));
}
async function repairWorker(guild, queue) {
    while (queue.length > 0) {
        const job = queue.shift();
        if (!job) return;
        const result = await autoRepairAttempt(guild, job.entry);
        if (result.success) {
            if (job.incident) { job.incident.repairSuccess++; job.incident.completedJobs++; maybeSendRepairSummary(job.incident); }
            continue;
        }
        job.attempts++;
        if (job.attempts < REPAIR_MAX_ATTEMPTS) {
            const wait = Math.min(REPAIR_BASE_DELAY_MS * Math.pow(2, job.attempts - 1), REPAIR_MAX_DELAY_MS);
            await delay(wait);
            queue.push(job);
        } else {
            if (job.incident) { job.incident.repairFailed++; job.incident.completedJobs++; maybeSendRepairSummary(job.incident); }
        }
    }
}
async function runRepairQueue(guild) {
    if (repairRunning.get(guild.id)) return;
    repairRunning.set(guild.id, true);
    try {
        const queue = repairQueues.get(guild.id);
        if (!queue) return;
        const workers = Array.from({ length: REPAIR_CONCURRENCY }, () => repairWorker(guild, queue));
        await Promise.all(workers);
    } finally {
        repairRunning.set(guild.id, false);
        const queue = repairQueues.get(guild.id);
        if (queue && queue.length > 0) runRepairQueue(guild).catch(() => {});
    }
}

async function gestisciAzione(guild, entry) {
    if (!guild || !entry || !entry.executor) return;
    const executor = entry.executor;
    const botId = client.user?.id;
    if (botId && executor.id === botId) return;
    const reason = AUDIT_ACTION_REASONS.get(entry.action) || 'Azione sensibile';
    const targetInfo = formatAuditTargetInfo(entry);
    let execMember = guild.members.cache.get(executor.id) ?? null;
    if (!execMember) execMember = await guild.members.fetch(executor.id).catch(() => null);
    if (executor.id === CONFIG.ownerId || CONFIG.whitelistedIds.includes(executor.id) || (execMember && isImmune(execMember))) {
        sendLog(guild, new EmbedBuilder().setTitle("👑 AZIONE AUTORIZZATA").setColor(0x00FF00).setDescription("Azione da account protetto.").addFields({ name: "Autore", value: `${executor.tag}`, inline: true }, { name: "Azione", value: reason, inline: true }).setTimestamp()).catch(() => {});
        return;
    }
    const permRimasti = getPermessi(executor.id);
    if (permRimasti > 0) {
        setPermessi(executor.id, permRimasti - 1);
        sendLog(guild, new EmbedBuilder().setTitle("🛡️ AZIONE AUTORIZZATA (STAFF)").setColor(0x00AFFF).addFields({ name: "Autore", value: `${executor.tag}`, inline: true }, { name: "Azione", value: reason, inline: true }, { name: "Permessi Rimasti", value: `${permRimasti - 1}` }).setTimestamp()).catch(() => {});
        return;
    }
    try {
        const incident = getOrCreateNukeIncident(guild, executor);
        incident.actions.push({ reason, targetInfo });
        await punishIncident(incident, execMember);
        incident.totalJobs++;
        enqueueRepair(guild, entry, incident);
        scheduleNukeIncidentReport(incident);
    } catch (e) { Logger.error('gestisciAzione', e.message); }
}

// ================= EVENTI MESSAGGI =================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot || !message.member) return;
    if (message.content.startsWith('!')) {
        const args = message.content.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        if (command === 'concedi' || command === 'allow') {
            if (message.author.id !== CONFIG.ownerId) return message.reply('❌ Solo il founder.');
            const target = message.mentions.members.first();
            const amount = parseInt(args[1]);
            if (!target || isNaN(amount) || amount <= 0) return message.reply('⚠️ Uso: `!concedi @utente <numero>`');
            const curr = getPermessi(target.id);
            setPermessi(target.id, curr + amount);
            return message.reply(`✅ **${amount}** permessi a ${target.user.tag}. Totale: **${curr + amount}**.`);
        }
        if (command === 'toglipermessi') {
            if (message.author.id !== CONFIG.ownerId) return message.reply('❌ Solo il founder.');
            const target = message.mentions.members.first();
            const amount = parseInt(args[1]);
            if (!target || isNaN(amount) || amount <= 0) return message.reply('⚠️ Uso: `!toglipermessi @utente <numero>`');
            const curr = getPermessi(target.id);
            const newVal = Math.max(0, curr - amount);
            setPermessi(target.id, newVal);
            return message.reply(`✅ **${amount}** permessi rimossi a ${target.user.tag}. Rimasti: **${newVal}**.`);
        }
        if (command === 'lock') {
            if (message.author.id !== CONFIG.ownerId) return message.reply('❌ Solo il founder.');
            if (lockdownActive) return message.reply('⚠️ Già attivo.');
            await activateLockdown(message.guild, args.join(' ') || 'Lockdown manuale');
            return message.reply('🔒 Lockdown attivato.');
        }
        if (command === 'unlock') {
            if (message.author.id !== CONFIG.ownerId) return message.reply('❌ Solo il founder.');
            if (!lockdownActive) return message.reply('⚠️ Non attivo.');
            await deactivateLockdown(message.guild, 'Sblocco manuale');
            return message.reply('🔓 Lockdown rimosso.');
        }
    }
    // anti-ghost-ping: se il messaggio pinga qualcuno, salva lo stato. se viene cancellato, logga
    if (CONFIG.antiGhostPingEnabled && (message.mentions.users.size > 0 || message.mentions.roles.size > 0 || message.mentions.everyone)) {
        const targets = [];
        if (message.mentions.everyone) targets.push('everyone');
        message.mentions.users.forEach(u => { if (u.id !== message.author.id) targets.push(u.id); });
        message.mentions.roles.forEach(r => targets.push(r.id));
        for (const t of targets) antiViolation.pingTracker.addGhostPing(message.id, message.author.id, message.channelId, t);
    }
    const immunity = antiViolation.isImmune(message.member, CONFIG.ownerId, CONFIG.whitelistedIds, CONFIG.immuneRoleId);
    if (message.channelId === CONFIG.verifyChannelId && !immunity) return message.delete().catch(() => {});
    if (antiViolation.isFreeChannel(message.channelId, CONFIG.aiFreeChannels)) return;
    const inviteRegex = /(https?:\/\/)?(www\.)?(discord\.(gg|io|me|li)|discordapp\.com\/invite)\/.+/i;
    if (inviteRegex.test(message.content)) {
        if (immunity === 'OWNER') return sendOwnerAlert(message.channel, message.author);
        if (immunity) return;
        if (message.deletable) await message.delete().catch(() => {});
        await broadcastLog(message.guild, '⚠️ Anti-Link', `${message.author.tag} in <#${message.channelId}> ha inviato un invite link → eliminato.`, '#f39c12');
        return;
    }
    const totalPings = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);
    if (totalPings > 0) {
        if (immunity === 'OWNER' && totalPings >= CONFIG.textPingLimit) return sendOwnerAlert(message.channel, message.author);
        if (!immunity) {
            const targets = antiViolation.extractPingTargets(message);
            const sanctioned = await antiViolation.handlePing(message, targets, totalPings, broadcastLog);
            if (sanctioned) return;
        }
    }
    if (!immunity) {
        const wasSpam = await antiViolation.handleSpam(message, broadcastLog);
        if (wasSpam) return;
    }
    if (!immunity && !message.member.roles.cache.has(CONFIG.memberRoleId)) return message.delete().catch(() => {});
});

// ================= LOG MESSAGGI (edit/delete) =================
client.on('messageDelete', async (message) => {
    if (!message.guild || !message.author) return;
    if (message.author.bot) return;
    // anti-ghost-ping
    if (CONFIG.antiGhostPingEnabled && message.mentions) {
        const targets = [];
        if (message.mentions.everyone) targets.push('everyone');
        message.mentions.users.forEach(u => { if (u.id !== message.author.id) targets.push(u.id); });
        message.mentions.roles.forEach(r => targets.push(r.id));
        for (const t of targets) {
            const ghost = antiViolation.pingTracker.consumeGhostPing(message.author.id, message.channelId, t);
            if (ghost) {
                const targetLabel = t === 'everyone' ? '@everyone' : (message.guild.roles.cache.get(t)?.name ? `@${message.guild.roles.cache.get(t).name}` : `<@${t}>`);
                await broadcastLog(message.guild, '👻 Ghost Ping', `**${message.author.tag}** ha cancellato un messaggio che pingava ${targetLabel} in <#${message.channelId}>.`, '#9b59b6', message.author.id).catch(() => {});
            }
        }
    }
    if (!CONFIG.messageLogChannelId || CONFIG.messageLogChannelId === "0") return;
    const content = message.content ? message.content.slice(0, 1000) : '(nessun contenuto)';
    const embed = new EmbedBuilder()
        .setTitle('🗑️ Messaggio Eliminato')
        .setColor('#e74c3c')
        .addFields(
            { name: 'Autore', value: `${message.author.tag} (\`${message.author.id}\`)`, inline: true },
            { name: 'Canale', value: `<#${message.channelId}>`, inline: true },
            { name: 'Contenuto', value: content || '(vuoto)' }
        )
        .setTimestamp();
    if (message.attachments.size > 0) embed.addFields({ name: 'Allegati', value: `${message.attachments.size}` });
    sendLog(message.guild, embed, CONFIG.messageLogChannelId).catch(() => {});
});
client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (!newMessage.guild || !newMessage.author) return;
    if (newMessage.author.bot) return;
    if (oldMessage.content === newMessage.content) return;
    if (!CONFIG.messageLogChannelId || CONFIG.messageLogChannelId === "0") return;
    const oldContent = oldMessage.content ? oldMessage.content.slice(0, 500) : '(vuoto)';
    const newContent = newMessage.content ? newMessage.content.slice(0, 500) : '(vuoto)';
    const embed = new EmbedBuilder()
        .setTitle('✏️ Messaggio Modificato')
        .setColor('#f39c12')
        .addFields(
            { name: 'Autore', value: `${newMessage.author.tag} (\`${newMessage.author.id}\`)`, inline: true },
            { name: 'Canale', value: `<#${newMessage.channelId}>`, inline: true },
            { name: 'Prima', value: oldContent || '(vuoto)' },
            { name: 'Dopo', value: newContent || '(vuoto)' },
            { name: 'Link', value: `[Vai al messaggio](${newMessage.url})` }
        )
        .setTimestamp();
    sendLog(newMessage.guild, embed, CONFIG.messageLogChannelId).catch(() => {});
});

// ================= EVENTI MEMBRI =================
client.on('guildMemberAdd', async (member) => {
    try {
        scheduleStatsUpdate(member.guild);
        if (lockdownActive || raidModeActive) {
            if (member.kickable) await member.kick('Lockdown attivo.').catch(() => {});
            return;
        }
        const raidReasons = await antiViolation.handleRaidJoin(member);
        if (raidReasons && raidReasons.length > 0) {
            await Promise.all([
                member.kickable ? member.kick('Raid rilevato.').catch(() => {}) : Promise.resolve(),
                activateLockdown(member.guild, `Raid: ${raidReasons.join(' | ')}`)
            ]);
            return;
        }
        if (member.user.bot) {
            try {
                if (CONFIG.antiEveryoneFromBots && member.moderatable) await member.timeout(CONFIG.suspiciousBotTimeoutMs, 'Bot sospetto — timeout 7 giorni').catch(() => {});
                await sendSuspiciousBotLog(member.guild, member).catch(() => {});
            } catch (e) { Logger.error('SuspiciousBot', e.message); }
            return;
        }
        const role = member.guild.roles.cache.get(CONFIG.memberRoleId);
        if (role) await member.roles.add(role).catch(() => {});
        const welcomeChannel = member.guild.channels.cache.get(CONFIG.welcomeChannelId) || await member.guild.channels.fetch(CONFIG.welcomeChannelId).catch(() => null);
        if (!welcomeChannel || !welcomeChannel.isTextBased()) return;
        const memberNumber = getMemberNumber(member.id, member.guild);
        function formatDateIT(date) {
            const days = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
            const months = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
            const d = new Date(date);
            const dayName = days[d.getDay()], day = d.getDate(), month = months[d.getMonth()], year = d.getFullYear();
            const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
            const diffMs = Date.now() - d.getTime();
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const diffMonths = Math.floor(diffDays / 30), diffYears = Math.floor(diffDays / 365);
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
                { name: '🏠 Server Creato il', value: `${guildCreated.formatted} (${guildCreated.ago})`, inline: false },
                { name: '📅 Account Creato il', value: `${accountCreated.formatted} (${accountCreated.ago})`, inline: false },
                { name: '👥 Numero Membro', value: `Sei il membro numero **#${memberNumber}**`, inline: false },
                { name: '📜 Regolamento', value: `Leggi il regolamento in <#${CONFIG.verifyChannelId}>.` , inline: false }
            )
            .setFooter({ text: member.guild.name })
            .setTimestamp();
        await welcomeChannel.send({ embeds: [welcomeEmbed] }).catch(() => {});
    } catch (e) { Logger.error('guildMemberAdd', e.message); }
});
// NOTA: leave message rimosso. Il kick viene loggato via audit log separatamente.

// ================= LOG MEMBRI (nickname/ruoli) =================
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
        if (!oldMember.roles.cache.equals(newMember.roles.cache)) scheduleStatsUpdate(newMember.guild);
        if (!CONFIG.memberLogChannelId || CONFIG.memberLogChannelId === "0") return;
        const changes = [];
        if (oldMember.nickname !== newMember.nickname) {
            changes.push({ name: '📝 Nickname', value: `**Prima:** ${oldMember.nickname || oldMember.user.username}\n**Dopo:** ${newMember.nickname || newMember.user.username}` });
        }
        if (!oldMember.roles.cache.equals(newMember.roles.cache)) {
            const added = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
            const removed = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id));
            if (added.size > 0) changes.push({ name: '➕ Ruoli aggiunti', value: added.map(r => `<@&${r.id}>`).join(', ') });
            if (removed.size > 0) changes.push({ name: '➖ Ruoli rimossi', value: removed.map(r => `<@&${r.id}>`).join(', ') });
        }
        if (changes.length === 0) return;
        const embed = new EmbedBuilder()
            .setTitle('👤 Membro Aggiornato')
            .setColor('#3498db')
            .setAuthor({ name: newMember.user.tag, iconURL: newMember.user.displayAvatarURL() })
            .addFields(
                { name: 'Utente', value: `${newMember} (\`${newMember.id}\`)`, inline: false },
                ...changes
            )
            .setTimestamp();
        sendLog(newMember.guild, embed, CONFIG.memberLogChannelId).catch(() => {});
    } catch (e) { Logger.error('guildMemberUpdate', e.message); }
});

// ================= LOG VOCALE =================
client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        if (!CONFIG.voiceLogChannelId || CONFIG.voiceLogChannelId === "0") return;
        const member = newState.member || oldState.member;
        if (!member) return;
        let embed = null;
        if (!oldState.channelId && newState.channelId) {
            embed = new EmbedBuilder().setTitle('🔊 Entrato in vocale').setColor('#2ecc71')
                .setDescription(`${member} è entrato in <#${newState.channelId}>`)
                .setTimestamp();
        } else if (oldState.channelId && !newState.channelId) {
            embed = new EmbedBuilder().setTitle('🔇 Uscito da vocale').setColor('#e74c3c')
                .setDescription(`${member} è uscito da <#${oldState.channelId}>`)
                .setTimestamp();
        } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
            embed = new EmbedBuilder().setTitle('🔀 Cambio canale vocale').setColor('#3498db')
                .setDescription(`${member} è passato da <#${oldState.channelId}> a <#${newState.channelId}>`)
                .setTimestamp();
        } else if (oldState.serverMute !== newState.serverMute || oldState.serverDeaf !== newState.serverDeaf) {
            const changes = [];
            if (oldState.serverMute !== newState.serverMute) changes.push(`Server Mute: ${newState.serverMute ? 'ON' : 'OFF'}`);
            if (oldState.serverDeaf !== newState.serverDeaf) changes.push(`Server Deaf: ${newState.serverDeaf ? 'ON' : 'OFF'}`);
            embed = new EmbedBuilder().setTitle('🎙️ Stato vocale modificato').setColor('#f39c12')
                .setDescription(`${member} — ${changes.join(' | ')}`)
                .setTimestamp();
        }
        if (embed) sendLog(newState.guild, embed, CONFIG.voiceLogChannelId).catch(() => {});
    } catch (e) { Logger.error('voiceStateUpdate', e.message); }
});

// ================= LOG CANALI/RUOLI =================
client.on('channelCreate', async (ch) => {
    try {
        if (CONFIG.logChannels.length === 0 && CONFIG.modLogChannelId === "0") return;
        const embed = new EmbedBuilder().setTitle('📢 Canale Creato').setColor('#2ecc71')
            .addFields({ name: 'Nome', value: `${ch.name}`, inline: true }, { name: 'Tipo', value: `${ch.type}`, inline: true })
            .setTimestamp();
        sendLog(ch.guild, embed, CONFIG.modLogChannelId).catch(() => {});
        const log = await fetchAuditLogEntry(ch.guild, AuditLogEvent.ChannelCreate, ch.id);
        if (log?.executor && tryClaimAuditEntry(log.id)) await gestisciAzione(ch.guild, log);
    } catch (e) { Logger.error('channelCreate', e.message); }
});
client.on('channelDelete', async (ch) => {
    try {
        if (CONFIG.modLogChannelId !== "0") {
            const embed = new EmbedBuilder().setTitle('🗑️ Canale Eliminato').setColor('#e74c3c')
                .addFields({ name: 'Nome', value: `${ch.name}`, inline: true })
                .setTimestamp();
            sendLog(ch.guild, embed, CONFIG.modLogChannelId).catch(() => {});
        }
        const log = await fetchAuditLogEntry(ch.guild, AuditLogEvent.ChannelDelete, ch.id);
        if (log?.executor && tryClaimAuditEntry(log.id)) await gestisciAzione(ch.guild, log);
    } catch (e) { Logger.error('channelDelete', e.message); }
});
client.on('channelUpdate', async (_, nCh) => {
    try {
        const log = await fetchAuditLogEntry(nCh.guild, AuditLogEvent.ChannelUpdate, nCh.id);
        if (log?.executor && tryClaimAuditEntry(log.id)) await gestisciAzione(nCh.guild, log);
    } catch (e) { Logger.error('channelUpdate', e.message); }
});
client.on('roleCreate', async (role) => {
    try {
        if (CONFIG.modLogChannelId !== "0") {
            const embed = new EmbedBuilder().setTitle('🎭 Ruolo Creato').setColor('#2ecc71')
                .addFields({ name: 'Nome', value: `@${role.name}`, inline: true })
                .setTimestamp();
            sendLog(role.guild, embed, CONFIG.modLogChannelId).catch(() => {});
        }
        const log = await fetchAuditLogEntry(role.guild, AuditLogEvent.RoleCreate, role.id);
        if (log?.executor && tryClaimAuditEntry(log.id)) await gestisciAzione(role.guild, log);
    } catch (e) { Logger.error('roleCreate', e.message); }
});
client.on('roleDelete', async (role) => {
    try {
        if (CONFIG.modLogChannelId !== "0") {
            const embed = new EmbedBuilder().setTitle('🎭 Ruolo Eliminato').setColor('#e74c3c')
                .addFields({ name: 'Nome', value: `@${role.name}`, inline: true })
                .setTimestamp();
            sendLog(role.guild, embed, CONFIG.modLogChannelId).catch(() => {});
        }
        const log = await fetchAuditLogEntry(role.guild, AuditLogEvent.RoleDelete, role.id);
        if (log?.executor && tryClaimAuditEntry(log.id)) await gestisciAzione(role.guild, log);
    } catch (e) { Logger.error('roleDelete', e.message); }
});
client.on('roleUpdate', async (_, nRole) => {
    try {
        const log = await fetchAuditLogEntry(nRole.guild, AuditLogEvent.RoleUpdate, nRole.id);
        if (log?.executor && tryClaimAuditEntry(log.id)) await gestisciAzione(nRole.guild, log);
    } catch (e) { Logger.error('roleUpdate', e.message); }
});

// ================= AUDIT LOG GENERICO =================
client.on('guildAuditLogEntryCreate', async (entry, guild) => {
    try {
        updateAuditLogHotCache(guild.id, entry);
        const reason = AUDIT_ACTION_REASONS.get(entry.action);
        if (!reason || !entry.executor) return;
        if (!tryClaimAuditEntry(entry.id)) return;
        await gestisciAzione(guild, entry);
    } catch (e) { Logger.error('guildAuditLogEntryCreate', e.message); }
});
client.on('guildBanAdd', async (ban) => {
    try {
        const log = await fetchAuditLogEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
        if (log?.executor && tryClaimAuditEntry(log.id)) await gestisciAzione(ban.guild, log);
    } catch (e) { Logger.error('guildBanAdd', e.message); }
});
client.on('guildMemberRemove', async (member) => {
    try {
        scheduleStatsUpdate(member.guild);
        const log = await fetchAuditLogEntry(member.guild, AuditLogEvent.MemberKick, member.id);
        if (log?.executor && tryClaimAuditEntry(log.id)) await gestisciAzione(member.guild, log);
    } catch (e) { Logger.error('guildMemberRemove', e.message); }
});

// ================= AUTO PUBLISH =================
client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;
    if (message.channel.type !== ChannelType.GuildAnnouncement) return;
    if (!CONFIG.autoPublishChannels.includes(message.channelId)) return;
    try { await message.crosspost(); } catch (e) {}
});

// ================= READY =================
client.once('ready', async () => {
    Logger.info('Ready', `Bot online come ${client.user.tag}`);
    await setupAuditLogListener(client);
    antiViolation.reset();
    if (CONFIG.statsEnabled) {
        for (const guild of client.guilds.cache.values()) {
            try { await ensureStatsChannels(guild); await performStatsUpdate(guild); } catch (e) { Logger.error('Stats', e.message); }
        }
        Logger.info('Stats', 'inizializzati.');
    }
    if (CONFIG.ticketEnabled) {
        for (const guild of client.guilds.cache.values()) {
            try { await ensureTicketPanel(guild); } catch (e) { Logger.error('Ticket', e.message); }
        }
        Logger.info('Ticket', 'pannello inizializzato.');
    }
    startAutoBackup();

    const commands = [
        new SlashCommandBuilder().setName('verify').setDescription('Verificati per sbloccare i canali'),
        new SlashCommandBuilder().setName('regole').setDescription('Mostra il regolamento del server'),
        new SlashCommandBuilder().setName('controlla').setDescription('Cerca una richiesta di whitelist per un utente')
            .addStringOption(o => o.setName('utente').setDescription('Nome utente').setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
        new SlashCommandBuilder().setName('roleall').setDescription('Assegna un ruolo a tutti')
            .addRoleOption(o => o.setName('ruolo').setDescription('Ruolo').setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName('backup_server').setDescription('Forza un backup completo')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName('restore_server').setDescription('Ripristina dal backup')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName('clear').setDescription('Elimina fino a 1000 messaggi')
            .addIntegerOption(o => o.setName('quantita').setDescription('Numero (max 1000)').setMinValue(1).setMaxValue(1000).setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
        new SlashCommandBuilder().setName('kick').setDescription('Espelle un utente')
            .addUserOption(o => o.setName('utente').setDescription('Utente').setRequired(true))
            .addStringOption(o => o.setName('motivo').setDescription('Motivo'))
            .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
        new SlashCommandBuilder().setName('ban').setDescription('Banna un utente')
            .addUserOption(o => o.setName('utente').setDescription('Utente').setRequired(true))
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
            .addStringOption(o => o.setName('id').setDescription('ID utente').setRequired(true))
            .addStringOption(o => o.setName('motivo').setDescription('Motivo'))
            .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
        new SlashCommandBuilder().setName('warn').setDescription('Avvisa un utente (con DM)')
            .addUserOption(o => o.setName('utente').setDescription('Utente').setRequired(true))
            .addStringOption(o => o.setName('motivo').setDescription('Motivo').setRequired(true))
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
        new SlashCommandBuilder().setName('stats_setup').setDescription('Crea/ripara canali Server Stats')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName('stats_refresh').setDescription('Forza aggiornamento stats')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName('ticket_setup').setDescription('Crea/ripara pannello ticket')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        new SlashCommandBuilder().setName('comandi').setDescription('Lista comandi (solo founder)'),
        new SlashCommandBuilder().setName('serverinfo').setDescription('Informazioni sul server'),
        new SlashCommandBuilder().setName('userinfo').setDescription('Informazioni su un utente')
            .addUserOption(o => o.setName('utente').setDescription('Utente (default: te stesso)')),
        new SlashCommandBuilder().setName('avatar').setDescription('Mostra l\'avatar di un utente')
            .addUserOption(o => o.setName('utente').setDescription('Utente (default: te stesso)')),
        new SlashCommandBuilder().setName('ping').setDescription('Mostra la latenza del bot'),
        new SlashCommandBuilder().setName('help').setDescription('Mostra i comandi disponibili'),
        creavideoCommand.data,
        new SlashCommandBuilder().setName('config').setDescription('Gestisci la configurazione del bot')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommandGroup(g => g.setName('whitelist').setDescription('Gestisci la whitelist')
                .addSubcommand(s => s.setName('add').setDescription('Aggiungi utente (solo founder)')
                    .addUserOption(o => o.setName('utente').setDescription('Utente').setRequired(true)))
                .addSubcommand(s => s.setName('remove').setDescription('Rimuovi utente (solo founder)')
                    .addUserOption(o => o.setName('utente').setDescription('Utente').setRequired(true)))
                .addSubcommand(s => s.setName('list').setDescription('Mostra whitelist')))
            .addSubcommandGroup(g => g.setName('role').setDescription('Imposta un ruolo')
                .addSubcommand(s => s.setName('set').setDescription('Imposta ruolo (solo founder)')
                    .addStringOption(o => o.setName('target').setDescription('Tipo').setRequired(true)
                        .addChoices({ name: 'Ruolo immune', value: 'immuneRoleId' }, { name: 'Ruolo membro', value: 'memberRoleId' }, { name: 'Ruolo OG', value: 'ogRoleId' }))
                    .addRoleOption(o => o.setName('ruolo').setDescription('Ruolo').setRequired(true))))
            .addSubcommandGroup(g => g.setName('channel').setDescription('Imposta un canale')
                .addSubcommand(s => s.setName('set').setDescription('Imposta canale')
                    .addStringOption(o => o.setName('target').setDescription('Tipo').setRequired(true)
                        .addChoices({ name: 'Alert', value: 'alertChannelId' }, { name: 'Verifica', value: 'verifyChannelId' }, { name: 'Benvenuto', value: 'welcomeChannelId' }, { name: 'Bot sospetti', value: 'suspiciousBotLogChannelId' }, { name: 'Log messaggi', value: 'messageLogChannelId' }, { name: 'Log vocale', value: 'voiceLogChannelId' }, { name: 'Log membri', value: 'memberLogChannelId' }, { name: 'Log moderazione', value: 'modLogChannelId' }))
                    .addChannelOption(o => o.setName('canale').setDescription('Canale').setRequired(true))))
            .addSubcommandGroup(g => g.setName('logchannel').setDescription('Canali log')
                .addSubcommand(s => s.setName('add').setDescription('Aggiungi').addChannelOption(o => o.setName('canale').setDescription('Canale').setRequired(true)))
                .addSubcommand(s => s.setName('remove').setDescription('Rimuovi').addChannelOption(o => o.setName('canale').setDescription('Canale').setRequired(true)))
                .addSubcommand(s => s.setName('list').setDescription('Lista')))
            .addSubcommandGroup(g => g.setName('freechannel').setDescription('Canali free')
                .addSubcommand(s => s.setName('add').setDescription('Aggiungi').addChannelOption(o => o.setName('canale').setDescription('Canale').setRequired(true)))
                .addSubcommand(s => s.setName('remove').setDescription('Rimuovi').addChannelOption(o => o.setName('canale').setDescription('Canale').setRequired(true)))
                .addSubcommand(s => s.setName('list').setDescription('Lista')))
            .addSubcommandGroup(g => g.setName('publishchannel').setDescription('Canali auto-publish')
                .addSubcommand(s => s.setName('add').setDescription('Aggiungi').addChannelOption(o => o.setName('canale').setDescription('Canale').setRequired(true)))
                .addSubcommand(s => s.setName('remove').setDescription('Rimuovi').addChannelOption(o => o.setName('canale').setDescription('Canale').setRequired(true)))
                .addSubcommand(s => s.setName('list').setDescription('Lista')))
            .addSubcommandGroup(g => g.setName('staffrole').setDescription('Ruoli staff')
                .addSubcommand(s => s.setName('set').setDescription('Imposta')
                    .addStringOption(o => o.setName('chiave').setDescription('Chiave').setRequired(true)
                        .addChoices({ name: 'Helper', value: 'helper' }, { name: 'Moderator', value: 'moderator' }, { name: 'Founder', value: 'founder' }, { name: 'Head Media', value: 'headMedia' }, { name: 'Admin', value: 'admin' }, { name: 'Senior', value: 'senior' }))
                    .addRoleOption(o => o.setName('ruolo').setDescription('Ruolo').setRequired(true))))
            .addSubcommandGroup(g => g.setName('ticketrole').setDescription('Ruoli ticket')
                .addSubcommand(s => s.setName('set').setDescription('Imposta')
                    .addStringOption(o => o.setName('motivo').setDescription('Motivo').setRequired(true)
                        .addChoices({ name: 'Problema tra membri', value: 'membri' }, { name: 'Problema con il bot', value: 'bot' }))
                    .addRoleOption(o => o.setName('ruolo').setDescription('Ruolo').setRequired(true))))
            .addSubcommand(s => s.setName('show').setDescription('Mostra configurazione'))
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN || process.env.DISCORD_TOKEN);
    if (CONFIG.guildId && CONFIG.guildId !== "0") {
        try {
            await rest.put(Routes.applicationGuildCommands(CONFIG.clientId, CONFIG.guildId), { body: commands });
            Logger.info('Ready', `Comandi registrati sul guild ${CONFIG.guildId}.`);
        } catch (e) { Logger.error('Ready', e.message); }
    }
    try {
        await rest.put(Routes.applicationCommands(CONFIG.clientId), { body: commands });
        Logger.info('Ready', 'Comandi globali registrati.');
    } catch (e) { Logger.error('Ready', e.message); }
});

// ================= /config =================
async function handleConfigCommand(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    const isOwner = interaction.user.id === CONFIG.ownerId;
    const OWNER_ONLY_GROUPS = new Set(['whitelist']);
    const isOwnerOnlyRoleTarget = group === 'role' && sub === 'set' && interaction.options.getString('target') === 'immuneRoleId';
    if ((OWNER_ONLY_GROUPS.has(group) && sub !== 'list') || isOwnerOnlyRoleTarget) {
        if (!isOwner) return interaction.reply({ content: '❌ Solo il founder.', ephemeral: true });
    }
    if (!group && sub === 'show') {
        const embed = new EmbedBuilder()
            .setTitle('⚙️ Configurazione')
            .setColor('#5865F2')
            .addFields(
                { name: 'Founder', value: `<@${CONFIG.ownerId}>`, inline: false },
                { name: 'Whitelist', value: CONFIG.whitelistedIds.length ? CONFIG.whitelistedIds.map(id => `<@${id}>`).join(', ') : 'Vuota', inline: false },
                { name: 'Ruolo immune', value: CONFIG.immuneRoleId && CONFIG.immuneRoleId !== '0' ? `<@&${CONFIG.immuneRoleId}>` : 'Non impostato', inline: true },
                { name: 'Ruolo membro', value: CONFIG.memberRoleId && CONFIG.memberRoleId !== '0' ? `<@&${CONFIG.memberRoleId}>` : 'Non impostato', inline: true },
                { name: 'Canali log', value: CONFIG.logChannels.length ? CONFIG.logChannels.map(id => `<#${id}>`).join(', ') : 'Nessuno', inline: false }
            ).setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    if (group === 'whitelist') {
        if (sub === 'add') { const user = interaction.options.getUser('utente'); addToIdList('whitelistedIds', user.id); return interaction.reply({ content: `✅ **${user.tag}** aggiunto.`, ephemeral: true }); }
        if (sub === 'remove') { const user = interaction.options.getUser('utente'); removeFromIdList('whitelistedIds', user.id); return interaction.reply({ content: `✅ **${user.tag}** rimosso.`, ephemeral: true }); }
        if (sub === 'list') { const list = CONFIG.whitelistedIds.length ? CONFIG.whitelistedIds.map(id => `<@${id}>`).join('\n') : 'Vuota.'; return interaction.reply({ content: list, ephemeral: true }); }
    }
    if (group === 'role' && sub === 'set') { const target = interaction.options.getString('target'); const role = interaction.options.getRole('ruolo'); setConfigField(target, role.id); return interaction.reply({ content: `✅ **${target}** = ${role}.`, ephemeral: true }); }
    if (group === 'channel' && sub === 'set') { const target = interaction.options.getString('target'); const channel = interaction.options.getChannel('canale'); setConfigField(target, channel.id); return interaction.reply({ content: `✅ **${target}** = ${channel}.`, ephemeral: true }); }
    if (group === 'logchannel') {
        if (sub === 'add') { const channel = interaction.options.getChannel('canale'); addToIdList('logChannels', channel.id); return interaction.reply({ content: `✅ ${channel} aggiunto.`, ephemeral: true }); }
        if (sub === 'remove') { const channel = interaction.options.getChannel('canale'); removeFromIdList('logChannels', channel.id); return interaction.reply({ content: `✅ ${channel} rimosso.`, ephemeral: true }); }
        if (sub === 'list') { const list = CONFIG.logChannels.length ? CONFIG.logChannels.map(id => `<#${id}>`).join('\n') : 'Nessuno.'; return interaction.reply({ content: list, ephemeral: true }); }
    }
    if (group === 'freechannel') {
        if (sub === 'add') { const channel = interaction.options.getChannel('canale'); addToIdList('aiFreeChannels', channel.id); return interaction.reply({ content: `✅ ${channel} aggiunto.`, ephemeral: true }); }
        if (sub === 'remove') { const channel = interaction.options.getChannel('canale'); removeFromIdList('aiFreeChannels', channel.id); return interaction.reply({ content: `✅ ${channel} rimosso.`, ephemeral: true }); }
        if (sub === 'list') { const list = CONFIG.aiFreeChannels.length ? CONFIG.aiFreeChannels.map(id => `<#${id}>`).join('\n') : 'Nessuno.'; return interaction.reply({ content: list, ephemeral: true }); }
    }
    if (group === 'publishchannel') {
        if (sub === 'add') { const channel = interaction.options.getChannel('canale'); addToIdList('autoPublishChannels', channel.id); return interaction.reply({ content: `✅ ${channel} aggiunto.`, ephemeral: true }); }
        if (sub === 'remove') { const channel = interaction.options.getChannel('canale'); removeFromIdList('autoPublishChannels', channel.id); return interaction.reply({ content: `✅ ${channel} rimosso.`, ephemeral: true }); }
        if (sub === 'list') { const list = CONFIG.autoPublishChannels.length ? CONFIG.autoPublishChannels.map(id => `<#${id}>`).join('\n') : 'Nessuno.'; return interaction.reply({ content: list, ephemeral: true }); }
    }
    if (group === 'staffrole' && sub === 'set') { const key = interaction.options.getString('chiave'); const role = interaction.options.getRole('ruolo'); setStaffRoleField(key, role.id); return interaction.reply({ content: `✅ Ruolo **${key}** = ${role}.`, ephemeral: true }); }
    if (group === 'ticketrole' && sub === 'set') { const key = interaction.options.getString('motivo'); const role = interaction.options.getRole('ruolo'); const ok = setTicketReasonRole(key, role.id); if (!ok) return interaction.reply({ content: '❌ Motivo non valido.', ephemeral: true }); return interaction.reply({ content: `✅ Ruolo ticket **${key}** = ${role}.`, ephemeral: true }); }
    return interaction.reply({ content: '❌ Sottocomando non riconosciuto.', ephemeral: true });
}

// ================= INTERACTIONS =================
client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        try {
            if (interaction.customId === 'ticket_open') return await handleTicketOpen(interaction);
            if (interaction.customId.startsWith('ticket_reason_')) { const reasonKey = interaction.customId.replace('ticket_reason_', ''); return await handleTicketReason(interaction, reasonKey); }
            if (interaction.customId === 'ticket_close') return await handleTicketClose(interaction);
        } catch (e) { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ Errore.', ephemeral: true }).catch(() => {}); }
        return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'config') { try { return await handleConfigCommand(interaction); } catch (e) { Logger.error('config', e.message); if (!interaction.replied && !interaction.deferred) return interaction.reply({ content: '❌ Errore.', ephemeral: true }).catch(() => {}); return; } }
    if (interaction.commandName === 'regole') { return interaction.reply({ embeds: buildRulesEmbeds(interaction.guild), ephemeral: false }); }
    if (interaction.commandName === 'controlla') {
        await interaction.deferReply({ ephemeral: false });
        const query = interaction.options.getString('utente').toLowerCase();
        let found = false, lastId, fetchedCount = 0;
        try {
            while (fetchedCount < 500) {
                const options = { limit: 100 };
                if (lastId) options.before = lastId;
                const messages = await interaction.channel.messages.fetch(options);
                if (messages.size === 0) break;
                if (messages.find(m => m.content.toLowerCase().includes(query))) { found = true; break; }
                lastId = messages.last().id; fetchedCount += messages.size;
            }
            if (found) return interaction.editReply(`✅ Trovata richiesta whitelist per **${query}**.`);
            return interaction.editReply(`nessuna richiesta di whitelist si puo procedere all'espulsione dalla squadriglia`);
        } catch (e) { return interaction.editReply('❌ Errore.'); }
    }
    if (interaction.commandName === 'kick') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getUser('utente');
        const reason = interaction.options.getString('motivo') || 'Nessun motivo.';
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!member) return interaction.editReply('❌ Utente non trovato.');
        if (isImmune(member)) return interaction.editReply('👑 Utente immune.');
        if (!member.kickable) return interaction.editReply('❌ Non posso espellere.');
        setPermessi(interaction.user.id, getPermessi(interaction.user.id) + 1);
        await member.kick(`Da ${interaction.user.tag}: ${reason}`);
        await broadcastLog(interaction.guild, '👢 Kick', `**${interaction.user.tag}** → **${targetUser.tag}**. Motivo: ${reason}`, '#e74c3c');
        return interaction.editReply(`✅ **${targetUser.tag}** espulso.`);
    }
    if (interaction.commandName === 'ban') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getUser('utente');
        const reason = interaction.options.getString('motivo') || 'Nessun motivo.';
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (member && isImmune(member)) return interaction.editReply('👑 Utente immune.');
        if (member && !member.bannable) return interaction.editReply('❌ Non posso bannare.');
        setPermessi(interaction.user.id, getPermessi(interaction.user.id) + 1);
        await interaction.guild.members.ban(targetUser.id, { reason: `Da ${interaction.user.tag}: ${reason}` });
        await broadcastLog(interaction.guild, '🔨 Ban', `**${interaction.user.tag}** → **${targetUser.tag}**. Motivo: ${reason}`, '#c0392b');
        return interaction.editReply(`✅ **${targetUser.tag}** bannato.`);
    }
    if (interaction.commandName === 'timeout') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getUser('utente');
        const minutes = Math.min(interaction.options.getInteger('durata'), CONFIG.maxTimeoutMinutes);
        const reason = interaction.options.getString('motivo') || 'Nessun motivo.';
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!member) return interaction.editReply('❌ Utente non trovato.');
        if (isImmune(member)) return interaction.editReply('👑 Utente immune.');
        if (!member.moderatable) return interaction.editReply('❌ Non posso mettere in timeout.');
        await member.timeout(minutes * 60 * 1000, `Da ${interaction.user.tag}: ${reason}`);
        await broadcastLog(interaction.guild, '🔇 Timeout', `**${interaction.user.tag}** → **${targetUser.tag}** per **${minutes}m**.`, '#e67e22');
        return interaction.editReply(`✅ Timeout di **${minutes} minuti** a **${targetUser.tag}**.`);
    }
    if (interaction.commandName === 'untimeout') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getUser('utente');
        const reason = interaction.options.getString('motivo') || 'Nessun motivo.';
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!member) return interaction.editReply('❌ Utente non trovato.');
        if (!member.moderatable) return interaction.editReply('❌ Non posso rimuovere.');
        if (!member.communicationDisabledUntil) return interaction.editReply('⚠️ Non è in timeout.');
        await member.timeout(null, `Da ${interaction.user.tag}: ${reason}`);
        await broadcastLog(interaction.guild, '🔊 Timeout Rimosso', `**${interaction.user.tag}** → **${targetUser.tag}**.`, '#2ecc71');
        return interaction.editReply(`✅ Timeout rimosso per **${targetUser.tag}**.`);
    }
    if (interaction.commandName === 'unban') {
        await interaction.deferReply({ ephemeral: true });
        const userId = interaction.options.getString('id').trim();
        const reason = interaction.options.getString('motivo') || 'Nessun motivo.';
        const banInfo = await interaction.guild.bans.fetch(userId).catch(() => null);
        if (!banInfo) return interaction.editReply('❌ Nessun ban trovato.');
        await interaction.guild.members.unban(userId, `Da ${interaction.user.tag}: ${reason}`).catch(() => {});
        await broadcastLog(interaction.guild, '🔓 Ban Rimosso', `**${interaction.user.tag}** → **${banInfo.user.tag}**.`, '#2ecc71');
        return interaction.editReply(`✅ Ban rimosso per **${banInfo.user.tag}**.`);
    }
    if (interaction.commandName === 'warn') {
        await interaction.deferReply({ ephemeral: true });
        const targetUser = interaction.options.getUser('utente');
        const reason = interaction.options.getString('motivo');
        const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!member) return interaction.editReply('❌ Utente non trovato.');
        if (isImmune(member)) return interaction.editReply('👑 Utente immune.');
        try {
            await member.send({ embeds: [new EmbedBuilder().setTitle('⚠️ Avviso').setDescription(`Sei stato avvisato in **${interaction.guild.name}**.\n\n**Motivo:** ${reason}\n**Da:** ${interaction.user.tag}`).setColor('#f39c12').setTimestamp()] });
        } catch (e) {}
        await broadcastLog(interaction.guild, '⚠️ Warn', `**${interaction.user.tag}** → **${targetUser.tag}**. Motivo: ${reason}`, '#f39c12');
        return interaction.editReply(`✅ Avviso inviato a **${targetUser.tag}**.`);
    }
    if (interaction.commandName === 'verify') {
        if (interaction.channelId !== CONFIG.verifyChannelId) return interaction.reply({ content: 'Usa il canale di verifica.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const member = interaction.member;
        if (member.roles.cache.has(CONFIG.memberRoleId)) return interaction.editReply('Sei già verificato!');
        try {
            const roles = [CONFIG.memberRoleId];
            if (interaction.guild.memberCount <= 150) roles.push(CONFIG.ogRoleId);
            await member.roles.add(roles);
            return interaction.editReply('✅ Verifica completata!');
        } catch { return interaction.editReply('❌ Errore.'); }
    }
    if (interaction.commandName === 'roleall') {
        const role = interaction.options.getRole('ruolo');
        await interaction.reply({ content: `⏳ Assegnazione **${role.name}**…`, ephemeral: true });
        const members = await interaction.guild.members.fetch();
        let count = 0;
        for (const [, m] of members) { if (!m.roles.cache.has(role.id) && !m.user.bot) { await m.roles.add(role).catch(() => {}); count++; } }
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
                deleted += del.size; toDelete -= lim;
                if (del.size < fetched.size) { hitOld = true; break; }
                if (del.size === 0) break;
            } catch { break; }
        }
        let reply = `🗑️ Eliminati **${deleted}** messaggi.`;
        if (hitOld) reply += '\n⚠️ Alcuni messaggi >14 giorni non possono essere eliminati.';
        return interaction.editReply(reply);
    }
    if (interaction.commandName === 'backup_server') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const r = await performGuildBackup(interaction.guild);
            return interaction.editReply(`💾 Backup: ${r.channelsCount} canali, ${r.categoriesCount} categorie, ${r.threadsCount} thread, ${r.rolesCount} ruoli, ${r.membersCount} membri.`);
        } catch (e) { return interaction.editReply('❌ Errore.'); }
    }
    if (interaction.commandName === 'stats_setup') {
        await interaction.deferReply({ ephemeral: true });
        try {
            const entry = await ensureStatsChannels(interaction.guild);
            if (!entry) return interaction.editReply('❌ Errore.');
            await performStatsUpdate(interaction.guild);
            return interaction.editReply('✅ Stats aggiornate.');
        } catch { return interaction.editReply('❌ Errore.'); }
    }
    if (interaction.commandName === 'stats_refresh') {
        await interaction.deferReply({ ephemeral: true });
        try { const runtime = getStatsRuntime(interaction.guild.id); runtime.lastUpdate = 0; await performStatsUpdate(interaction.guild); return interaction.editReply('✅ Stats aggiornate.'); } catch { return interaction.editReply('❌ Errore.'); }
    }
    if (interaction.commandName === 'ticket_setup') {
        await interaction.deferReply({ ephemeral: true });
        try { const entry = await ensureTicketPanel(interaction.guild); if (!entry) return interaction.editReply('❌ Errore.'); return interaction.editReply('✅ Pannello ticket pronto.'); } catch { return interaction.editReply('❌ Errore.'); }
    }
    if (interaction.commandName === 'serverinfo') {
        const g = interaction.guild;
        await g.members.fetch().catch(() => {});
        const owner = await g.fetchOwner().catch(() => null);
        const embed = new EmbedBuilder()
            .setTitle(`📊 ${g.name}`)
            .setThumbnail(g.iconURL({ size: 256 }))
            .setColor('#5865F2')
            .addFields(
                { name: 'ID', value: `\`${g.id}\``, inline: true },
                { name: 'Owner', value: owner ? `${owner.user.tag}` : 'N/D', inline: true },
                { name: 'Creato il', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:F>`, inline: false },
                { name: 'Membri', value: `${g.memberCount}`, inline: true },
                { name: 'Canali', value: `${g.channels.cache.size}`, inline: true },
                { name: 'Ruoli', value: `${g.roles.cache.size}`, inline: true },
                { name: 'Boosts', value: `${g.premiumSubscriptionCount || 0} (Liv. ${g.premiumTier})`, inline: true },
                { name: 'Verification', value: `${g.verificationLevel}`, inline: true },
                { name: 'Locale', value: `${g.preferredLocale}`, inline: true }
            ).setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }
    if (interaction.commandName === 'userinfo') {
        const target = interaction.options.getUser('utente') || interaction.user;
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);
        const embed = new EmbedBuilder()
            .setTitle(`👤 ${target.tag}`)
            .setThumbnail(target.displayAvatarURL({ size: 256 }))
            .setColor('#5865F2')
            .addFields(
                { name: 'ID', value: `\`${target.id}\``, inline: true },
                { name: 'Bot', value: target.bot ? 'Sì' : 'No', inline: true },
                { name: 'Account creato', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:R>`, inline: false }
            );
        if (member) {
            embed.addFields(
                { name: 'Entrato nel server', value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'N/D', inline: false },
                { name: 'Nickname', value: member.nickname || '—', inline: true },
                { name: 'Ruoli', value: member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => `<@&${r.id}>`).slice(0, 15).join(', ') || '—', inline: false }
            );
        }
        return interaction.reply({ embeds: [embed] });
    }
    if (interaction.commandName === 'avatar') {
        const target = interaction.options.getUser('utente') || interaction.user;
        const embed = new EmbedBuilder().setTitle(`🖼️ Avatar di ${target.tag}`).setImage(target.displayAvatarURL({ size: 1024, dynamic: true })).setColor('#5865F2');
        return interaction.reply({ embeds: [embed] });
    }
    if (interaction.commandName === 'ping') {
        const ws = client.ws.ping;
        return interaction.reply({ content: `🏓 Pong! Latenza: **${ws}ms**`, ephemeral: true });
    }
    if (interaction.commandName === 'help') {
        const embed = new EmbedBuilder()
            .setTitle('📖 Comandi disponibili')
            .setColor('#5865F2')
            .setDescription(
                '**Generali**\n' +
                '`/help` — questo messaggio\n' +
                '`/ping` — latenza del bot\n' +
                '`/serverinfo` — info server\n' +
                '`/userinfo [@utente]` — info utente\n' +
                '`/avatar [@utente]` — avatar\n' +
                '`/verify` — verifica\n' +
                '`/regole` — regolamento\n\n' +
                '**Moderazione (staff)**\n' +
                '`/kick`, `/ban`, `/unban`, `/timeout`, `/untimeout`, `/warn`, `/clear`\n\n' +
                '**Altro**\n' +
                '`/ticket_setup`, `/stats_setup`, `/backup_server`, `/restore_server`, `/roleall`, `/creavideo`'
            )
            .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    if (interaction.commandName === 'comandi') {
        if (interaction.user.id !== CONFIG.ownerId) return interaction.reply({ content: '❌ Solo il founder.', ephemeral: true });
        const embed = new EmbedBuilder()
            .setTitle('📖 Lista Comandi (Founder)')
            .setColor('#5865F2')
            .setDescription(
                '**Moderazione:** `/kick`, `/ban`, `/unban`, `/timeout`, `/untimeout`, `/warn`, `/clear`, `/roleall`, `/controlla`\n\n' +
                '**Configurazione:** `/config show`, `/config whitelist add|remove|list`, `/config role set`, `/config channel set`, `/config logchannel`, `/config freechannel`, `/config publishchannel`, `/config staffrole set`, `/config ticketrole set`\n\n' +
                '**Solo Founder (!):** `!concedi`, `!toglipermessi`, `!lock`, `!unlock`\n\n' +
                '**Backup:** `/backup_server`, `/restore_server` (auto ogni 24h)\n\n' +
                '**Stats/Ticket:** `/stats_setup`, `/stats_refresh`, `/ticket_setup`\n\n' +
                '**Utility:** `/serverinfo`, `/userinfo`, `/avatar`, `/ping`, `/help`\n\n' +
                '**Automatismi:** Anti-Nuke + riparazione, Anti-Spam, Anti-Ping, Anti-Raid, Anti-Link, **Anti-Ghost-Ping**, **Log messaggi edit/delete**, **Log vocale**, **Log membri**, **Auto-Publish**'
            ).setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    if (interaction.commandName === 'creavideo') return creavideoCommand.execute(interaction);
    if (interaction.commandName === 'restore_server') {
        const backupPath = getBackupPath(interaction.guild.id);
        if (!fs.existsSync(backupPath)) return interaction.reply({ content: `❌ Nessun backup per **${interaction.guild.name}**.`, ephemeral: true });
        let data;
        try { data = JSON.parse(await fs.promises.readFile(backupPath, 'utf-8')); } catch { return interaction.reply({ content: '❌ Errore lettura.', ephemeral: true }); }
        if (data.guildId && data.guildId !== interaction.guild.id) return interaction.reply({ content: '❌ Backup di altro server.', ephemeral: true });
        await interaction.reply({ content: '⚠️ Eliminazione di TUTTI i canali/ruoli in 10s…', ephemeral: true });
        await delay(10000);
        try {
            const r = await performGuildRestore(interaction.guild, data);
            const esito = `✅ Ripristino per **${interaction.guild.name}**!\nCanali: **${r.createdChannels}/${(data.channels ?? []).length}**\nCategorie: **${r.createdCategories}/${(data.categories ?? []).length}**\nThread: **${r.createdThreads}/${(data.threads ?? []).length}**\nRuoli: **${r.createdRoles}/${(data.roles ?? []).length}**\nAssegnazioni: **${r.restoredMembers}/${(data.memberRoles ?? []).length}**`;
            await interaction.user.send(esito).catch(() => {});
            await broadcastLog(interaction.guild, '♻️ Restore Completato', esito, '#2ecc71');
        } catch (e) { await interaction.user.send(`❌ Errore: ${e.message}`).catch(() => {}); }
    }
});

// ================= ERROR HANDLING =================
process.on('unhandledRejection', e => Logger.error('unhandledRejection', e));
process.on('uncaughtException', e => Logger.error('uncaughtException', e));

const LOGIN_RETRY_BASE_DELAY_MS = 5000;
const LOGIN_RETRY_MAX_DELAY_MS = 60000;
let loginAttempt = 0;

async function loginWithRetry() {
    const token = process.env.TOKEN || process.env.DISCORD_TOKEN;
    try {
        await client.login(token);
        Logger.info('Login', 'riuscito.');
        loginAttempt = 0;
    } catch (err) {
        loginAttempt++;
        const wait = Math.min(LOGIN_RETRY_BASE_DELAY_MS * Math.pow(1.5, loginAttempt - 1), LOGIN_RETRY_MAX_DELAY_MS);
        Logger.error('Login', `tentativo ${loginAttempt}: ${err.message}. Riprovo tra ${Math.round(wait / 1000)}s...`);
        setTimeout(loginWithRetry, wait);
    }
}

loginWithRetry();
