'use strict';
// Offline actual-source helper diagnostics. No environment access, imports of
// application/service code, networking, generation, rendering, upload or posting.
const fs = require('node:fs');
const vm = require('node:vm');
const sourcePath = '/home/ubuntu/yfit-app-full/supabase/functions/generate-social-content/index.ts';
const source = fs.readFileSync(sourcePath, 'utf8');
const saveStart = source.indexOf('async function saveToDatabase(');
const webhookStart = source.indexOf('async function triggerN8nWebhook(');
const webhookEnd = source.indexOf('// ─── Main handler', webhookStart);
if (saveStart < 0 || webhookStart < 0 || webhookEnd < 0) throw new Error('Helper boundaries changed');
const save = source.slice(saveStart, webhookStart).replace(
  /async function saveToDatabase\([\s\S]*?\): Promise<void> \{/,
  'async function saveToDatabase(runDate, articleTitle, articleUrl, contentItems) {'
);
const webhook = source.slice(webhookStart, webhookEnd).replace(
  'async function triggerN8nWebhook(payload: object): Promise<void> {',
  'async function triggerN8nWebhook(payload) {'
);
const items = [{platform:'tiktok',caption:'synthetic caption',script:'synthetic script',hashtags:['synthetic'],title:'synthetic'}];
async function run() {
  const evidence = [];
  let calls = 0;
  const dbContext = vm.createContext({
    SUPABASE_URL:'https://synthetic.invalid',
    SUPABASE_SERVICE_ROLE_KEY:'synthetic-placeholder',
    fetch: async () => {calls++; return {ok:false,status:403,json:async()=>({message:'synthetic rejected write'}),text:async()=> 'synthetic rejected write'};},
  });
  vm.runInContext(save, dbContext, {timeout:1000});
  let dbThrew = false;
  try {await dbContext.saveToDatabase('2026-11-13','synthetic','https://synthetic.invalid/article',items);} catch (_) {dbThrew = true;}
  evidence.push({test:'actual persistence helper, synthetic HTTP 403',fetch_calls:calls,rejected:dbThrew,defect_reproduced:!dbThrew});
  let bodyReads = 0;
  const webhookContext = vm.createContext({
    N8N_WEBHOOK_URL:'https://synthetic.invalid/webhook',
    fetch: async()=>({ok:true,status:200,json:async()=>{bodyReads++;return {success:false,status:'failed'};},text:async()=>{bodyReads++;return '{"success":false}';}}),
  });
  vm.runInContext(webhook, webhookContext, {timeout:1000});
  let webhookThrew = false;
  try {await webhookContext.triggerN8nWebhook({run_date:'2026-11-13',synthetic:true});} catch (_) {webhookThrew = true;}
  evidence.push({test:'actual handoff helper, synthetic HTTP 200 with failure payload',rejected:webhookThrew,response_body_reads:bodyReads,HTTP_only_acceptance_reproduced:!webhookThrew && bodyReads===0});
  const rejectContext = vm.createContext({
    N8N_WEBHOOK_URL:'https://synthetic.invalid/webhook',
    fetch: async()=>({ok:false,status:503,text:async()=> 'synthetic unavailable'}),
  });
  vm.runInContext(webhook, rejectContext, {timeout:1000});
  let rejected = false;
  try {await rejectContext.triggerN8nWebhook({synthetic:true});} catch (_) {rejected = true;}
  evidence.push({test:'actual handoff helper, synthetic HTTP 503',correctly_rejected:rejected});
  console.log(JSON.stringify({synthetic_only:true,network_calls:0,application_imports:0,source_path:sourcePath,checks:evidence},null,2));
  if (!evidence[0].defect_reproduced || !evidence[1].HTTP_only_acceptance_reproduced || !rejected) process.exitCode=1;
}
run().catch(()=>{console.error('Synthetic diagnostic failed');process.exitCode=1;});
