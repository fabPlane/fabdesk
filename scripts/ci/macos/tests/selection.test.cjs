const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../../..');
function extract(name, start) {
  const lines = fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8').split('\n');
  const index = lines.findIndex(line => line.trim().startsWith(start));
  assert(index >= 0);
  return lines.slice(index).map(line => line.replace(/^            /, '')).join('\n');
}
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const select = new AsyncFunction('inputs', 'core', 'context', 'github', extract('select-macos-runner.yml', 'const fallback'));
const release = new AsyncFunction('core', 'context', 'github', extract('release-macos-runner.yml', 'const ref'));
const context = {repo: {owner:'company', repo:'project'}, sha:'source', runId:42, eventName:'push', payload:{}};
function mock(state = null) {
  const commits = {source:{tree:{sha:'tree'}, message:'code'}};
  let ref = null, serial = 0;
  if (state) { ref='initial'; commits.initial={tree:{sha:'tree'}, message:JSON.stringify(state)}; }
  const error = status => Object.assign(new Error('API error'), {status});
  const api = {rest:{git:{
    getRef: async () => {if (!ref) throw error(404); return {data:{object:{sha:ref}}};},
    getCommit: async ({commit_sha}) => ({data:{...commits[commit_sha],tree:{sha:commits[commit_sha].tree.sha||commits[commit_sha].tree}}}),
    createCommit: async data => {const sha='c'+(++serial); commits[sha]=data; return {data:{sha}};},
    createRef: async ({sha}) => {if(ref) throw error(422); ref=sha;},
    updateRef: async ({sha,force}) => {assert.equal(force,false); if(commits[sha].parents[0]!==ref) throw error(422); ref=sha;},
  }}, request:async () => ({data:{status:api.ownerStatus||'in_progress'}})};
  api.state=()=>ref?JSON.parse(commits[ref].message):null;
  return api;
}
function core() {return {outputs:{},setOutput(k,v){this.outputs[k]=v;},info(){},warning(){}};}
const inputs={mode:'auto',fallback:'blacksmith-6vcpu-macos-15',memory:0,ios:false};
function healthy() {process.env.MAC_RUNNER_HEARTBEAT=String(Math.floor(Date.now()/1000)); process.env.MAC_RUNNER_MEMORY_MIB='10240';process.env.MAC_RUNNER_IOS_READY='1';process.env.GITHUB_RUN_ATTEMPT='1';}
(async()=>{
  for(const value of ['0','bad',String(Math.floor(Date.now()/1000)-46),String(Math.floor(Date.now()/1000)+60)]) {
    healthy();process.env.MAC_RUNNER_HEARTBEAT=value;const api=mock(),out=core();await select(inputs,out,context,api);assert.equal(JSON.parse(out.outputs.runner),inputs.fallback);assert.equal(api.state(),null);
  }
  for(const changes of [{mode:'blacksmith'},{memory:20000}]) {
    healthy();const api=mock(),out=core();await select({...inputs,...changes},out,context,api);assert.equal(api.state(),null);
  }
  healthy();process.env.MAC_RUNNER_IOS_READY='0';{const api=mock();await select({...inputs,ios:true},core(),context,api);assert.equal(api.state(),null);}
  healthy();{const api=mock();await select(inputs,core(),{...context,eventName:'pull_request',payload:{pull_request:{head:{repo:{full_name:'fork/project'}}}}},api);assert.equal(api.state(),null);}
  healthy();const api=mock(),out=core();await select(inputs,out,context,api);assert.equal(api.state().state,'reserved');assert(Array.isArray(JSON.parse(out.outputs.runner)));
  process.env.LEASE=out.outputs.lease;await release(core(),context,api);assert.equal(api.state().state,'free');
  healthy();{const api=mock({kind:'mac-capacity-v1',state:'reserved',run:1,attempt:1});const out=core();await select(inputs,out,context,api);assert.equal(JSON.parse(out.outputs.runner),inputs.fallback);api.ownerStatus='completed';await select(inputs,out,context,api);assert.equal(api.state().run,42);}
  healthy();{const api=mock({kind:'mac-capacity-v1',state:'free'}),a=core(),b=core();await Promise.all([select(inputs,a,context,api),select(inputs,b,context,api)]);assert.equal([a,b].filter(x=>x.outputs.lease).length,1);}
  healthy();{const api=mock({kind:'mac-capacity-v1',state:'reserved',run:999,attempt:1});process.env.LEASE='initial';await assert.rejects(release(core(),context,api),/another workflow/);assert.equal(api.state().run,999);}
  console.log('Mac selector: busy/stale/fork/capability fallback, atomic contention, abandoned reservation and owner-only release passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
