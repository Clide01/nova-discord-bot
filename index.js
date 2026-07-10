require('dotenv').config();
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    EmbedBuilder, 
    PermissionFlagsBits, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    MessageFlags,
    AuditLogEvent 
} = require('discord.js');
const fs = require('fs');
const axios = require('axios');
const express = require('express');

// --- HELPER FUNCTION: FORMAT UPTIME ---
function formatUptime(ms) {
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    const daysms = ms % (24 * 60 * 60 * 1000);
    const hours = Math.floor(daysms / (60 * 60 * 1000));
    const hoursms = ms % (60 * 60 * 1000);
    const minutes = Math.floor(hoursms / (60 * 1000));
    const minutesms = ms % (60 * 1000);
    const seconds = Math.floor(minutesms / 1000);

    let timeString = '';
    if (days > 0) timeString += `${days}d `;
    if (hours > 0) timeString += `${hours}h `;
    if (minutes > 0) timeString += `${minutes}m `;
    timeString += `${seconds}s`;

    return timeString || 'Just started';
}

// --- SUPPORTED BYPASS DOMAINS ---
const ALLOWED_DOMAINS = [
    // Key Systems
    'platorelay.com', 'platoboost.app', 'platoboost.se', 'pandadevelopment.net', 
    'trigonevo.com', 'violated.lol', 'blox-script.com', 'boblox-script.com', 
    'hydrogen.lat', 'codex.lol', 
    // Ad-Links
    'linkvertise.com', 'link-to.net', 'link-hub.net', 'link-target.net', 
    'loot-link.com', 'lootdest.org', 'free-content.pro', 'lootlabs.com', 
    'work.ink', 'workink.net', 'rinku.pro', '7rnb.io', 'stfly.vip', 'shrtslug.biz', 
    'lockr.sb', 'lockr.net', 'linkunlocker.com', 'link-unlock.com', 'arolinks.com', 
    'tpl.li', 'socialwolvez.com', 'linkify.ru', 'mboost.me', 'social-unlock.com', 
    'rekonise.com', 'rekonise.org', 'rkns.link', 'sub2unlock.com', 'sub2unlock.me', 
    'sub2unlock.io', 'sub4unlock.com', 'sub4unlock.me', 'sub4unlock.io', 
    'bstlar.com', 'scriptpastebins.com', 'sfl.gl', 'yorurl.com', 'robloxscripts.gg', 
    'lnbz.la', 'linkzy.space', 'ez4short.com', 
    // Pastes
    'pastebin.com', 'paste-drop.com', 'pastefy.app', 'paster.so'
];

// --- TRAFFIC COP (CONCURRENCY QUEUE) ---
class BypassQueue {
    constructor(limit) {
        this.limit = limit; 
        this.active = 0;
        this.queue = [];
    }

    async add(task) {
        if (this.active >= this.limit) {
            await new Promise(resolve => this.queue.push(resolve));
        }
        this.active++;
        try {
            return await task();
        } finally {
            this.active--;
            if (this.queue.length > 0) {
                const nextResolve = this.queue.shift();
                nextResolve();
            }
        }
    }
}
const apiQueue = new BypassQueue(3);

// --- MEMORY CACHES ---
const keyCache = new Map();
const retryCache = new Map(); 

// --- SERVER SETTINGS SETUP ---
const configFile = './config.json';
let config = {};
if (fs.existsSync(configFile)) {
    config = JSON.parse(fs.readFileSync(configFile));
} else {
    fs.writeFileSync(configFile, JSON.stringify(config));
}

// --- STATS TRACKER SETUP ---
const statsFile = './stats.json';
let botStats = { globalBypasses: 0, serverBypasses: {}, timeSavedSeconds: 0 };
if (fs.existsSync(statsFile)) {
    botStats = JSON.parse(fs.readFileSync(statsFile));
} else {
    fs.writeFileSync(statsFile, JSON.stringify(botStats));
}

function saveStats() {
    fs.writeFileSync(statsFile, JSON.stringify(botStats, null, 2));
}

// --- BOT INITIALIZATION ---
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers 
    ] 
});

// --- COMMAND DEFINITIONS ---
const commands = [
    new SlashCommandBuilder()
        .setName('bypass')
        .setDescription('Manually bypass a link anywhere in the server')
        .addStringOption(option => 
            option.setName('url')
            .setDescription('The ad-link you want to bypass')
            .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('set')
        .setDescription('Set the specific channel for automatic link bypassing')
        .addChannelOption(option => option.setName('channel').setDescription('The bypass channel').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        
    new SlashCommandBuilder()
        .setName('set-logs')
        .setDescription('Set a private channel where the bot will send detailed API error logs')
        .addChannelOption(option => option.setName('channel').setDescription('The private developer/staff log channel').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        
    new SlashCommandBuilder()
        .setName('set-support')
        .setDescription('Set the channel where users should go to ask for help')
        .addChannelOption(option => option.setName('channel').setDescription('The community support/ticket channel').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        
    new SlashCommandBuilder()
        .setName('send-info')
        .setDescription('Send a custom instruction embed to the current channel')
        .addStringOption(option => option.setName('message').setDescription('The custom instructions').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('View NovaBypass global and server statistics'),
        
    new SlashCommandBuilder()
        .setName('website')
        .setDescription('Get the link to the official NovaBypass Web Dashboard'),

    new SlashCommandBuilder()
        .setName('testbot')
        .setDescription('Run a developer sandbox test bypass (Only visible to you)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
        .setName('testfail')
        .setDescription('Simulate a failed bypass to test error buttons (Only visible to you)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

client.once('clientReady', async () => {
    console.log(`Success! Logged in as ${client.user.tag}`);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Slash commands ready.');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
});

// ==========================================
// TRACK WHO ADDS THE BOT
// ==========================================
client.on('guildCreate', async guild => {
    try {
        const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.BotAdd });
        const botLog = auditLogs.entries.first();
        let inviterInfo = "Unknown User (Audit log not found)";
        
        if (botLog) {
            const { executor, target } = botLog;
            if (target.id === client.user.id) {
                inviterInfo = `<@${executor.id}> (${executor.tag})`;
            }
        }
        console.log(`🟢 JOINED SERVER: ${guild.name} | Added by: ${inviterInfo}`);
    } catch (error) {
        console.log(`🟢 JOINED SERVER: ${guild.name} | Could not read audit logs (Missing Permissions).`);
    }
});

// ==========================================
// REUSABLE BYPASS ENGINE WITH STRICT GATEKEEPER
// ==========================================
async function processLinkBypass(targetUrl, userId, guildId, channel, directReveal = false) {
    let botMessage; 
    try {
        const displayUrl = targetUrl.length > 50 ? targetUrl.substring(0, 50) + '...' : targetUrl;

        const processingEmbed = new EmbedBuilder()
            .setDescription(`<@${userId}>\n🔄 **Processing your link...**\n\`${displayUrl}\``)
            .setColor('#2B2D31'); 

        botMessage = await channel.send({ embeds: [processingEmbed] });
        const startTime = Date.now();
        const apiUrl = `https://api-bypassers.onrender.com/api/bypass`;

        const response = await apiQueue.add(() => axios.post(apiUrl, 
            { url: targetUrl }, 
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'X-API-Key': 'freeApikey',
                    'Content-Type': 'application/json'
                }
            }
        ));
        
        let dynamicKey = response.data.result || response.data.key || response.data.bypassed || response.data.destination || response.data.bypassed_link; 

        if (dynamicKey && typeof dynamicKey === 'string') {
            dynamicKey = dynamicKey.trim();
        }

        const lowerKey = dynamicKey ? dynamicKey.toLowerCase() : "";

        if (lowerKey.includes("already being processed") || lowerKey.includes("wait") || lowerKey.includes("try again")) {
            throw new Error("The API is actively processing this link. Please wait 10 seconds and click Retry.");
        }

        if (!dynamicKey || dynamicKey === "" || dynamicKey === targetUrl || dynamicKey.length === 0 || lowerKey.includes("discord") || lowerKey.includes("shut down") || lowerKey.includes("unsupported") || lowerKey.includes("failed") || lowerKey.includes("expired") || lowerKey.includes("error") || lowerKey.includes("invalid")) {
             throw new Error(`API Notice: ${dynamicKey || "Empty response payload"}`);
        }

        botStats.globalBypasses += 1;
        if (guildId) {
            botStats.serverBypasses[guildId] = (botStats.serverBypasses[guildId] || 0) + 1;
        }
        botStats.timeSavedSeconds += 15; 
        saveStats();

        const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
        const shortId = Math.random().toString(36).substring(2, 10);
        
        keyCache.set(shortId, dynamicKey);
        setTimeout(() => keyCache.delete(shortId), 3600000); 

        if (directReveal) {
            const successEmbed = new EmbedBuilder()
                .setTitle('✅ Bypass Success • Completed in ' + timeTaken + 's')
                .setDescription(dynamicKey)
                .setColor('#2ECC71'); 

            await botMessage.edit({ content: `<@${userId}> Your link has been successfully bypassed!`, embeds: [successEmbed], components: [] });
        } else {
            const successEmbed = new EmbedBuilder()
                .setTitle('✅ Bypass Success • Completed in ' + timeTaken + 's')
                .setDescription(`Your link has been successfully bypassed!\nClick the **Result** button below to receive your private key via Direct Message.`)
                .setColor('#2ECC71'); 

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`result_${userId}_${shortId}`) 
                    .setLabel('Result')
                    .setStyle(ButtonStyle.Primary)
            );

            await botMessage.edit({ content: `<@${userId}>`, embeds: [successEmbed], components: [row] });
        }

    } catch (error) {
        console.error('Bypass caught error:', error.message);
        if (botMessage && botMessage.deletable) {
            await botMessage.delete().catch(e => {});
        }
        
        const retryId = Math.random().toString(36).substring(2, 10);
        retryCache.set(retryId, { url: targetUrl, directReveal: directReveal });
        setTimeout(() => retryCache.delete(retryId), 3600000); 

        let displayReason = error.message;
        if (error.message.includes('429') || (error.response && error.response.status === 429)) {
            displayReason = "The bypass servers are currently busy. Please try again later.";
        } else if (error.message.includes('500') || (error.response && error.response.status === 500)) {
            displayReason = "The link took too long to process (API Timeout). Please click Retry!";
        }

        const errorEmbed = new EmbedBuilder()
            .setDescription(`<@${userId}>\n❌ **Failed to bypass.**\n**Reason:** ${displayReason}`)
            .setColor('#FF0000');

        const buttonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`retry_${userId}_${retryId}`)
                .setLabel('Retry')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🔄')
        );

        const supportChannelId = config[`support_${guildId}`];
        if (supportChannelId) {
            buttonRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`help_${userId}`)
                    .setLabel('Ask for Help')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🆘')
            );
        }

        const errorMsg = await channel.send({ embeds: [errorEmbed], components: [buttonRow] });
        setTimeout(() => { if (errorMsg.deletable) errorMsg.delete().catch(e => {}); }, 60000);

        if (guildId) {
            const savedLogChannelId = config[`logs_${guildId}`];
            if (savedLogChannelId) {
                try {
                    let rawResponse = "No response payload detected.";
                    if (error.response && error.response.data) {
                        try { rawResponse = JSON.stringify(error.response.data).substring(0, 400); } catch (e) {}
                    }
                    
                    const safeLogUrl = targetUrl.length > 1000 ? targetUrl.substring(0, 997) + '...' : targetUrl;

                    const devChannel = await client.channels.fetch(savedLogChannelId);
                    if (devChannel) {
                        const devEmbed = new EmbedBuilder()
                            .setTitle('⚠️ API Bypass Failure')
                            .addFields(
                                { name: 'Requested By', value: `<@${userId}> (\`${userId}\`)`, inline: true },
                                { name: 'Server ID', value: `\`${guildId}\``, inline: true },
                                { name: 'Target URL', value: safeLogUrl, inline: false },
                                { name: 'Error Message', value: error.message, inline: false },
                                { name: 'Raw Payload', value: `\`\`\`json\n${rawResponse}\n\`\`\``, inline: false }
                            )
                            .setColor('#FF0000')
                            .setTimestamp();
                        await devChannel.send({ embeds: [devEmbed] });
                    }
                } catch (devLogErr) {}
            }
        }
    }
}

// ==========================================
// AUTOMATIC MESSAGING LISTENER
// ==========================================
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const allowedChannelId = config[message.guildId];
    if (!allowedChannelId || message.channelId !== allowedChannelId) return;

    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const foundLinks = message.content.match(urlRegex);

    if (foundLinks) {
        const uniqueLinks = [...new Set(foundLinks)].slice(0, 3);
        
        let hasProcessedLink = false;

        for (const targetUrl of uniqueLinks) {
            const lowerUrl = targetUrl.toLowerCase();

            if (lowerUrl.includes('luarmor.net')) {
                try {
                    const luarmorWarnEmbed = new EmbedBuilder()
                        .setTitle('⚠️ Luarmor Link Detected')
                        .setDescription(`<@${message.author.id}>\nBypassing **Luarmor** script keys will trigger an automatic server-side blacklist, blocking you for **2 hours**.\n\nTo keep your profile safe, I have skipped this specific link. Please complete it manually in your browser!`)
                        .setColor('#FFA500');

                    const warnMsg = await message.channel.send({ embeds: [luarmorWarnEmbed] });
                    setTimeout(() => { if (warnMsg.deletable) warnMsg.delete().catch(e => {}); }, 15000);
                } catch (err) {}
                hasProcessedLink = true;
                continue;
            }

            // INSTANT LOCAL FILTER: Silently ignore unsupported links so normal chat isn't interrupted
            const isSupported = ALLOWED_DOMAINS.some(domain => lowerUrl.includes(domain));
            if (!isSupported) {
                continue; 
            }

            processLinkBypass(targetUrl, message.author.id, message.guildId, message.channel);
            hasProcessedLink = true;
        }

        // Only delete the original user message if we actually found and processed a valid ad-link
        if (hasProcessedLink) {
            await message.delete().catch(() => {});
        }
    }
});

// ==========================================
// COMMAND & INTERACTION ROUTERS
// ==========================================
client.on('interactionCreate', async interaction => {
    
    // --- COMMAND: /bypass ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'bypass') {
        const targetUrl = interaction.options.getString('url');
        const lowerUrl = targetUrl.toLowerCase();

        if (lowerUrl.includes('luarmor.net')) {
            const unsupportedEmbed = new EmbedBuilder()
                .setTitle('⚠️ Luarmor Link Detected')
                .setDescription(`Bypassing **Luarmor** script keys triggers server blacklists. Please complete it manually in your browser!`)
                .setColor('#FFA500');
            
            return interaction.reply({ embeds: [unsupportedEmbed], flags: MessageFlags.Ephemeral });
        }

        // INSTANT LOCAL FILTER: Explicit error message since they used a direct command
        const isSupported = ALLOWED_DOMAINS.some(domain => lowerUrl.includes(domain));
        if (!isSupported) {
            const unsupportedEmbed = new EmbedBuilder()
                .setTitle('❌ Unsupported Link')
                .setDescription(`This URL is not supported by our bypass system.\n\nPlease provide a valid ad-link (e.g., Linkvertise, LootLabs, Platoboost).`)
                .setColor('#FF0000');
            
            return interaction.reply({ embeds: [unsupportedEmbed], flags: MessageFlags.Ephemeral });
        }

        await interaction.reply({ content: `✅ Bypass initiated! Processing link...`, flags: MessageFlags.Ephemeral });

        processLinkBypass(targetUrl, interaction.user.id, interaction.guildId, interaction.channel, true);
        return;
    }
    
    // --- COMMAND: WEBSITE LINKING ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'website') {
        const webEmbed = new EmbedBuilder()
            .setTitle('🌐 NovaBypass Web Dashboard')
            .setDescription('Need to bypass a link fast? Our web client is clean, mobile-friendly, and open 24/7!\n\n🔗 **[Click here to visit NovaBypass Web](https://nova-autobypass.wasmer.app/)**')
            .setColor('#5865F2')
            .setThumbnail(client.user.displayAvatarURL());
        
        await interaction.reply({ embeds: [webEmbed], flags: MessageFlags.Ephemeral });
        return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'testbot') {
        const dummyUrl = "https://gateway.platoboost.com/a/8?id=12345";
        const dummyKey = "DELTA_KEY_TEST_XYZ_SUPER_LONG_KEY_STRING_123456789";

        const processingEmbed = new EmbedBuilder()
            .setDescription(`<@${interaction.user.id}>\n🔄 **Processing your link...**\n${dummyUrl}`)
            .setColor('#2B2D31'); 

        await interaction.reply({ embeds: [processingEmbed], flags: MessageFlags.Ephemeral });

        setTimeout(async () => {
            const shortId = Math.random().toString(36).substring(2, 10);
            keyCache.set(shortId, dummyKey);
            setTimeout(() => keyCache.delete(shortId), 3600000); 

            const successEmbed = new EmbedBuilder()
                .setTitle('✅ Bypass Success • Completed in 1.50s')
                .setDescription(dummyKey)
                .setColor('#2ECC71'); 
            
            await interaction.editReply({ content: `<@${interaction.user.id}> Your link has been successfully bypassed!`, embeds: [successEmbed] });
        }, 1500);
        return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'testfail') {
        const dummyUrl = "https://linkvertise.com/12345/failed_test_link";

        const processingEmbed = new EmbedBuilder()
            .setDescription(`<@${interaction.user.id}>\n🔄 **Processing your link...**\n${dummyUrl}`)
            .setColor('#2B2D31'); 

        await interaction.reply({ embeds: [processingEmbed], flags: MessageFlags.Ephemeral });

        setTimeout(async () => {
            const retryId = Math.random().toString(36).substring(2, 10);
            retryCache.set(retryId, { url: dummyUrl, directReveal: false });
            setTimeout(() => retryCache.delete(retryId), 3600000); 

            const errorEmbed = new EmbedBuilder()
                .setDescription(`<@${interaction.user.id}>\n❌ **Failed to bypass.**\n**Reason:** The bypass servers are currently busy. Please try again later.`)
                .setColor('#FF0000');

            const buttonRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`retry_${interaction.user.id}_${retryId}`)
                    .setLabel('Retry')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔄')
            );

            const supportChannelId = config[`support_${interaction.guildId}`];
            if (supportChannelId) {
                buttonRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`help_${interaction.user.id}`)
                        .setLabel('Ask for Help')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('🆘')
                );
            }
            
            await interaction.editReply({ embeds: [errorEmbed], components: [buttonRow] });
        }, 1500);
        return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'stats') {
        const serverCount = botStats.serverBypasses[interaction.guildId] || 0;
        const hoursSaved = (botStats.timeSavedSeconds / 3600).toFixed(1);
        const currentUptime = formatUptime(client.uptime);

        const statsEmbed = new EmbedBuilder()
            .setTitle('📊 NovaBypass Statistics')
            .setDescription('Here is how much time we have saved by skipping ad-gates:')
            .addFields(
                { name: '🌍 Global Bypasses', value: `**${botStats.globalBypasses}** links`, inline: true },
                { name: '🏠 Server Bypasses', value: `**${serverCount}** links`, inline: true },
                { name: '⏱️ Total Time Saved', value: `**~${hoursSaved}** hours`, inline: false },
                { name: '🟢 Bot Uptime', value: `**${currentUptime}**`, inline: false }
            )
            .setColor('#2B2D31')
            .setThumbnail(client.user.displayAvatarURL());

        await interaction.reply({ embeds: [statsEmbed] });
        return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'set') {
        const targetChannel = interaction.options.getChannel('channel');
        config[interaction.guildId] = targetChannel.id;
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        await interaction.reply({ content: `✅ Auto-bypass is active in <#${targetChannel.id}>.`, flags: MessageFlags.Ephemeral });
        return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'set-logs') {
        const logChannel = interaction.options.getChannel('channel');
        config[`logs_${interaction.guildId}`] = logChannel.id;
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        await interaction.reply({ content: `✅ Dev logs configuration locked Stream mapped into <#${logChannel.id}>.`, flags: MessageFlags.Ephemeral });
        return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'set-support') {
        const supportChannel = interaction.options.getChannel('channel');
        config[`support_${interaction.guildId}`] = supportChannel.id;
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
        await interaction.reply({ content: `✅ The "Ask for Help" button will now direct users to <#${supportChannel.id}>.`, flags: MessageFlags.Ephemeral });
        return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'send-info') {
        try {
            const customMessage = interaction.options.getString('message');
            const infoEmbed = new EmbedBuilder()
                .setTitle('🔗 Link Bypass Instructions')
                .setDescription(customMessage)
                .setColor('#2B2D31'); 

            const targetChannel = interaction.channel || await interaction.client.channels.fetch(interaction.channelId);
            await targetChannel.send({ embeds: [infoEmbed] });
            
            await interaction.reply({ content: '✅ Instruction embed sent successfully!', flags: MessageFlags.Ephemeral });
        } catch (error) {
            await interaction.reply({ content: '❌ Failed to send instruction embed.', flags: MessageFlags.Ephemeral });
        }
        return;
    }

    if (interaction.isButton()) {
        const parts = interaction.customId.split('_');
        const action = parts[0]; 
        const targetUserId = parts[1];
        const shortId = parts[2]; 

        if (action === 'result') {
            if (interaction.user.id !== targetUserId) {
                return interaction.reply({ content: "❌ This isn't your bypass result!", flags: MessageFlags.Ephemeral });
            }
            
            const key = keyCache.get(shortId);
            if (!key) {
                 return interaction.reply({ content: '❌ This bypass result has expired from my memory! Please post your link again.', flags: MessageFlags.Ephemeral });
            }

            try {
                const dmEmbed = new EmbedBuilder()
                    .setTitle('✅ Your bypassed key:')
                    .setDescription(key)
                    .setColor('#00FF00');
                
                const dmChannel = await interaction.user.createDM();
                
                await dmChannel.send({ embeds: [dmEmbed] });
                await interaction.message.delete().catch(() => {}); 
                
                if (!interaction.replied && !interaction.deferred) {
                    const jumpRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setLabel('➡️ Go to DMs')
                            .setStyle(ButtonStyle.Link)
                            .setURL(`https://discord.com/channels/@me/${dmChannel.id}`)
                    );

                    await interaction.reply({ 
                        content: '✅ Sent to your DMs! Click below to view it.', 
                        components: [jumpRow],
                        flags: MessageFlags.Ephemeral 
                    });
                }
            } catch (error) {
                try {
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({ content: '❌ I could not DM you! Please enable server DMs.', flags: MessageFlags.Ephemeral });
                    }
                } catch (fallbackError) {}
            }
        }

        if (action === 'retry') {
            if (interaction.user.id !== targetUserId) {
                return interaction.reply({ content: "❌ This isn't your bypass result!", flags: MessageFlags.Ephemeral });
            }
            
            const retryData = retryCache.get(shortId);
            if (!retryData) {
                 return interaction.reply({ content: '❌ This retry session has expired! Please paste your link again.', flags: MessageFlags.Ephemeral });
            }

            await interaction.message.delete().catch(() => {});
            processLinkBypass(retryData.url, interaction.user.id, interaction.guildId, interaction.channel, retryData.directReveal);
            return;
        }

        if (action === 'help') {
            if (interaction.user.id !== targetUserId) {
                return interaction.reply({ content: "❌ You cannot ask for help on someone else's failed link!", flags: MessageFlags.Ephemeral });
            }

            const supportChannelId = config[`support_${interaction.guildId}`];
            if (!supportChannelId) {
                return interaction.reply({ content: "❌ This server hasn't set up a support channel yet.", flags: MessageFlags.Ephemeral });
            }

            return interaction.reply({ 
                content: `🆘 **Need assistance?**\nHead over to <#${supportChannelId}> to open a ticket or ask the staff for help with your link!`, 
                flags: MessageFlags.Ephemeral 
            });
        }
    }
});

client.login(process.env.TOKEN);

// ==========================================
// KEEP-ALIVE SERVER (FOR WISPBYTE INTERFACES)
// ==========================================
const app = express();
const PORT = process.env.SERVER_PORT || process.env.PORT || 11830;

app.get('/', (req, res) => {
    res.send('NovaBypass Discord Bot is online and healthy! 🚀');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Keep-alive web server is listening on 0.0.0.0:${PORT}`);
});
