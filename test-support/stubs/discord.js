function chain(name){ const data={__type:name, calls:[]}; const p=new Proxy(data,{get(t,k){ if(k==='then') return undefined; if(k in t) return t[k]; if(k==='toJSON') return ()=>({name:(t.calls.find(c=>c[0]==='setName')||[])[1]?.[0]}); if(k==='data') return t; return (...a)=>{ t.calls.push([k,a]); for(const x of a) if(typeof x==='function') x(chain('opt')); return p; }; }}); return p; }
class B { constructor(){ return chain(this.constructor.name); } }
class SlashCommandBuilder extends B{} class EmbedBuilder extends B{} class ButtonBuilder extends B{} class ActionRowBuilder extends B{} class StringSelectMenuBuilder extends B{}
class REST { setToken(){return this} async put(){return []} }
module.exports={SlashCommandBuilder,EmbedBuilder,ButtonBuilder,ActionRowBuilder,StringSelectMenuBuilder,REST,Routes:{applicationCommands:()=>'',applicationGuildCommands:()=>''},ButtonStyle:{Primary:1,Secondary:2,Success:3,Danger:4},MessageFlags:{Ephemeral:64},PermissionFlagsBits:{ManageGuild:32n}};
