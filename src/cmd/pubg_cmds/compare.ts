import { DiscordClientWrapper } from '../../DiscordClientWrapper';
import * as Discord from 'discord.js';
import { CommonService as cs } from '../../services/common.service';
import {
    SqlServerService as sqlServerService,
    SqlUserRegisteryService as sqlUserRegisteryService
} from '../../services/sql-services/sql.module';
import { Command, CommandConfiguration, CommandHelp } from '../../models/models.module';
import { PubgService as pubgApiService } from '../../services/pubg.api.service';
import { PubgAPI, PlatformRegion, PlayerSeason, Player, GameModeStats } from 'pubg-typescript-api';
import { AnalyticsService as mixpanel } from '../../services/analytics.service';
import Jimp = require('jimp');
import { ImageService as imageService } from '../../services/image.service';


interface ParameterMap {
    playerA: string;
    playerB: string;
    season: string;
    region: string;
    mode: string;
}

export class Compare extends Command {

    conf: CommandConfiguration = {
        enabled: true,
        guildOnly: false,
        aliases: [],
        permLevel: 0
    };

    help: CommandHelp = {
        name: 'compare',
        description: 'Compares two players',
        usage: '<prefix>compare <player-one> <player-two> [season=] [region=] [mode=]',
        examples: [
            '!pubg-compare jane       (only valid if you have used the `register` command)',
            '!pubg-compare john jane',
            '!pubg-compare john jane season=2018-03',
            '!pubg-compare john jane season=2018-03 region=pc-eu',
            '!pubg-compare john jane season=2018-03 region=na mode=solo',
            '!pubg-compare john jane region=as mode=tpp season=2018-03',
        ]
    };

    private paramMap: ParameterMap;

    public async run(bot: DiscordClientWrapper, msg: Discord.Message, params: string[], perms: number) {
        const originalPoster: Discord.User = msg.author;

        try {
            this.paramMap = await this.getParameters(msg, params);
        } catch(e) {
            return;
        }

        const checkingParametersMsg: Discord.Message = (await msg.channel.send('Checking for valid parameters ...')) as Discord.Message;
        const isValidParameters = await pubgApiService.validateParameters(msg, this.help, this.paramMap.season, this.paramMap.region, this.paramMap.mode);
        if(!isValidParameters) {
            checkingParametersMsg.delete();
            return;
        }

        const message: Discord.Message = await checkingParametersMsg.edit(`Getting data for \`${this.paramMap.playerA}\` and \`${this.paramMap.playerB}\``);
        const api: PubgAPI = new PubgAPI(cs.getEnvironmentVariable('pubg_api_key'), PlatformRegion[this.paramMap.region]);
        const players: Player[] = await pubgApiService.getPlayerByName(api, [this.paramMap.playerA, this.paramMap.playerB]);
        const playerA: Player = players.find(p => p.name === this.paramMap.playerA);
        const playerB: Player = players.find(p => p.name === this.paramMap.playerB);

        if (!playerA || !playerA.id) {
            message.edit(`Could not find \`${this.paramMap.playerA}\` on the \`${this.paramMap.region}\`-- double check the usernames and region.`);
            return;
        }
        if (!playerB || !playerB.id) {
            message.edit(`Could not find \`${this.paramMap.playerB}\` on the \`${this.paramMap.region}\` -- double check the usernames and region.`);
            return;
        }


        // Get Player Data
        let seasonDataA: PlayerSeason;
        let seasonDataB: PlayerSeason;
        try {
            seasonDataA = await pubgApiService.getPlayerSeasonStatsById(api, playerA.id, this.paramMap.season);
        } catch(e) {
            message.edit(`Could not find \`${this.paramMap.playerA}\`'s \`${this.paramMap.season}\` stats.`);
            return;
        }
        try {
            seasonDataB = await pubgApiService.getPlayerSeasonStatsById(api, playerB.id, this.paramMap.season);
        } catch(e) {
            message.edit(`Could not find \`${this.paramMap.playerB}\`'s \`${this.paramMap.season}\` stats.`);
            return;
        }


        let attatchment: Discord.Attachment = await this.addDefaultImageStats(seasonDataA, seasonDataB);
        let imgMsg = await message.channel.send(attatchment) as Discord.Message;
        this.setupReactions(imgMsg, originalPoster, seasonDataA, seasonDataB);
    };

    /**
     * Retrieves the paramters for the command
     * @param {Discord.Message} msg
     * @param {string[]} params
     * @returns {Promise<ParameterMap>}
     */
    private async getParameters(msg: Discord.Message, params: string[]): Promise<ParameterMap> {
        let paramMap: ParameterMap;
        let playerA: string;
        let playerB: string;

        let getFromRegistery: boolean = false;
        if (params[1] && !cs.stringContains(params[1], '=')) {
            playerB = params[1];
        } else {
            getFromRegistery = true;
            playerB = params[0];
        }

        if (getFromRegistery) {
            playerA = await sqlUserRegisteryService.getRegisteredUser(msg.author.id);
        } else {
            playerA = params[0];
        }

        // Throw error if no username supplied
        if(!playerA || !playerB) {
            cs.handleError(msg, 'Error:: Must specify two usernames or register with `register` command and supply one', this.help);
            throw 'Error:: Must specify a username';
        }

        if (msg.guild) {
            const serverDefaults = await sqlServerService.getServerDefaults(msg.guild.id);
            paramMap = {
                playerA: playerA,
                playerB: playerB,
                season: cs.getParamValue('season=', params, serverDefaults.default_season),
                region: cs.getParamValue('region=', params, serverDefaults.default_region).toUpperCase().replace('-', '_'),
                mode: cs.getParamValue('mode=', params, serverDefaults.default_mode).toUpperCase().replace('-', '_')
            }
        } else {
            const currentSeason: string = (await pubgApiService.getCurrentSeason(new PubgAPI(cs.getEnvironmentVariable('pubg_api_key'), PlatformRegion.PC_NA))).id.split('division.bro.official.')[1];
            paramMap = {
                playerA: playerA,
                playerB: playerB,
                season: cs.getParamValue('season=', params, currentSeason),
                region: cs.getParamValue('region=', params, 'pc_na').toUpperCase().replace('-', '_'),
                mode: cs.getParamValue('mode=', params, 'solo_fpp').toUpperCase().replace('-', '_')
            }
        }

        mixpanel.track(this.help.name, {
            distinct_id: msg.author.id,
            discord_id: msg.author.id,
            discord_username: msg.author.tag,
            number_parameters: params.length,
            pubg_name_a: paramMap.playerA,
            pubg_name_b: paramMap.playerB,
            season: paramMap.season,
            region: paramMap.region,
            mode: paramMap.mode,
        });

        return paramMap;
    }

    private async addDefaultImageStats(seasonDataA: PlayerSeason, seasonDataB: PlayerSeason): Promise<Discord.Attachment> {
        let mode = this.paramMap.mode;

        if (cs.stringContains(mode, 'solo', true)) {
            return await this.createImage(seasonDataA.soloFPPStats, seasonDataA.soloStats, seasonDataB.soloFPPStats, seasonDataB.soloStats, 'Solo');
        } else if (cs.stringContains(mode, 'duo', true)) {
            return await this.createImage(seasonDataA.duoFPPStats, seasonDataA.duoStats, seasonDataB.duoFPPStats, seasonDataB.duoStats, 'Duo');
        } else if (cs.stringContains(mode, 'squad', true)) {
            return await this.createImage(seasonDataA.squadFPPStats, seasonDataA.squadStats, seasonDataB.squadFPPStats, seasonDataB.squadStats, 'Squad');
        }
    }

    /**
     * Adds reaction collectors and filters to make interactive messages
     * @param {Discord.Message} msg
     * @param {Discord.User} originalPoster
     * @param {PlayerSeason} seasonData
     */
    private async setupReactions(msg: Discord.Message, originalPoster: Discord.User, seasonDataA: PlayerSeason, seasonDataB: PlayerSeason): Promise<void> {
        const reaction_numbers = ["\u0030\u20E3","\u0031\u20E3","\u0032\u20E3","\u0033\u20E3","\u0034\u20E3","\u0035\u20E3", "\u0036\u20E3","\u0037\u20E3","\u0038\u20E3","\u0039\u20E3"]
        await msg.react(reaction_numbers[1]);
        await msg.react(reaction_numbers[2]);
        await msg.react(reaction_numbers[4]);

        const one_filter: Discord.CollectorFilter = (reaction, user) => reaction.emoji.name === reaction_numbers[1] && originalPoster.id === user.id;
        const two_filter: Discord.CollectorFilter = (reaction, user) =>  reaction.emoji.name === reaction_numbers[2] && originalPoster.id === user.id;
        const four_filter: Discord.CollectorFilter = (reaction, user) => reaction.emoji.name === reaction_numbers[4] && originalPoster.id === user.id;

        const one_collector: Discord.ReactionCollector = msg.createReactionCollector(one_filter, { time: 15*1000 });
        const two_collector: Discord.ReactionCollector = msg.createReactionCollector(two_filter, { time: 15*1000 });
        const four_collector: Discord.ReactionCollector = msg.createReactionCollector(four_filter, { time: 15*1000 });

        one_collector.on('collect', async (reaction: Discord.MessageReaction, reactionCollector: Discord.Collector<string, Discord.MessageReaction>) => {
            mixpanel.track(`${this.help.name} - Click 1`, {
                pubg_name_a: this.paramMap.playerA,
                pubg_name_b: this.paramMap.playerB,
                season: this.paramMap.season,
                region: this.paramMap.region,
                mode: this.paramMap.mode,
            });

            await reaction.remove(originalPoster).catch(async (err) => {
                if(!msg.guild) { return; }
                //warningMessage = ':warning: Bot is missing the `Text Permissions > Manage Messages` permission. Give permission for the best experience. :warning:';
            });

            let attatchment: Discord.Attachment = await this.createImage(seasonDataA.soloFPPStats, seasonDataA.soloStats, seasonDataB.soloFPPStats, seasonDataB.soloStats, 'Solo');

            if(msg.deletable) {
                one_collector.removeAllListeners();
                await msg.delete();
            }

            let newMsg = await msg.channel.send(attatchment) as Discord.Message;
            this.setupReactions(newMsg, originalPoster, seasonDataA, seasonDataB);

        });
        two_collector.on('collect', async (reaction: Discord.MessageReaction, reactionCollector: Discord.Collector<string, Discord.MessageReaction>) => {
            mixpanel.track(`${this.help.name} - Click 2`, {
                pubg_name_a: this.paramMap.playerA,
                pubg_name_b: this.paramMap.playerB,
                season: this.paramMap.season,
                region: this.paramMap.region,
                mode: this.paramMap.mode
            });

            await reaction.remove(originalPoster).catch(async (err) => {
                if(!msg.guild) { return; }
                //warningMessage = ':warning: Bot is missing the `Text Permissions > Manage Messages` permission. Give permission for the best experience. :warning:';
            });

            let attatchment: Discord.Attachment = await this.createImage(seasonDataA.duoFPPStats, seasonDataA.duoStats, seasonDataB.duoFPPStats, seasonDataB.duoStats, 'Duo');

            if(msg.deletable) {
                two_collector.removeAllListeners();
                await msg.delete();
            }

            let newMsg = await msg.channel.send(attatchment) as Discord.Message;
            this.setupReactions(newMsg, originalPoster, seasonDataA, seasonDataB);

        });
        four_collector.on('collect', async (reaction: Discord.MessageReaction, reactionCollector: Discord.Collector<string, Discord.MessageReaction>) => {
            mixpanel.track(`${this.help.name} - Click 4`, {
                pubg_name_a: this.paramMap.playerA,
                pubg_name_b: this.paramMap.playerB,
                season: this.paramMap.season,
                region: this.paramMap.region,
                mode: this.paramMap.mode
            });

            await reaction.remove(originalPoster).catch(async (err) => {
                if(!msg.guild) { return; }
                //warningMessage = ':warning: Bot is missing the `Text Permissions > Manage Messages` permission. Give permission for the best experience. :warning:';
            });

            let attatchment: Discord.Attachment = await this.createImage(seasonDataA.squadFPPStats, seasonDataA.squadStats, seasonDataB.squadFPPStats, seasonDataB.squadStats, 'Squad');

            if(msg.deletable) {
                four_collector.removeAllListeners();
                await msg.delete();
            }

            let newMsg = await msg.channel.send(attatchment) as Discord.Message;
            this.setupReactions(newMsg, originalPoster, seasonDataA, seasonDataB);

        });

        one_collector.on('end', collected => { msg.clearReactions().catch(() => {}); });
        two_collector.on('end', collected => { msg.clearReactions().catch(() => {}); });
        four_collector.on('end', collected => { msg.clearReactions().catch(() => {}); });
    }

    private async createImage(fppStats_A: GameModeStats, tppStats_A: GameModeStats, fppStats_B: GameModeStats, tppStats_B: GameModeStats, mode: string): Promise<Discord.Attachment> {
        let baseHeaderImg: Jimp = await imageService.loadImage('./assets/rank/Black_1050_130.png');
        let baseImg: Jimp = await imageService.loadImage('./assets/rank/Body.png');

        const baseImageWidth = baseImg.getWidth();
        const baseImageHeight = baseImg.getHeight();

        // Create parts of final image
        const headerImg: Jimp = await this.addHeaderImageText(baseHeaderImg.clone());
        let fppStatsImage: Jimp;
        let tppStatsImage: Jimp;
        if (fppStats_A.roundsPlayed > 0 || fppStats_B.roundsPlayed > 0) {
            fppStatsImage = await this.addBodyTextToImage(baseImg.clone(), fppStats_A, fppStats_B, `${mode} FPP`);
        }
        if (tppStats_A.roundsPlayed > 0 || tppStats_B.roundsPlayed > 0) {
            tppStatsImage = await this.addBodyTextToImage(baseImg.clone(), tppStats_A, tppStats_B, `${mode}`);
        }

        // Merge parts together
        let image: Jimp = headerImg.clone();
        let heightTally = image.getHeight();
        if (fppStatsImage) {
            const newHeight = heightTally + baseImageHeight;
            let newCanvas = new Jimp(baseImageWidth, newHeight);
            newCanvas.composite(image, 0, 0);

            image = newCanvas.composite(fppStatsImage, 0, heightTally);
            heightTally = image.getHeight();
        }
        if (tppStatsImage) {
            const newHeight = heightTally + baseImageHeight;
            let newCanvas = new Jimp(baseImageWidth, newHeight);
            newCanvas.composite(image, 0, 0);

            image = newCanvas.composite(tppStatsImage, 0, heightTally);
            heightTally = image.getHeight();
        }

        // Create/Merge error message
        if(!fppStatsImage && !tppStatsImage) {
            const errMessageImage: Jimp = await this.addNoMatchesPlayedText(baseHeaderImg.clone(), mode);
            image = imageService.combineImagesVertically(image ,errMessageImage);
        }

        const imageBuffer: Buffer = await image.getBufferAsync(Jimp.MIME_PNG);
        return new Discord.Attachment(imageBuffer);
    }

    private async addNoMatchesPlayedText(img: Jimp, mode: string): Promise<Jimp> {
        const textObj: any = {
            text: '',
            alingmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
            alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE
        }
        const font_32: Jimp.Font = await imageService.loadFont('./assets/font/Teko/regular/white/Teko-White-32.fnt');

        textObj.text = `Players havn\'t played "${mode}" games this season`;
        const textWidth = Jimp.measureText(font_32, textObj.text);
        img.print(font_32, (img.getWidth()/2)-(textWidth/2), img.getHeight()/2 - 15, textObj);

        return img;
    }

    private async addHeaderImageText(img: Jimp): Promise<Jimp> {
        const imageWidth: number = img.getWidth();
        const textObj: any = {
            text: '',
            alingmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
            alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE
        }

        const font_bold_52: Jimp.Font = await imageService.loadFont('./assets/font/Teko/bold/white/Teko-White-52.fnt');
        const font_bold_48: Jimp.Font = await imageService.loadFont('./assets/font/Teko/bold/white/Teko-White-48.fnt');
        const font_bold_42: Jimp.Font = await imageService.loadFont('./assets/font/Teko/bold/white/Teko-White-42.fnt');

        const api: PubgAPI = new PubgAPI(cs.getEnvironmentVariable('pubg_api_key'), PlatformRegion[this.paramMap.region]);
        const seasonDisplayName: string = await pubgApiService.getSeasonDisplayName(api, this.paramMap.season);
        const regionDisplayName: string = this.paramMap.region.toUpperCase().replace('_', '-');
        let textWidth: number;

        textObj.text = `${this.paramMap.playerA} vs (${this.paramMap.playerB})`;
        textWidth = Jimp.measureText(font_bold_52, textObj.text);

        let username_font: Jimp.Font = font_bold_52;
        let username_height: number = 35;
        if(textWidth > 755) {
            username_font = font_bold_42
            username_height = 40;
        }

        img.print(username_font, 30, username_height, textObj);

        textObj.text = regionDisplayName;
        textWidth = Jimp.measureText(font_bold_48, textObj.text);
        img.print(font_bold_48, imageWidth-textWidth-25, 10, textObj);

        textObj.text = seasonDisplayName;
        textWidth = Jimp.measureText(font_bold_48, textObj.text);
        img.print(font_bold_48, imageWidth-textWidth-25, 60, textObj);

        return img;
    }

    private async addBodyTextToImage(img: Jimp, stats_A: GameModeStats, stats_B: GameModeStats, mode: string): Promise<Jimp> {
        const imageWidth: number = img.getWidth();
        const textObj: any = {
            text: '',
            alingmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
            alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE
        }
        const font_48_white: Jimp.Font =  await imageService.loadFont('./assets/font/Teko/regular/white/Teko-White-36.fnt');
        const font_48_orange: Jimp.Font = await imageService.loadFont('./assets/font/Teko/bold/orange/Teko-Orange-30.fnt');
        let textWidth: number;

        const body_subheading_x: number = 50;
        const body_subheading_y: number = 10;
        const body_top_y: number = 95;
        const body_mid_y: number = 255;
        const body_bottom_y: number = 405;

        let formatted_stats_A = {
            overallRating: cs.round(pubgApiService.calculateOverallRating(stats_A.winPoints, stats_A.killPoints), 0) || 'NA',
            wins: stats_A.wins,
            top10s: stats_A.top10s,
            roundsPlayed: stats_A.roundsPlayed,
            kd: cs.round(stats_A.kills / stats_A.losses) || 0,
            kda: cs.round((stats_A.kills + stats_A.assists) / stats_A.losses) || 0,
            winPercent: cs.getPercentFromFraction(stats_A.wins, stats_A.roundsPlayed),
            topTenPercent: cs.getPercentFromFraction(stats_A.top10s, stats_A.roundsPlayed),
            averageDamageDealt: cs.round(stats_A.damageDealt / stats_A.roundsPlayed) || 0,
            kills: `${stats_A.kills}`,
            assists: `${stats_A.assists}`,
            dBNOs: `${stats_A.dBNOs}`,
            longestKill: `${stats_A.longestKill.toFixed(2)}m`,
            headshotKills: `${stats_A.headshotKills}`
        }

        let formatted_stats_B = {
            overallRating: cs.round(pubgApiService.calculateOverallRating(stats_B.winPoints, stats_B.killPoints), 0) || 'NA',
            wins: stats_B.wins,
            top10s: stats_B.top10s,
            roundsPlayed: stats_B.roundsPlayed,
            kd: cs.round(stats_B.kills / stats_B.losses) || 0,
            kda: cs.round((stats_B.kills + stats_B.assists) / stats_B.losses) || 0,
            winPercent: cs.getPercentFromFraction(stats_B.wins, stats_B.roundsPlayed),
            topTenPercent: cs.getPercentFromFraction(stats_B.top10s, stats_B.roundsPlayed),
            averageDamageDealt: cs.round(stats_B.damageDealt / stats_B.roundsPlayed) || 0,
            kills: `${stats_B.kills}`,
            assists: `${stats_B.assists}`,
            dBNOs: `${stats_B.dBNOs}`,
            longestKill: `${stats_B.longestKill.toFixed(2)}m`,
            headshotKills: `${stats_B.headshotKills}`
        }

        let x_centers : any = {
            kd: 160,
            winPercent: 376,
            topTenPercent: 605,
            averageDamageDealt: 841,
            kda: 162.5,
            kills: 367.5,
            assists: 605,
            dBNOs: 846.5,
            longestKill: 311,
            headshotKills: 726.5
        }

        // Sub Heading
        textObj.text = `${mode} - ${formatted_stats_A.overallRating} (${formatted_stats_B.overallRating})`;
        textWidth = Jimp.measureText(font_48_white, textObj.text);
        img.print(font_48_white, body_subheading_x+10, body_subheading_y, textObj);

        textObj.text = `${formatted_stats_A.wins} (${formatted_stats_B.wins})`;
        textWidth = Jimp.measureText(font_48_white, textObj.text);
        img.print(font_48_white, 440-textWidth-5, body_subheading_y, textObj);

        textObj.text = `${formatted_stats_A.top10s} (${formatted_stats_B.top10s})`;
        textWidth = Jimp.measureText(font_48_white, textObj.text);
        img.print(font_48_white, 680-textWidth-5, body_subheading_y, textObj);

        textObj.text = `${formatted_stats_A.roundsPlayed} (${formatted_stats_B.roundsPlayed})`;
        textWidth = Jimp.measureText(font_48_white, textObj.text);
        img.print(font_48_white, imageWidth-textWidth-180, body_subheading_y, textObj);

        // Body - Top
        textObj.text = `${formatted_stats_A.kd} (${formatted_stats_B.kd})`;
        textWidth = Jimp.measureText(font_48_orange, textObj.text);
        img.print(font_48_orange, x_centers.kd-(textWidth/2), body_top_y, textObj);

        textObj.text = `${formatted_stats_A.winPercent} (${formatted_stats_B.winPercent})`;
        textWidth = Jimp.measureText(font_48_orange, textObj.text);
        img.print(font_48_orange, x_centers.winPercent-(textWidth/2), body_top_y, textObj);

        textObj.text = `${formatted_stats_A.topTenPercent} (${formatted_stats_B.topTenPercent})`;
        textWidth = Jimp.measureText(font_48_orange, textObj.text);
        img.print(font_48_orange, x_centers.topTenPercent-(textWidth/2), body_top_y, textObj);

        textObj.text = `${formatted_stats_A.averageDamageDealt} (${formatted_stats_B.averageDamageDealt})`;;
        textWidth = Jimp.measureText(font_48_orange, textObj.text);
        img.print(font_48_orange, x_centers.averageDamageDealt-(textWidth/2), body_top_y, textObj);

        // Body - Middle
        textObj.text = `${formatted_stats_A.kda} (${formatted_stats_B.kda})`;
        textWidth = Jimp.measureText(font_48_orange, textObj.text);
        img.print(font_48_orange, x_centers.kda-(textWidth/2), body_mid_y, textObj);

        textObj.text = `${formatted_stats_A.kills} (${formatted_stats_B.kills})`;
        textWidth = Jimp.measureText(font_48_orange, textObj.text);
        img.print(font_48_orange, x_centers.kills-(textWidth/2), body_mid_y, textObj);

        textObj.text = `${formatted_stats_A.assists} (${formatted_stats_B.assists})`;
        textWidth = Jimp.measureText(font_48_orange, textObj.text);
        img.print(font_48_orange, x_centers.assists-(textWidth/2), body_mid_y, textObj);

        textObj.text = `${formatted_stats_A.dBNOs} (${formatted_stats_B.dBNOs})`;
        textWidth = Jimp.measureText(font_48_orange, textObj.text);
        img.print(font_48_orange, x_centers.dBNOs-(textWidth/2), body_mid_y, textObj);

        // Body - Bottom
        textObj.text = `${formatted_stats_A.longestKill} (${formatted_stats_B.longestKill})`;
        textWidth = Jimp.measureText(font_48_orange, textObj.text);
        img.print(font_48_orange, x_centers.longestKill-(textWidth/2), body_bottom_y, textObj);

        textObj.text = `${formatted_stats_A.headshotKills} (${formatted_stats_B.headshotKills})`;
        textWidth = Jimp.measureText(font_48_orange, textObj.text);
        img.print(font_48_orange, x_centers.headshotKills-(textWidth/2), body_bottom_y, textObj);

        return img;
    }
}
