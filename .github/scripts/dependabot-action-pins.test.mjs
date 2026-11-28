// OpenAI-Codex_automerge_fix: verify the complete decision path with isolated GitHub responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { changedConsumer, pinChange, reconcile } from './dependabot-action-pins.mjs';

const path = '.github/workflows/stale.yml';
const base = 'b'.repeat(40), parent = 'c'.repeat(40), head = 'd'.repeat(40);
const oldPin = '1'.repeat(40), newPin = '2'.repeat(40);
const old = '      - uses: actions/stale@' + oldPin + ' # v11.0.0\n';
const next = old.replace(oldPin, newPin).replace('11.0.0', '11.0.1');
const gitBlob = s => createHash('sha1').update('blob ' + Buffer.byteLength(s) + '\0' + s).digest('hex');
const fileTree = (content, overrides = {}) => ({ truncated: false, tree: [
  {path, mode:'100644', type:'blob', sha:gitBlob(content), ...overrides},
] });
const repoId = 1251103365;
function fixture({behind=false, failed=false, seen=false, file=path, author=49699333, publishedPin=newPin, release=true}={}) {
  const calls = [];
  const obj = data => ({data});
  const pr = {state:'open', draft:false, base:{ref:'Source_Code', repo:{id:repoId}, sha:base},
    head:{repo:{id:repoId}, ref:'dependabot/github_actions/actions/stale-11.0.1', sha:head},
    user:{id:49699333, type:'Bot', login:'dependabot[bot]'}, number:17, commits:1, changed_files:1,
    mergeable:true, mergeable_state:'clean', labels:[]};
  const before = behind ? parent : base;
  const github = {rest:{
    pulls:{get:() => obj(pr), list:'pulls'},
    issues:{listComments:'comments'},
    repos:{getCommit:() => obj({sha:head, parents:[{sha:before}], author:{id:author}, committer:{id:19864447},
      commit:{tree:{sha:head}, verification:{verified:true,reason:'valid'}}}),
      get:() => obj({id:200437066,full_name:'actions/stale',archived:false,fork:false}),
      getReleaseByTag:() => obj({draft:false,prerelease:!release,published_at:'date',tag_name:'v11.0.1'})},
    git:{getCommit:({commit_sha}) => obj({sha:commit_sha,tree:{sha:commit_sha}}),
      getRef:({ref}) => obj({object:{type:'commit',sha:ref.startsWith('tags/') ? publishedPin : base}}),
      getTree:({tree_sha}) => obj(fileTree(tree_sha===head ? next : old, {path:file})),
      getBlob:({file_sha}) => {const s=file_sha===gitBlob(old) ? old : next;
        return obj({sha:file_sha,encoding:'base64',size:s.length,content:Buffer.from(s).toString('base64')});}},
    actions:{listWorkflowRuns:({workflow_id}) => obj({total_count:1,workflow_runs:[{
      id:12,workflow_id,head_sha:head,repository:{id:repoId},head_repository:{id:repoId},event:'pull_request',
      status:'completed',conclusion:failed?'failure':'success',pull_requests:[{number:17,base:{sha:base},head:{sha:head}}]}]})}
  },paginate:route => route === 'pulls' ? [pr] : seen ? [{user:{id:359694872},body:
    '@dependabot rebase\n\n<!-- action-pin-rebase:'+head+':'+base+' -->'}] : []};
  const core={notice:()=>{},setOutput:(k,v)=>calls.push([k,v])};
  return {github,core,calls,workflowSha:base};
}
test('accept a patch pin and reject downgrade, cross-major and extra edits',()=>{
  assert.equal(pinChange(old,next,'actions/stale').commit,newPin);
  for(const s of [old,next.replace('v11.0.1','v12.0.0'),next+'# prohibited',next.replace('actions/stale','other/stale')])
    assert.equal(pinChange(old,s,'actions/stale'),null);
});
test('reject mode changes and incomplete trees',()=>{
  assert.equal(changedConsumer(fileTree(old),fileTree(next,{mode:'100755'})),null);
  assert.throws(()=>changedConsumer(fileTree(old),{...fileTree(next),truncated:true}));
});
test('select only a signed, fully checked immutable update',async()=>{
  const f=fixture(); await reconcile(f); assert.deepEqual(f.calls,[['number','17']]);
  for(const options of [{failed:true},{file:'.github/workflows/release.yml'},{author:123},{publishedPin:oldPin},{release:false}]) {
    const f=fixture(options); await reconcile(f); assert.deepEqual(f.calls,[]);
  }
});
test('request one rebase when the protected tip advances',async()=>{
  const f=fixture({behind:true});
  const comments=[];
  await reconcile({...f,app:{rest:{issues:{createComment:args=>comments.push(args)}}}});
  assert.equal(comments.length,1);
  assert.equal(comments[0].body,'@dependabot rebase\n\n<!-- action-pin-rebase:'+head+':'+base+' -->');
  const seen=fixture({behind:true,seen:true}); await reconcile(seen); assert.deepEqual(seen.calls,[]);
});
test('merge only the checked head with non-bypassable strict GitHub checks',async()=>{
  const merges=[];
  const rule=(type,parameters)=>({ruleset_id:123,ruleset_source_type:'Repository',
    ruleset_source:'KingsleyHK0323/Multimedia_Downloader',type,parameters});
  const checks={strict_required_status_checks_policy:true,required_status_checks:
    ['Required CI','Required Python matrix'].map(context=>({context,integration_id:15368}))};
  const rules=[rule('non_fast_forward'),rule('required_status_checks',checks)];
  const app={rest:{repos:{get:()=>({data:{id:repoId,full_name:'KingsleyHK0323/Multimedia_Downloader',
    fork:false,node_id:'repo'}})},pulls:{merge:args=>{merges.push(args);return {data:{merged:true}};}}},
    paginate:()=>rules,request:()=>({data:{id:123,enforcement:'active',target:'branch',
      current_user_can_bypass:'never',rules}})};
  await reconcile({...fixture(),app});
  assert.equal(merges.length,1);
  assert.equal(merges[0].sha,head);
  checks.strict_required_status_checks_policy=false;
  await assert.rejects(reconcile({...fixture(),app}),/current base/);
  assert.equal(merges.length,1);
});
