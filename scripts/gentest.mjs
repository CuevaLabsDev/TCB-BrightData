import { generateText, tool, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { readFileSync } from "node:fs";
const env={}; for(const l of readFileSync(new URL("../.env.local",import.meta.url),"utf8").split("\n")){const t=l.trim();if(!t||t.startsWith("#")||!t.includes("="))continue;const i=t.indexOf("=");env[t.slice(0,i).trim()]=t.slice(i+1).trim();}
const p=createOpenAI({baseURL:"https://api.featherless.ai/v1",apiKey:env.FEATHERLESS_API_KEY});
async function run(model){
  let toolRan=false; const t=Date.now();
  try{
    const r=await generateText({
      model:p.chat(model),
      system:"You are a TCG analyst. Use tools to get data, then answer.",
      prompt:"Should I submit Umbreon ex 161 to PSA 10? Give the multiple.",
      tools:{ get_grade_arbitrage: tool({description:"raw vs PSA10 multiple",inputSchema:z.object({query:z.string()}),execute:async({query})=>{toolRan=true;return {card:"Umbreon ex 161",rawMarket:1570,psa10:5225,gradeMultiple:3.33};}}) },
      stopWhen:stepCountIs(5), maxOutputTokens:400, temperature:0.2,
    });
    console.log(`[${model}] ${Date.now()-t}ms toolRan=${toolRan} steps=${r.steps?.length} -> ${(r.text||"").slice(0,180)}`);
  }catch(e){console.log(`[${model}] ERR ${Date.now()-t}ms ${e.message.slice(0,120)}`);}
}
await run("Qwen/Qwen3-14B");
