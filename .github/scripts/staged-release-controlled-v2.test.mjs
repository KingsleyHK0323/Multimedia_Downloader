// OpenAI-Codex_bridge_fix: injected mock tests, no real network or workflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runControlledRelease } from './staged-release-controlled-v2.mjs';

const expected = { tag:'v4.3.21', commitSha:'a'.repeat(40), runId:12, attempt:1 };
const names = ['Multimedia.Downloader-4.3.21-1.x86_64.rpm','Multimedia.Downloader_4.3.21_aarch64.dmg','Multimedia.Downloader_4.3.21_amd64.AppImage','Multimedia.Downloader_4.3.21_amd64.deb','Multimedia.Downloader_4.3.21_x64-setup.exe','Multimedia.Downloader_4.3.21_x64_en-US.msi'];
function fixture() {
  const bytes = new Uint8Array([1]); const digest = createHash('sha256').update(bytes).digest('hex');
  const events = [], uploaded = [];
  const release = {
    getReleaseByTag:async()=>({status:404}),
    createDraft:async()=>{ events.push('draft'); return {id:7,draft:true,tag_name:expected.tag}; },
    uploadAsset:async(id,name,data)=>{ events.push('upload'); uploaded.push({id:uploaded.length+1,name,size:data.length,state:'uploaded'}); },
    listAssets:async()=>({status:200,data:uploaded}), downloadAsset:async()=>bytes,
    getRelease:async()=>({status:200,data:{id:7,draft:true,tag_name:expected.tag}}),
    publishDraft:async()=>{ events.push('publish'); return {id:7,draft:false,tag_name:expected.tag}; },
  };
  const evidence = {
    verifySafety:async()=>({draftVisibility:true,releaseInventoryTrusted:true,tagProtected:true,actorNonBypass:true,buildTrusted:true}),
    verifyAccess:async()=>true, resolveTag:async()=>expected.commitSha, listVisibleReleases:async()=>({status:200,data:[]}),
    validateBuild:async()=>({verified:true,assets:names.map(name=>({...expected,name,size:1,sha256:digest}))}),
  };
  return { release,evidence,store:{readBytes:async()=>bytes},expected,assets:names.map(name=>({name})),title:'title',notes:'notes',events };
}

test('default deny and no exported bridge writes', async()=>{
  const x=fixture();const result=await runControlledRelease(x);
  assert.equal(result.ok,false);assert.deepEqual(x.events,[]);
  const exports=await import('./staged-release-controlled-v2.mjs');assert.deepEqual(Object.keys(exports),['runControlledRelease']);
});

test('explicit mock follows complete build and draft order',async()=>{
  const x=fixture();const result=await runControlledRelease({...x,enableWrites:true});
  assert.equal(result.ok,true);assert.deepEqual(x.events,['draft',...Array(6).fill('upload'),'publish']);
});

test('every precondition failure stops before writes',async()=>{
  for(const key of ['draftVisibility','releaseInventoryTrusted','tagProtected','actorNonBypass','buildTrusted']) {
    const x=fixture();x.evidence.verifySafety=async()=>({draftVisibility:true,releaseInventoryTrusted:true,tagProtected:true,actorNonBypass:true,buildTrusted:true,[key]:false});
    assert.equal((await runControlledRelease({...x,enableWrites:true})).ok,false,key);assert.deepEqual(x.events,[]);
  }
  for(const lookup of [403,200]) {const x=fixture();x.release.getReleaseByTag=async()=>({status:lookup});assert.equal((await runControlledRelease({...x,enableWrites:true})).ok,false);assert.deepEqual(x.events,[]);}
  const x=fixture();x.evidence.listVisibleReleases=async()=>({status:200,data:[{tag_name:expected.tag}]});
  assert.equal((await runControlledRelease({...x,enableWrites:true})).ok,false);assert.deepEqual(x.events,[]);
});

test('incomplete and dynamic release pages fail closed',async()=>{
  const x=fixture();let reads=0,pages=[];
  x.evidence.listVisibleReleases=async page=>{ pages.push(page);return {status:200,get data(){reads++;return page===1?Array.from({length:100},(_,i)=>({tag_name:'v0.0.'+i})):[];}};};
  assert.equal((await runControlledRelease({...x,enableWrites:true})).ok,true);assert.equal(reads,2);assert.deepEqual(pages,[1,2]);
  const y=fixture();y.evidence.listVisibleReleases=async()=>({status:403,data:[]});assert.equal((await runControlledRelease({...y,enableWrites:true})).ok,false);assert.deepEqual(y.events,[]);
});

test('public draft cannot lead to upload or publish',async()=>{
  const x=fixture();x.release.createDraft=async()=>{x.events.push('draft');return {id:7,draft:false,tag_name:expected.tag};};
  const r=await runControlledRelease({...x,enableWrites:true});assert.equal(r.ok,false);assert.deepEqual(x.events,['draft']);assert.equal(r.draftId,7);assert.equal(r.sideEffectUncertain,true);
});

test('later page mutation cannot rewrite earlier asset snapshot',async()=>{
  const x=fixture();let original;const sizes=[];
  x.release.listAssets=async(id,page)=>{
    if(page===1){ original={id:1,name:names[0],size:1,state:'uploaded'}; return {status:200,data:Array.from({length:100},(_,i)=>i===0?original:{id:i+2,name:'other'+i,size:1,state:'uploaded'})}; }
    original.size=999;return {status:200,data:[]};
  };
  x.release.downloadAsset=async(id)=>{sizes.push(id);return new Uint8Array([1]);};
  const result=await runControlledRelease({...x,enableWrites:true});assert.equal(result.ok,false);assert.equal(x.events.includes('publish'),false);
});

test('prior page fields are observed only once before next page is read',async()=>{
  const x=fixture();let reads=0, changed=false;
  x.release.listAssets=async(id,page)=>{
    if(page===1) return {status:200,data:Array.from({length:100},(_,i)=> i===0 ?
      {id:1,get name(){reads++;return changed?'mutated':names[0];},size:1,state:'uploaded'} :
      {id:i+2,name:'other'+i,size:1,state:'uploaded'})};
    changed=true;return {status:200,data:[]};
  };
  const result=await runControlledRelease({...x,enableWrites:true});
  assert.equal(result.ok,false);assert.equal(reads,1);assert.equal(x.events.includes('publish'),false);
});

test('mutable release page length cannot hide existing tag',async()=>{
  const x=fixture();let reads=0;
  const entries=Array.from({length:100},(_,i)=>({tag_name:i===99?expected.tag:'v0.0.'+i}));
  x.evidence.listVisibleReleases=async()=>({status:200,data:new Proxy(entries,{get(target,key,receiver){if(key==='length')return ++reads===1?100:0;return Reflect.get(target,key,receiver);}})});
  const result=await runControlledRelease({...x,enableWrites:true});assert.equal(result.ok,false);assert.equal(reads,1);assert.deepEqual(x.events,[]);
});

test('mutable asset page length cannot hide extra assets',async()=>{
  const x=fixture();let reads=0;
  x.release.listAssets=async(id,page)=>{
    if(page>1)return {status:200,data:[]};
    const entries=Array.from({length:100},(_,i)=>({id:i+1,name:names[i%6],size:1,state:'uploaded'}));
    return {status:200,data:new Proxy(entries,{get(target,key,receiver){if(key==='length')return ++reads===1?100:6;return Reflect.get(target,key,receiver);}})};
  };
  const result=await runControlledRelease({...x,enableWrites:true});assert.equal(result.ok,false);assert.equal(reads,1);assert.equal(x.events.includes('publish'),false);
});

