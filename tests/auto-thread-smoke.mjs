import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
let clock=100000;
class FakeDate extends Date {static now(){return clock;}}
const source=readFileSync(new URL('../extension/src/content/threads-engine.js',import.meta.url),'utf8')
 .replace('window.DST.engine = {', 'generateAcceptable = async () => { window.generations++; return "Готовый ответ для выбранной ветки."; };\n window.DST.engine = { pass, maybeRotate,');
const post={code:'XYZ',author:'target',text:'Достаточно длинный текст поста для проверки авторежима',permalink:'https://www.threads.com/@target/post/XYZ'};
const settings={source:{feed:true,search:true,rotateEveryMin:12},sel:{},commentSleepSec:1};
const state={running:true,mode:'auto',src:'search',queries:['запрос'],qi:0,rotatedAt:0};
const calls=[];let assignments=[];let visible=[post];let sends=0;let comments=[];
function load(path) {
 const ctx={Date:FakeDate,console,Math,Promise,Map,Set,Array,Object,String,Number,JSON,
  setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},
  CustomEvent:class {},dispatchEvent(){},addEventListener(){},document:{readyState:'loading'},
  location:{pathname:path,search:'',href:'https://www.threads.com'+path,assign(url){assignments.push(url);}},
  chrome:{runtime:{sendMessage(msg,cb){calls.push(msg);if(msg.type==='ENGINE_SET')Object.assign(state,msg.patch);
   cb(msg.type==='CLAIM_POST'?{ok:true,claimed:true}:msg.type==='SAFE_GAP'?{ok:true,sec:1}:{ok:true});}},
   storage:{local:{async get(){return {_engine:state,_replyWatch:[]};},async set(){}}}},
  DST:{dom:{parseVisiblePosts:()=>visible,rnd:()=>1,async sleep(ms){clock+=ms;},
   async commentOnPost(code,text){sends++;comments.push({code,text});return {ok:true,sent:true,confirmed:'text-visible'};}},
   aim:{},find:{where:()=>path.includes('/post/')?'post':'search',goSearch(){if(!sends) throw Error('premature search rotation'); assignments.push('search');return true;},goFeed(){assignments.push('feed');return true;}}},generations:0};
 ctx.window=ctx;vm.createContext(ctx);vm.runInContext(source,ctx);return ctx;
}
const first=load('/search');
assert.equal(await first.DST.engine.pass(state,settings),'navigating');
assert.equal(sends,0);assert.equal(first.generations,1);assert.equal(state.retry,'XYZ');
assert.equal(state.activeReply.text,'Готовый ответ для выбранной ветки.');
assert.deepEqual(assignments,[post.permalink]);
console.log('✓ авто открывает ветку до отправки и сохраняет текст');
assignments=[];
assert.equal(await first.DST.engine.maybeRotate(state,settings),true);
assert.deepEqual(assignments,[post.permalink]);
console.log('✓ незавершённый ответ восстанавливает нужную ветку при уходе со страницы');
visible=[];assignments=[];
const resumed=load('/@target/post/XYZ');
assert.equal(await resumed.DST.engine.maybeRotate(state,settings),false);
assert.deepEqual(assignments,[]);
console.log('✓ после перезагрузки незавершённая ветка не уходит в поиск');
await resumed.DST.engine.pass({...state},settings);
assert.equal(sends,1);assert.equal(resumed.generations,0);
assert.deepEqual(comments,[{code:'XYZ',text:'Готовый ответ для выбранной ветки.'}]);
assert.equal(state.activeReply,null);assert.equal(state.retry,'');
assert.equal(calls.filter(c=>c.type==='COMMIT_POST').length,1);
assert.deepEqual(assignments,['search']);
console.log('✓ авто отправляет сохранённый ответ без видимой карточки и повторной генерации');
