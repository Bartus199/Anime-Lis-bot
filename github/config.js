// --- CONFIGURATION FILE ---
// IMPORTANT: Do not hardcode your tokens here if you publish this file!
// Instead, use environment variables in production.

module.exports = {
    // 1. Bot Token: Get this from the Discord Developer Portal
    // (Replace the placeholder with your actual bot token, or use a .env file)
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || 'YOUR_DISCORD_BOT_TOKEN_HERE',
    
    // 2. Notification Channel ID: The channel where the bot will post activity updates
    // (Right-click the channel in Discord and select 'Copy Channel ID')
    NOTIFICATION_CHANNEL_ID: 'YOUR_NOTIFICATION_CHANNEL_ID_HERE', 
};