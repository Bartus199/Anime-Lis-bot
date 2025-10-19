
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');
const fs = require('fs');

// Configuration constants loaded from config.js
const { DISCORD_BOT_TOKEN, NOTIFICATION_CHANNEL_ID } = require('./config');

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent 
    ]
});

// --- USER DATA MANAGEMENT ---
const USERS_FILE = 'users.json';
let anilistUsers = {}; 
let lastActivityId = {};

// Query to convert username to ID
const USER_ID_QUERY = `
    query ($username: String) { 
        User(name: $username) { 
            id 
            name
        } 
    }
`;

function saveUsers() {
    fs.writeFileSync(USERS_FILE, JSON.stringify(anilistUsers, null, 2), 'utf8');
}

async function loadUsers() {
    if (fs.existsSync(USERS_FILE)) {
        try {
            const rawUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            let convertedUsers = {};
            let requiresSave = false;
            
            for (const discordId in rawUsers) {
                const value = rawUsers[discordId];
                
                if (typeof value === 'string') {
                    console.log(`Converting old user data for: ${value}...`);
                    try {
                        const response = await axios.post('https://graphql.anilist.co/', {
                            query: USER_ID_QUERY, 
                            variables: { username: value }
                        });

                        const userData = response.data.data.User;
                        if (userData) {
                            convertedUsers[discordId] = { id: userData.id, name: userData.name };
                            requiresSave = true;
                        } else {
                            console.error(`AniList user not found: ${value}. Removed from list.`);
                        }
                    } catch (error) {
                        console.error(`API error during user conversion ${value}:`, error.message);
                    }
                } else if (value && typeof value === 'object' && value.id && value.name) {
                    convertedUsers[discordId] = value;
                }
            }

            anilistUsers = convertedUsers;
            if (requiresSave) {
                console.log("Saving updated users.json...");
                saveUsers();
            }
            console.log(`Loaded ${Object.keys(anilistUsers).length} users.`);
        } catch (error) {
            console.error("Error loading or converting users.json:", error);
            anilistUsers = {}; 
        }
    }
}

const statusMap = {
    'CURRENT': 'is currently watching 📺',
    'REPEATING': 'is rewatching 🔄',
    'COMPLETED': 'completed 🎉',
    'PAUSED': 'paused ⏸️',
    'DROPPED': 'dropped 🗑️',
    'PLANNING': 'is planning to watch/read 💡'
};


// --- ANI-LIST API (GraphQL) QUERIES ---

// Query for fetching latest activity
const ACTIVITY_QUERY = `query UserActivity($userId: Int) { 
    Page(perPage: 1) { 
        activities(
            userId: $userId, 
            sort: [ID_DESC], 
            type: MEDIA_LIST
        ) {
            ... on ListActivity {
                id
                status
                progress
                replyCount
                siteUrl
                createdAt
                media {
                    title {
                        romaji
                    }
                    type
                    siteUrl
                    coverImage {
                        large
                    }
                }
                user {
                    name
                }
            }
        }
    }
}
`;

// Query for fetching user statistics
const STATS_QUERY = `
query UserStats($username: String) {
    User(name: $username) {
        id
        name
        siteUrl
        avatar {
            large
        }
        statistics {
            anime {
                count
                episodesWatched
            }
            manga {
                count
                chaptersRead
            }
        }
    }
}
`;

function logAniListErrorDetails(error, username) {
    console.error(`Error fetching data for ${username}:`, error.message);
    if (error.response && error.response.data) {
        console.error("--- ANI-LIST ERROR DETAILS ---");
        console.error(JSON.stringify(error.response.data, null, 2));
        console.error("------------------------------");
    }
}

async function fetchAndPostActivity() {
    const userObjects = Object.values(anilistUsers);
    if (userObjects.length === 0) {
        console.log("No configured users to check.");
        return;
    }

    const channel = client.channels.cache.get(NOTIFICATION_CHANNEL_ID); 
    if (!channel) {
        console.error(`Channel ID not found: ${NOTIFICATION_CHANNEL_ID}`);
        return;
    }

    for (const user of userObjects) {
        const userId = user.id;
        const username = user.name; 

        try {
            const response = await axios.post('https://graphql.anilist.co/', {
                query: ACTIVITY_QUERY, 
                variables: { userId: userId }
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                }
            });

            const activityNode = response.data.data?.Page?.activities?.[0];
            
            if (!activityNode) {
                console.log(`No activity found for ${username}.`);
                continue;
            }

            const currentId = activityNode.id;

            if (lastActivityId[username] && lastActivityId[username] >= currentId) {
                console.log(`Activity for ${username} is already known (ID: ${currentId}).`);
                continue;
            }

            lastActivityId[username] = currentId;
            
            const mediaTitle = activityNode.media.title.romaji;
            const mediaType = activityNode.media.type === 'ANIME' ? 'Anime 🎬' : 'Manga 📖';
            const userStatus = statusMap[activityNode.status] || activityNode.status.toLowerCase();
            const date = new Date(activityNode.createdAt * 1000); 
            const formattedDate = date.toLocaleString('en-US', {
                year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });

            let description = `**${username}** ${userStatus} **${mediaTitle}**!`;
            
            if (activityNode.progress) {
                description += `\n**Progress**: ${activityNode.progress}`;
            }

            const embed = {
                color: activityNode.media.type === 'ANIME' ? 0x0099ff : 0xffa500,
                title: `${username} updated their progress in ${mediaType}`,
                url: activityNode.siteUrl,
                description: description,
                thumbnail: {
                    url: activityNode.media.coverImage?.large, 
                },
                timestamp: date.toISOString(),
                footer: {
                    text: `Posted: ${formattedDate}`
                }
            };
            
            await channel.send({ embeds: [embed] });
            console.log(`Posted new activity for ${username}.`);

        } catch (error) {
            logAniListErrorDetails(error, username);
        }
    }
}

async function fetchAndReplyUserStats(username, message, type) {
    try {
        const response = await axios.post('https://graphql.anilist.co/', {
            query: STATS_QUERY, 
            variables: { username: username }
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            }
        });

        const userData = response.data.data?.User;
        if (!userData || !userData.statistics) {
            return message.reply(`❌ Could not fetch stats for user **${username}**.`);
        }

        const animeStats = userData.statistics.anime;
        const mangaStats = userData.statistics.manga;
        
        let title = `📊 AniList Stats for ${username}`;
        let description = `[AniList Profile](${userData.siteUrl})\n\n`;
        let color = 0x008080; 

        if (type === 'anime' || type === 'both') {
            description += `**Anime 🎬**\n`;
            description += `• Titles Watched: **${animeStats.count}**\n`;
            description += `• Episodes Watched: **${animeStats.episodesWatched}**\n\n`;
            if (type === 'anime') color = 0x0099ff; 
        }

        if (type === 'manga' || type === 'both') {
            description += `**Manga 📖**\n`;
            description += `• Titles Read: **${mangaStats.count}**\n`;
            description += `• Chapters Read: **${mangaStats.chaptersRead}**\n\n`;
             if (type === 'manga') color = 0xffa500; 
        }
        
        if (type === 'both') {
             color = 0x4B0082; 
        }

        const embed = {
            color: color,
            title: title,
            description: description,
            thumbnail: {
                url: userData.avatar.large,
            },
            timestamp: new Date().toISOString()
        };

        await message.reply({ embeds: [embed] });

    } catch (error) {
        if (error.response && error.response.status === 404) {
             return message.reply(`❌ AniList user **${username}** not found.`);
        }
        logAniListErrorDetails(error, username);
        message.reply("An error occurred while fetching stats from AniList.");
    }
}

async function fetchAndPostTopStats(message, type) {
    const userObjects = Object.values(anilistUsers);
    if (userObjects.length === 0) {
        return message.reply("No configured users to create a ranking.");
    }

    const statsPromises = userObjects.map(user => 
        axios.post('https://graphql.anilist.co/', {
            query: STATS_QUERY, 
            variables: { username: user.name }
        }).catch(err => {
            console.error(`Error fetching top stats for ${user.name}:`, err.message);
            return null; 
        })
    );

    const responses = await Promise.all(statsPromises);
    
    const validStats = responses
        .map(res => res?.data?.data?.User)
        .filter(data => data && data.statistics)
        .map(data => ({
            name: data.name,
            count: type === 'anime' ? data.statistics.anime.count : data.statistics.manga.count,
            episodesOrChapters: type === 'anime' ? data.statistics.anime.episodesWatched : data.statistics.manga.chaptersRead,
            avatar: data.avatar.large
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10); 

    let title = type === 'anime' ? "🏆 TOP 10 ANIME WATCHERS" : "🏆 TOP 10 MANGA READERS";
    let description = "";
    
    validStats.forEach((stat, index) => {
        const rank = index + 1;
        const mediaType = type === 'anime' ? 'titles' : 'titles';
        const progressType = type === 'anime' ? 'episodes' : 'chapters';
        
        description += `**#${rank}** **${stat.name}**\n`;
        description += `> ${stat.count} ${mediaType} completed (${stat.episodesOrChapters} ${progressType})\n`;
    });
    
    if (description.length === 0) {
        description = "No available statistics for ranking.";
    }

    const embed = {
        color: type === 'anime' ? 0x0099ff : 0xffa500,
        title: title,
        description: description.substring(0, 4096),
        timestamp: new Date().toISOString()
    };
    
    await message.reply({ embeds: [embed] });
}


// --- DISCORD LOGIC ---

client.on('clientReady', async () => { 
    console.log(`Logged in as ${client.user.tag}!`);
    await loadUsers(); 
    
    fetchAndPostActivity(); 
    // Check activity every minute
    setInterval(fetchAndPostActivity, 60000); 
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const content = message.content.toLowerCase();
    const discordId = message.author.id;
    const anilistUser = anilistUsers[discordId]; 

    // 1. Link account: !anilist link <AniList_Username>
    if (content.startsWith('!anilist link ')) {
        const parts = message.content.split(/\s+/);
        if (parts.length !== 3) {
            return message.reply("Usage: `!anilist link <AniList_Username>`");
        }

        const usernameToLink = parts[2];
        
        // Prevent linking an AniList account that is already linked to another Discord account
        const users = Object.values(anilistUsers);
        const existingUser = users.find(user => 
            user.name.toLowerCase() === usernameToLink.toLowerCase() &&
            user.name.toLowerCase() !== (anilistUser?.name?.toLowerCase() ?? '') 
        );

        if (existingUser) {
            return message.reply(`🛑 The AniList account **${usernameToLink}** is already linked to another Discord account.`);
        }
        
        // Validation: check if the user exists on AniList and get ID
        axios.post('https://graphql.anilist.co/', {
            query: USER_ID_QUERY, 
            variables: { username: usernameToLink }
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            }
        }).then(response => {
            const userData = response.data.data.User;
            if (userData) {
                anilistUsers[discordId] = { id: userData.id, name: userData.name };
                saveUsers();
                message.reply(`✅ Successfully linked your Discord account with AniList account: **${userData.name}** (ID: ${userData.id})! Activity will be checked every minute.`);
            } else {
                message.reply(`❌ AniList user **${usernameToLink}** not found. Please try again.`);
            }
        }).catch(error => {
            message.reply("An error occurred while communicating with the AniList API.");
            logAniListErrorDetails(error, usernameToLink);
        });
        return;
    }
    
    // 2. Unlink account: !anilist unlink OR !unlink
    if (content === '!anilist unlink' || content === '!unlink') {
        if (anilistUser) {
            delete lastActivityId[anilistUser.name]; 
            delete anilistUsers[discordId];
            saveUsers();
            message.reply(`🗑️ Successfully unlinked your AniList account (${anilistUser.name}).`);
        } else {
            message.reply("You do not have a linked AniList account.");
        }
        return;
    }

    // 3. Personal Stats: !myanime, !mymanga, !profile
    if (content.startsWith('!myanime') || content.startsWith('!mymanga') || content.startsWith('!profile')) {
        
        let targetUsername;
        let type;
        const args = message.content.split(/\s+/).slice(1);
        
        if (content.startsWith('!myanime')) {
            type = 'anime';
        } else if (content.startsWith('!mymanga')) {
            type = 'manga';
        } else {
            type = 'both'; // for !profile
        }
        
        if (args.length === 0) {
            // No argument: Use own linked account
            if (!anilistUser) {
                return message.reply("To see your stats, please link your account using `!anilist link <AniList_Username>` first.");
            }
            targetUsername = anilistUser.name;
        } else if (args.length === 1 && message.mentions.users.size === 1) {
            // Mention (@): Use linked account of the mentioned user
            const mentionedUser = message.mentions.users.first();
            const mentionedAnilistUser = anilistUsers[mentionedUser.id];
            
            if (!mentionedAnilistUser) {
                return message.reply(`User **${mentionedUser.username}** does not have a linked AniList account.`);
            }
            targetUsername = mentionedAnilistUser.name;

        } else if (args.length === 1) {
            // Direct AniList Username
            targetUsername = args[0];
            
        } else {
            return message.reply(`Usage: \`!profile\` or \`!profile <@mention>\` or \`!profile <AniList_Username>\``);
        }
        
        await fetchAndReplyUserStats(targetUsername, message, type);
        return;
    }

    // 4. Ranking Commands: !topanime, !topmanga
    if (content === '!topanime' || content === '!topmanga') {
        const type = content === '!topanime' ? 'anime' : 'manga';
        await fetchAndPostTopStats(message, type);
        return;
    }

    // 5. List Connected Accounts: !stats
    if (content === '!stats') {
        const connectedUsers = Object.keys(anilistUsers);
        
        if (connectedUsers.length === 0) {
            return message.reply("No users currently have linked AniList accounts.");
        }
        
        const userList = connectedUsers.map(id => {
            const member = message.guild?.members.cache.get(id);
            const tag = member ? member.user.tag : 'Unknown User';
            
            return `**${tag}** → \`${anilistUsers[id].name}\` (ID: ${anilistUsers[id].id})`;
        }).join('\n');
        
        const statsEmbed = {
            color: 0x4B0082,
            title: `📊 Connected AniList Accounts (${connectedUsers.length})`,
            description: userList,
            footer: {
                text: "Use !anilist link <name> to join."
            },
            timestamp: new Date().toISOString()
        };
        
        await message.reply({ embeds: [statsEmbed] });
        return;
    }
    
    // 6. Help Command: !anihelp or !anilist help
    if (content === '!anihelp' || content === '!anilist help') {
        const helpEmbed = {
            color: 0x00CED1,
            title: '📜 AniList Bot Commands',
            description: 'Use the commands below to manage your AniList account and check stats.',
            fields: [
                {
                    name: '🔗 Account Management',
                    value: '`!anilist link <AniList_Username>`: Links your Discord account to AniList. \n`!anilist unlink` or `!unlink`: Unlinks your connected account.',
                    inline: false,
                },
                {
                    name: '👤 Personal Stats (You or Mention)',
                    value: '`!profile` or `!profile @mention`: Displays full profile (Anime + Manga).\n`!myanime` or `!myanime @mention`: Displays Anime stats.\n`!mymanga` or `!mymanga @mention`: Displays Manga stats.',
                    inline: false,
                },
                {
                    name: '📊 Leaderboards and List',
                    value: '`!topanime`: Displays the TOP 10 users with the most completed Anime.\n`!topmanga`: Displays the TOP 10 users with the most completed Manga.\n`!stats`: Lists all connected Discord accounts with their AniList names.',
                    inline: false,
                },
                {
                    name: '❓ Help',
                    value: '`!anihelp` or `!anilist help`: Displays this command list.',
                    inline: false,
                },
            ],
            footer: {
                text: `Activity is being tracked on channel ID: ${NOTIFICATION_CHANNEL_ID}`
            },
            timestamp: new Date().toISOString()
        };
        
        await message.reply({ embeds: [helpEmbed] });
        return;
    }
});

client.login(DISCORD_BOT_TOKEN).catch(err => {
    console.error("Login failed. Check if DISCORD_BOT_TOKEN is correct:", err);
});