import { generateText, stepCountIs, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { readFileSync } from "node:fs";
const env={}; for(const l of readFileSync(new URL("../.env.local",import.meta.url),"utf8").split("\n")){const t=l.trim();if(!t||t.startsWith("#")||!t.includes("="))continue;const i=t.indexOf("=");env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
const p=createOpenAI({baseURL:"https://api.featherless.ai/v1",apiKey:env.FEATHERLESS_API_KEY});
const mk=(name)=>tool({description:`${name} returns structured card market data`,inputSchema:z.object({query:z.string().optional(),productId:z.number().optional()}),execute:async()=>({ok:true,name,rawMarket:1570,psa10:5225,gradeMultiple:3.33,liquidity:50})});
const tools=Object.fromEntries(["search_catalog","get_price_analytics","get_top_movers","get_grade_arbitrage","get_liquidity","get_creator_sentiment","recall_market_memory","refresh_live_intel"].map(n=>[n,mk(n)]));
async function run(label, opts){
  const t=Date.now();
  try{
    const r=await generateText({model:p.chat("Qwen/Qwen3-14B"),system:"You are a TCG market analyst. Use tools, never invent numbers."+(opts.noThink?" /no_think":""),prompt:"Should I submit Umbreon ex 161 to PSA 10?",tools,stopWhen:stepCountIs(6),maxOutputTokens:600,temperature:0.2,...(opts.providerOptions?{providerOptions:opts.providerOptions}:{})});
    console.log(`[${label}] ${Date.now()-t}ms steps=${r.steps?.length} -> ${(r.text||"").replace(/<think>[\s\S]*?<\/think>/g,'').trim().slice(0,140)}`);
  }catch(e){console.log(`[${label}] ERR ${Date.now()-t}ms ${e.message.slice(0,120)}`);}
}
await run("no_think in system", {noThink:true});
await run("chat_template enable_thinking=false", {providerOptions:{openai:{chat_template_kwargs:{enable_thinking:false}}}});
