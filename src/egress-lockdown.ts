/**
 * Egress lockdown — force ALL agent traffic through the OneCLI gateway.
 * Agents run on a Docker `--internal` network (no internet route) with the
 * gateway attached as host.docker.internal, so the injected proxy is the only
 * reachable hop. Non-root, no NET_ADMIN — the agent can't undo it.
 *
 * Fail-fast: when the flag is on but the network/gateway can't be set up, throw
 * rather than silently spawn an agent with open egress.
 */
import { execFileSync } from 'child_process';

import { CONTAINER_IMAGE, EGRESS_LOCKDOWN, EGRESS_NETWORK, ONECLI_GATEWAY_CONTAINER } from './config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs } from './container-runtime.js';
import { log } from './log.js';

// Perimeter knobs (locked-down network, gateway container, on/off flag) are read
// via config.ts so they honor .env under the shipped service, not just process.env.
export { EGRESS_NETWORK };
export const LOCAL_MODEL_BRIDGE_CONTAINER = 'nanoclaw-local-model-bridge';
export const LOCAL_MODEL_BRIDGE_ALIAS = 'local-model.bridge';
const LOCAL_MODEL_BRIDGE_SCRIPT = String.raw`
const http=require('http');
const allowed=new Set(['google/gemma-4-12b-qat','qwen/qwen3.6-27b']);
const upstream={hostname:'host.docker.internal',port:1234};
http.createServer((req,res)=>{
  if(req.method==='GET'&&req.url==='/v1/models') return http.get({...upstream,path:'/v1/models'},r=>{let data='';r.on('data',c=>data+=c);r.on('end',()=>{try{const p=JSON.parse(data);p.data=Array.isArray(p.data)?p.data.filter(m=>allowed.has(m.id)):[];res.writeHead(r.statusCode||502,{'content-type':'application/json'}).end(JSON.stringify(p))}catch{res.writeHead(502).end()}})}).on('error',()=>res.writeHead(502).end());
  if(req.method!=='POST'||req.url!=='/v1/chat/completions') return res.writeHead(403).end('fixed local-model bridge');
  let body='';req.on('data',c=>{body+=c;if(body.length>1048576)req.destroy()});req.on('end',()=>{let p;try{p=JSON.parse(body)}catch{return res.writeHead(400).end('invalid json')};if(!allowed.has(p.model))return res.writeHead(403).end('model denied');const u=http.request({...upstream,path:'/v1/chat/completions',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},r=>{res.writeHead(r.statusCode||502,r.headers);r.pipe(res)});u.on('error',()=>res.writeHead(502).end());u.end(body)})
}).listen(1234,'0.0.0.0');`;

/** Raised when lockdown is requested but can't be established. */
export class EgressLockdownError extends Error {
  constructor(reason: string) {
    super(
      `Egress lockdown is on (NANOCLAW_EGRESS_LOCKDOWN=true) but ${reason}. ` +
        `Refusing to spawn with open egress. Start the OneCLI gateway container ` +
        `"${ONECLI_GATEWAY_CONTAINER}", or set NANOCLAW_EGRESS_LOCKDOWN=false to opt out.`,
    );
    this.name = 'EgressLockdownError';
  }
}

function dockerOk(args: string[]): boolean {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** Is the OneCLI gateway currently attached to the egress network? */
function gatewayAttached(): boolean {
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['network', 'inspect', EGRESS_NETWORK, '--format', '{{range .Containers}}{{.Name}} {{end}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 15000 },
    );
    return out.split(/\s+/).includes(ONECLI_GATEWAY_CONTAINER);
  } catch {
    return false;
  }
}

function containerAttached(container: string): boolean {
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['network', 'inspect', EGRESS_NETWORK, '--format', '{{range .Containers}}{{.Name}} {{end}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 15000 },
    );
    return out.split(/\s+/).includes(container);
  } catch {
    return false;
  }
}

function bridgeOwned(): boolean {
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      [
        'container',
        'inspect',
        '--format',
        '{{index .Config.Labels "nanoclaw.local-model-bridge"}}',
        LOCAL_MODEL_BRIDGE_CONTAINER,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 15000 },
    );
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Starts the fixed local-model sidecar and connects it to the isolated agent
 * network. The sidecar has no mounts, credentials, or configurable upstream;
 * its only upstream is LM Studio on the host and its only allowed API surface
 * is models plus completions for the checked-in model allowlist.
 */
export function ensureLocalModelBridge(): void {
  // Local-model agents always use the internal network, even if general egress
  // lockdown is disabled, so their inference path remains isolated.
  if (
    !dockerOk(['network', 'inspect', EGRESS_NETWORK]) &&
    !dockerOk(['network', 'create', '--internal', EGRESS_NETWORK])
  )
    throw new EgressLockdownError(
      `the "${EGRESS_NETWORK}" internal network could not be created for the local-model bridge`,
    );
  const bridgeExists = dockerOk(['container', 'inspect', LOCAL_MODEL_BRIDGE_CONTAINER]);
  if (bridgeExists && !bridgeOwned()) {
    throw new EgressLockdownError(
      `the existing "${LOCAL_MODEL_BRIDGE_CONTAINER}" container is not the NanoClaw fixed local-model bridge`,
    );
  }
  if (!bridgeExists) {
    const args = [
      'run',
      '--detach',
      '--rm',
      '--name',
      LOCAL_MODEL_BRIDGE_CONTAINER,
      '--network',
      'bridge',
      '--label',
      'nanoclaw.local-model-bridge=true',
      ...hostGatewayArgs(),
      '--entrypoint',
      'node',
      CONTAINER_IMAGE,
      '-e',
      LOCAL_MODEL_BRIDGE_SCRIPT,
    ];
    if (!dockerOk(args)) throw new EgressLockdownError('the fixed local-model bridge could not be started');
  }
  if (!containerAttached(LOCAL_MODEL_BRIDGE_CONTAINER)) {
    if (
      !dockerOk([
        'network',
        'connect',
        '--alias',
        LOCAL_MODEL_BRIDGE_ALIAS,
        EGRESS_NETWORK,
        LOCAL_MODEL_BRIDGE_CONTAINER,
      ])
    )
      throw new EgressLockdownError('the fixed local-model bridge could not be connected to the isolated network');
  }
}

/**
 * Exercise the fixed bridge from an ephemeral container on the same internal
 * network as an agent. This is intentionally a host operation: neither the
 * endpoint nor the probe command is exposed in an agent contract.
 */
export function verifyLocalModelBridge(model: string): boolean {
  const script = String.raw`const base='http://${LOCAL_MODEL_BRIDGE_ALIAS}:1234/v1';const model=${JSON.stringify(model)};const ac=new AbortController();setTimeout(()=>ac.abort(),5000);(async()=>{const m=await fetch(base+'/models',{signal:ac.signal});const j=await m.json();if(!m.ok||!Array.isArray(j.data)||!j.data.some(x=>x&&x.id===model))throw Error('inventory');const r=await fetch(base+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'Reply exactly OK.'}],max_tokens:4,stream:false}),signal:ac.signal});const b=await r.json();if(!r.ok||!Array.isArray(b.choices)||b.choices.length===0)throw Error('completion')})().then(()=>process.exit(0)).catch(()=>process.exit(1));`;
  return dockerOk(['run', '--rm', '--network', EGRESS_NETWORK, '--entrypoint', 'node', CONTAINER_IMAGE, '-e', script]);
}

/**
 * Ensure the egress network exists with the OneCLI gateway attached (aliased
 * host.docker.internal). Idempotent + self-healing. Returns false when lockdown
 * is disabled (caller uses the host gateway), true when it's active. Throws
 * EgressLockdownError when enabled but unestablishable — fail fast rather than
 * spawn an agent with open egress.
 */
export function ensureEgressNetwork(): boolean {
  if (!EGRESS_LOCKDOWN) return false;

  if (
    !dockerOk(['network', 'inspect', EGRESS_NETWORK]) &&
    !dockerOk(['network', 'create', '--internal', EGRESS_NETWORK])
  ) {
    throw new EgressLockdownError(`the "${EGRESS_NETWORK}" internal network could not be created`);
  }

  if (gatewayAttached()) return true;

  if (
    dockerOk(['network', 'connect', '--alias', 'host.docker.internal', EGRESS_NETWORK, ONECLI_GATEWAY_CONTAINER]) &&
    gatewayAttached()
  ) {
    log.info('Egress lockdown: OneCLI gateway attached', {
      network: EGRESS_NETWORK,
      gateway: ONECLI_GATEWAY_CONTAINER,
    });
    return true;
  }

  throw new EgressLockdownError(
    `the OneCLI gateway "${ONECLI_GATEWAY_CONTAINER}" could not be attached to "${EGRESS_NETWORK}"`,
  );
}

/** CLI args placing a container on the locked-down egress network. */
export function egressNetworkArgs(): string[] {
  return ['--network', EGRESS_NETWORK];
}
