import Service from './Service';
import {Reaction, LogMessateType} from '../Enums'
import {ScoreService}  from './ScoreService';
import {UserService} from './UserService';
import { toRank, toPoints, toReadableMinutes, toReadableTime, isTime, distBetween, splitTime } from '../Utils';
import DayStats from './DayStats';

export default class BetService implements Service{

    private bets : {};
    private scores : ScoreService;
    private nicknames : UserService
    private daystats : DayStats;

    constructor(private api : FacebookChatApi){
        this.bets = {};
        this.api = api;
        this.scores = new ScoreService();
        this.nicknames = new UserService(api);
        this.daystats = new DayStats();
    }
    
    public events(event : EventInfo) : any{
        if(event.logMessageType == LogMessateType.UserNickname){
            this.nicknames.updateUserNickname(event.threadID, event.logMessageData.participant_id, event.logMessageData.nickname);
        }
    }

    public reactions(reaction : MessageReactionInfo) : any{
        return {};
    }

    /**
     * list all the possible function that can be calle
     */
    public commands() : {[key : string] : (info : MessageInfo) => Promise<boolean>}{
        return {
                "start" : this.start,
                "begin" : this.start,
                "help" :  this.help,
                "finish" : this.finish,
                "stop" : this.finish,
                "end" : this.finish,
                "stats" : this.stats,
                "do" : this.doBet,
                "bet" : this.doBet,
                "scores" : this.palmares,
                "palmares" : this.palmares,
                "cancel" : this.cancel,
                "undo" : this.cancel,
                "default" : this.defaultBet,
                "total" : this.dayStats
            };
    }

    private sendMessage(str : string|SentMessage, threadId : string) : Promise<SentMessageInfo>{
        return new Promise(solver =>{
            return this.api.sendMessage(str, threadId,(err, info) => solver(info) ); 
        });
    }

    public async dayStats(message : MessageInfo) : Promise<boolean>{
        let totalTime = this.daystats.getTodaysTime(message.threadID);
        await this.sendMessage(`*Temps total : ${toReadableMinutes(totalTime)}*`, message.threadID);
        return true;
    }

    public async cancel(message : MessageInfo) : Promise<boolean>{
        delete this.bets[message.threadID];
        await this.sendMessage("Paris annulé", message.threadID);
        return true;
    }

    public async start(message : MessageInfo) : Promise<boolean>{
        let betState = this.bets[message.threadID];
        if(betState){
            await this.sendMessage("Les paris ont déjà commmencés !", message.threadID);
            return false;
        }

        var time = new Date();
        this.bets[message.threadID] =  {starting : time, players : {}, finished : false};
        
        //Notify everyone
        let users = await this.nicknames.getAllUsersInThread(message.threadID);
        let response = '(';
        let mentions : Mention[] = [];
        Object.keys(users).map(k => {
            let tag = '@' + users[k];
            mentions.push({tag : tag, id : k});
            response += tag + ' ';
        });
        response += ') *Les paris sont ouverts vous avez 2 minutes pour parier !*';


        await this.sendMessage({body : response, mentions : mentions}, message.threadID);
        setTimeout(() => {
            if(this.bets[message.threadID]){
                this.sendMessage("Fin des paris", message.threadID);
                this.bets[message.threadID].finished = true;
            }
        }, 2/*minutes*/ * 60/*seconds*/ * 1000/*ms*/);
        return true;
    }

    public async help(message) : Promise<boolean>{
        let helpMessage = `Gestionnaire de paris
Pariez avec la commande '/bet do {time}'
'Time' peut être le nombre de minutes depuis le lancement du paris
Ou une heure exacte (10h11) par ex.
Si le format du paris n'est pas bon, vous en êtes informés
Sinon, le bot mettra un pouce sur votre message pour indiquer
que le paris a bien été pris en compte`;
        await this.sendMessage(helpMessage, message.threadID);
        return true;
    }

    public async palmares(message) : Promise<boolean>{
        let scores = this.scores.getScores(message.threadID);

        let names = await this.nicknames.getUserNames(message.threadID, Object.keys(scores));
        let palmares = ["*Palmares :*", ...
            Object.keys(names)
            .map(k => ({name : names[k], score : scores[k]}))
            .sort((a,b) => b.score - a.score)
            .map((k,i) => `${toRank(i+1)}- ${k.name} (${toPoints(k.score)})`)
        ];
        await this.sendMessage(palmares.join("\n"), message.threadID);
        return true;
    }

    public async stats(message : MessageInfo) : Promise<boolean>{
        let betState = this.bets[message.threadID];
        if(!betState){
            await this.sendMessage("Les paris n'ont pas commencé", message.threadID);
            return false;
        } 
        
        let players = betState.players;
        if(players.length === 0){
            await this.sendMessage("Personne n'a parié", message.threadID);
            return true;
        }

        let stats = [`*Statistiques* : (${toReadableTime(betState.starting)})`, ...
            Object.keys(players)
                .map(p => ({id : p, name : players[p].name, bet : players[p].bet}))
                .sort((a,b) => distBetween(a.bet, betState.starting) - distBetween(b.bet, betState.starting) )
                .map(p => `${p.name} => ${toReadableTime(p.bet)}`)
        ];
        await this.sendMessage(stats.join('\n'), message.threadID);
        return true;
    }

    public async finish(message : MessageInfo) : Promise<boolean>{
        let betState = this.bets[message.threadID];
        delete this.bets[message.threadID];
        let endTime = new Date();
        if(!betState){
             await this.sendMessage("Les paris n'ont pas commencé", message.threadID);
             return true;
        }
        if(!betState.finished){//cancel
            await this.sendMessage("Paris finis avant la limite de 2 minutes, *annulé*", message.threadID);
            return true;
        }

        let mentions : Mention[] = [];
        let timeGap = new Date(endTime.getTime() - betState.starting.getTime());
        let formattedTime = toReadableMinutes(timeGap);

        let winners = [`*Résultats* (${toReadableTime(betState.starting)}-${toReadableTime(endTime)} : *${formattedTime}*):`,...        
            Object.keys(betState.players).map(k => {
                let data = betState.players[k];
                let tag = `@${data.name}`;
                mentions.push({tag : tag, id : k});
                return {id : k, 
                        name : data.name,
                        actionTime : data.actionTime,
                        bet : data.bet, 
                        distance : distBetween(data.bet, endTime)
                    };
            })
            .sort((a,b) => {
                let diff = a.distance - b.distance
                if(diff != 0)return diff;
                return a.actionTime > b.actionTime ? 1 : -1;
            })
            .map((p,i, arr) => {
                this.scores.incrementscore(message.threadID, p.id, arr.length - i);
                return `${toRank(i+1)}- @${p.name} (${toReadableTime(p.bet)}) : ${toPoints(arr.length - i)}`
            })
        ];
        this.daystats.addTime(message.threadID, timeGap);
        this.scores.flush();

        await this.sendMessage({body : winners.join('\n'), mentions : mentions}, message.threadID);

        return true;
    }

    public async defaultBet(message : MessageInfo) : Promise<boolean>{
        return await this.saveBet(message, message.body.split(' ')[1]);
    }

    public async doBet(message : MessageInfo) : Promise<boolean>{
        return await this.saveBet(message, message.body.split(' ')[2]);
    }

    private async saveBet(message : MessageInfo, bet : string) : Promise<boolean>{
        let betState = this.bets[message.threadID];
        if(!betState){
            this.sendMessage("Les paris ne sont pas ouverts!", message.threadID);
            return false;
        }
        if(betState.finished){
            this.sendMessage("Les paris sont terminés", message.threadID);
            return false;
        }

        let senderId = message.senderID;

        let betTime = new Date(betState.starting);
        if(isTime(bet)){
            let hm = splitTime(bet);
            betTime.setHours(hm[0], hm[1], 0, 0);
        }else{
            const numberRegex = /^\d+$/;
            let localTime = Number.parseInt(bet);
            if(!numberRegex.test(bet) || Number.isNaN(localTime) || !Number.isFinite(localTime) || localTime > (60 * 20)){
                await this.api.setMessageReaction(Reaction.Dislike, message.messageID);
                return false;
            }
            betTime = new Date(betTime.getTime() + localTime * 60000);
        }

        betState.players[senderId] = betState.players[senderId] || {};
        betState.players[senderId].bet = betTime;
        betState.players[senderId].actionTime = new Date();
        let s =  await this.nicknames.getUserName(message.threadID, message.senderID);
        betState.players[senderId].name = s;
        this.api.setMessageReaction(Reaction.Like, message.messageID);
        return true;
    }
}