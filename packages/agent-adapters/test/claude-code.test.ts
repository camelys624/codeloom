import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '@agent-workspace/contracts';
import type {
  AgentSessionHandle,
  TranscriptFrame,
} from '@agent-workspace/contracts';
import { ClaudeCodeAdapter } from '../src/claude-code.js';

// A deterministic wire peer, not a replacement for the real provider gate.
const peer = `
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\\n');
const reply = (id,result) => send({id,result});
const config = (value) => [{id:'model',name:'Model',category:'model',type:'select',currentValue:value,options:[{value:'fake',name:'Fake'}]}];
let active; let selected=false; let extensionRejected=false;
createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line);
  if (message.id==='extension-probe') { extensionRejected=message.error?.code===-32601; return; }
  switch(message.method) {
    case 'initialize':
      send({method:'_optional/status',params:{available:true}});
      reply(message.id,{protocolVersion:1,agentCapabilities:{},agentInfo:{name:'wire-test',version:'test'}}); break;
    case 'session/new':
      reply(message.id,{sessionId:'session-test',modes:{currentModeId:'default',availableModes:[{id:'default',name:'Ask'}]},configOptions:config('fake')}); break;
    case 'session/set_mode': reply(message.id,{}); break;
    case 'session/set_config_option':
      selected=message.params.configId==='model'&&message.params.value==='fake';
      send({id:'extension-probe',method:'_unsupported/request',params:{}});
      reply(message.id,{configOptions:config('fake')}); break;
    case 'session/prompt':
      if (!selected || !extensionRejected) throw new Error('Model or extension negotiation failed');
      send({method:'session/update',params:{sessionId:'session-test',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Session is alive\\n'}}}});
      if(message.params.prompt[0].text==='wait') active=message.id;
      else reply(message.id,{stopReason:'end_turn'});
      break;
    case 'session/cancel':
      if(active!==undefined) {reply(active,{stopReason:'cancelled'});active=undefined;}
      break;
  }
});
`;

describe.skipIf(process.platform !== 'linux')('ACP interoperability', () => {
  let directory: string | undefined;
  let session: AgentSessionHandle | undefined;
  afterEach(async () => {
    await session?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('negotiates config-option models, tolerates extensions and keeps the session usable after stopping a Turn', async () => {
    directory = await mkdtemp(join(tmpdir(), 'aw-acp-wire-'));
    const executable = join(directory, 'peer.mjs');
    await writeFile(executable, peer);
    const frames: TranscriptFrame[] = [];
    const waiting = Promise.withResolvers<void>();
    const adapter = new ClaudeCodeAdapter({ allowedRoots: [directory] });
    session = await adapter.startSession({
      attemptId: 'att_test',
      cwd: directory,
      launch: { kind: 'custom', command: process.execPath, args: [executable] },
      env: { PATH: process.env.PATH ?? '/usr/bin', HOME: directory },
      runConfig: {
        agentProfileId: 'agp_test',
        model: 'fake',
        permissionMode: 'ask',
        toolPolicy: {
          filesystem: 'worktree_only',
          network: 'none',
          shell: 'ask',
          gitPush: false,
        },
        idleTimeoutMinutes: 5,
        maxTurnMinutes: 1,
      },
      clock: systemClock,
      onFrame: (frame) => {
        frames.push(frame);
        if (frame.t === 'text_delta') waiting.resolve();
      },
      onPermissionRequest: async () => ({ decision: 'deny' }),
    });
    const active = session.prompt({
      turnId: 'trn_stop',
      text: 'wait',
      signal: new AbortController().signal,
    });
    await waiting.promise;
    await session.cancelTurn();
    expect((await active).stopReason).toBe('canceled');
    const next = await session.prompt({
      turnId: 'trn_next',
      text: 'continue',
      signal: new AbortController().signal,
    });
    expect(next.stopReason).toBe('end_turn');
    expect(
      frames
        .filter((frame) => frame.t === 'text_delta')
        .map((frame) => frame.text),
    ).toEqual(['Session is alive\n', 'Session is alive\n']);
  }, 15_000);
});
