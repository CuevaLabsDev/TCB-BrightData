import { generateText, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { readFileSync } from "node:fs";
const env={}; for(const l of readFileSync(new URL("../.env.local",import.meta.url),"utf8").split("\n")){const t=l.trim();if(!t||t.startsWith("#")||!t.includes("="))continue;const i=t.indexOf("=");env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
// import the REAL tools + prompt via tsx-free dynamic: replicate minimal by importing compiled? Instead use real registerable subset.
const p=createOpenAI({baseURL:"https://api.featherless.ai/v1",apiKey:env.FEATHERLESS_API_KEY});
// Build 8 dummy tools to test payload size effect
import { tool } from "ai"; import { z } from "zod";
const mk=(name)=>tool({description:`${name} does something with cards over the market data layers and returns structured info`,inputSchema:z.object({query:z.string().optional(),productId:z.number().optional(),period:z.enum(["7d","30d","90d","180d"]).optional()}),execute:async(a)=>{console.log("  RAN",name);return {ok:true,name};}});
const tools=Object.fromEntries(["search_catalog","get_price_analytics","get_top_movers","get_grade_arbitrage","get_liquidity","get_creator_sentiment","recall_market_memory","refresh_live_intel"].map(n=>[n,mk(n)]));
const t=Date.now();
try{
  const r=await generateText({model:p.chat("Qwen/Qwen3-14B"),system:"You are a TCG market analyst with 8 tools. Use them to answer with real data, never invent numbers.",prompt:"Should I submit Umbreon ex 161 to PSA 10?",tools,stopWhen:stepCountIs(6),maxOutputTokens:700,temperature:0.2});
  console.log(`8-tool generateText ${Date.now()-t}ms steps=${r.steps?.length} -> ${(r.text||"").slice(0,160)}`);
}catch(e){console.log(`ERR ${Date.now()-t}ms ${e.message.slice(0,160)}`);}
